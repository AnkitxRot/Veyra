import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { runProject, RunResult } from "../execution/pipeline.js";
import { runGate } from "../execution/runGate.js";
import { workspacePath } from "../projects/service.js";

export type AIVerificationStatus = "VERIFIED" | "FAILED" | "UNVERIFIED";

export interface VerificationRequest {
  projectId: string;
  userId: number;
  action: string;
  providerType: string;
  modelName: string;
  filePath: string;
  explanation: string;
  diffSummary?: string;
  snapshotId?: string;
  skipVerification?: boolean;
}

export interface VerificationResult {
  id: string;
  status: AIVerificationStatus;
  executionId?: string;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  skipReason?: string;
  durationMs: number;
  createdAt: string;
}

/**
 * Executes authoritative verification through the sandbox pipeline
 * and records outcome into the ai_verifications journal.
 */
export async function runAIVerification(
  cfg: AppConfig,
  db: Db,
  req: VerificationRequest,
): Promise<VerificationResult> {
  const verificationId = randomUUID();
  const t0 = performance.now();

  // 1. Explicit Skip Verification Path
  if (req.skipVerification) {
    const skipReason = "Verification skipped by user.";
    db.prepare(
      `INSERT INTO ai_verifications (
        id, project_id, user_id, action, provider_type, model_name,
        status, file_path, explanation, diff_summary, snapshot_id,
        skip_reason, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      verificationId,
      req.projectId,
      req.userId,
      req.action,
      req.providerType,
      req.modelName,
      "UNVERIFIED",
      req.filePath,
      req.explanation,
      req.diffSummary || "",
      req.snapshotId || null,
      skipReason,
      0,
    );

    return {
      id: verificationId,
      status: "UNVERIFIED",
      exitCode: null,
      stdoutSummary: "",
      stderrSummary: "",
      skipReason,
      durationMs: 0,
      createdAt: new Date().toISOString(),
    };
  }

  // 2. Authoritative Sandbox Verification Run
  let runResult: RunResult | null = null;
  let status: AIVerificationStatus = "UNVERIFIED";
  let skipReason: string | undefined = undefined;

  // This endpoint spawns a real sandbox execution, so it must consume the same
  // per-user budget as the REST run, WebSocket execute and install paths.
  // Without it, a client looping this route could launch unbounded concurrent
  // `docker exec` processes and bypass `maxConcurrentRuns` entirely.
  const gateAcquired = runGate.acquire(req.userId, cfg.maxConcurrentRuns);

  if (!gateAcquired) {
    // Degrade gracefully like `missing_toolchain`: the patch simply goes
    // unverified and is journalled as such, rather than failing the request.
    status = "UNVERIFIED";
    skipReason =
      "Verification skipped: too many concurrent executions for this user";
  } else {
    try {
      const cwd = await workspacePath(cfg, req.projectId);
      runResult = await runProject(cfg, req.projectId, cwd, {
        activeFile: req.filePath,
      });

      if (
        runResult.type === "missing_toolchain" ||
        runResult.type === "not_runnable" ||
        runResult.type === "no_language"
      ) {
        status = "UNVERIFIED";
        skipReason = `Execution skipped: ${runResult.type.replace(/_/g, " ")}`;
      } else if (
        runResult.type === "compile_error" ||
        (runResult.exitCode !== null && runResult.exitCode !== 0)
      ) {
        status = "FAILED";
      } else if (runResult.exitCode === 0) {
        status = "VERIFIED";
      } else {
        status = "UNVERIFIED";
      }
    } catch (err: any) {
      status = "FAILED";
      skipReason = err.message || "Execution error";
    } finally {
      // Always hand the slot back, whether the run succeeded, returned a
      // non-success outcome, or threw.
      runGate.release(req.userId);
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  const stdoutSummary = runResult?.stdout
    ? runResult.stdout.slice(0, 1000)
    : "";
  const stderrSummary = runResult?.stderr
    ? runResult.stderr.slice(0, 1500)
    : skipReason || "";
  const exitCode = runResult?.exitCode ?? null;

  // 3. Record in ai_verifications Journal Table
  db.prepare(
    `INSERT INTO ai_verifications (
      id, project_id, user_id, action, provider_type, model_name,
      status, file_path, explanation, diff_summary, snapshot_id,
      exit_code, stdout_summary, stderr_summary, skip_reason, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    req.projectId,
    req.userId,
    req.action,
    req.providerType,
    req.modelName,
    status,
    req.filePath,
    req.explanation,
    req.diffSummary || "",
    req.snapshotId || null,
    exitCode,
    stdoutSummary,
    stderrSummary,
    skipReason || null,
    durationMs,
  );

  return {
    id: verificationId,
    status,
    exitCode,
    stdoutSummary,
    stderrSummary,
    skipReason,
    durationMs,
    createdAt: new Date().toISOString(),
  };
}
