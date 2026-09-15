import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { runProject, type RunResult } from "../execution/pipeline.js";
import { requireProjectAccess, workspacePath } from "../projects/service.js";
import type { SandboxController } from "../execution/sandbox.js";
import { runGate } from "../execution/runGate.js";
import { telemetryHistorian } from "../execution/historian.js";
import {
  collaborationManager,
  describeUnpersistedLiveEdits,
} from "../collab/manager.js";
import {
  resolveSecretsForInjection,
  toGenericSecretError,
} from "../projectsecrets/store.js";
import { debugSessions } from "../debug/manager.js";
import { parseWorkflowRequest } from "../workflow/resolve.js";
import { runWorkflowTask } from "../workflow/run.js";
import type { TestCaseResult } from "../workflow/parse.js";

// --- M54: collaborative run awareness — safe metadata derivation ------------
//
// The run-status broadcast is driven entirely from this authenticated
// execution socket. The client's start message contributes only two hint
// fields (active file, language) which are validated here before use; every
// other field (identity, executionId, timestamps, state, exitCode) is
// server-owned. Nothing sensitive (stdout/stderr/env/secrets/command/absolute
// paths) is ever passed to the collaboration room.

/** Workspace-relative path hint or null. Rejects absolute / traversal / oversized. */
export function sanitizeRunFile(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 260) return null;
  const n = v.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  if (n.split("/").some((s) => s === "..")) return null;
  return n;
}

/** Bounded language identifier or null. */
export function sanitizeRunLanguage(v: unknown): string | null {
  if (typeof v !== "string" || !/^[a-z0-9+#._-]{1,32}$/i.test(v)) return null;
  return v;
}

/** Maps the authoritative run outcome to a collaborator-visible state. */
export function deriveRunState(o: {
  threw: boolean;
  disconnected: boolean;
  stopRequested: boolean;
  result?: RunResult;
}): "success" | "failed" | "stopped" {
  if (o.stopRequested || o.disconnected) return "stopped";
  if (o.threw || !o.result) return "failed";
  const r = o.result;
  if (r.timedOut || r.oom) return "failed";
  if (r.type !== "success") return "failed";
  if (r.exitCode === 0) return "success";
  if (r.exitCode === null) return "stopped";
  return "failed";
}

export async function handleExecutionConnection(
  ws: WebSocket,
  projectId: string,
  userId: number,
  username: string,
  cfg: AppConfig,
  db?: Db,
): Promise<void> {
  let cwd: string;
  try {
    cwd = await workspacePath(cfg, projectId);
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "error",
          data: `Workspace not found: ${err.message}`,
        }),
      );
      ws.close();
    }
    return;
  }

  let controller: SandboxController | null = null;
  let running = false;
  let activeCleanup: (() => void) | null = null;
  // M54: set when the client explicitly requests a stop, so the terminal
  // run-status is reported as "stopped" rather than "failed".
  let stopRequested = false;
  // Latched on ws close: `controller` is only set once the sandboxed process
  // actually exists, so a disconnect during container startup has nothing to
  // kill. sandboxRun polls this before spawning anything.
  let disconnected = false;

  ws.on("message", async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.type === "start") {
        // M86: editor access is checked at upgrade, but a start can arrive
        // long after (and now also persists the room). Re-check per start so
        // a collaborator demoted or removed on an open socket cannot run.
        if (db) {
          try {
            requireProjectAccess(db, userId, projectId, "editor");
          } catch {
            ws.send(
              JSON.stringify({
                type: "error",
                data: "You no longer have permission to run code in this project.",
              }),
            );
            return;
          }
        }
        if (running) {
          ws.send(
            JSON.stringify({
              type: "error",
              data: "Execution already running",
            }),
          );
          return;
        }
        if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
          ws.send(
            JSON.stringify({
              type: "error",
              data: "Concurrent execution limit reached",
            }),
          );
          return;
        }
        running = true;
        const executionId = randomUUID();
        telemetryHistorian.trackExecutionStart(projectId, executionId);

        // M54: publish "running" to the project's collaboration room using
        // only server-owned identity + a validated file/language hint.
        const startedAt = Date.now();
        const runFileHint = sanitizeRunFile(parsed.activeFile);
        const runLangHint = sanitizeRunLanguage(parsed.language);
        collaborationManager.notifyRunStatus(projectId, {
          executionId,
          userId,
          username,
          state: "running",
          file: runFileHint,
          language: runLangHint,
          startedAt,
          endedAt: null,
          exitCode: null,
        });

        let terminalPublished = false;
        const publishTerminal = (
          result: RunResult | undefined,
          threw: boolean,
        ) => {
          if (terminalPublished) return;
          terminalPublished = true;
          const state = deriveRunState({
            threw,
            disconnected,
            stopRequested,
            result,
          });
          collaborationManager.notifyRunStatus(projectId, {
            executionId,
            userId,
            username,
            state,
            file: result?.mainFile ?? runFileHint,
            language: result?.language ?? runLangHint,
            startedAt,
            endedAt: Date.now(),
            exitCode: result?.exitCode ?? null,
          });
        };

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          telemetryHistorian.trackExecutionEnd(projectId, executionId);
          runGate.release(userId);
          running = false;
          controller = null;
          activeCleanup = null;
        };
        activeCleanup = finish;

        let result: RunResult | undefined;
        let workflowTests: TestCaseResult[] | undefined;
        try {
          const streamOut = (channel: "stdout" | "stderr", data: string) => {
            if (ws.readyState === ws.OPEN)
              ws.send(JSON.stringify({ type: channel, data }));
            collaborationManager.notifyRunOutput(
              projectId,
              executionId,
              channel,
              data,
            );
          };
          const streamStatus = (data: string) => {
            if (ws.readyState === ws.OPEN)
              ws.send(JSON.stringify({ type: "status", data }));
          };

          const workflowReq =
            parsed.workflow !== undefined && parsed.workflow !== null
              ? parseWorkflowRequest(parsed.workflow)
              : null;
          if (workflowReq && !workflowReq.ok) {
            throw new Error(workflowReq.error);
          }
          if (workflowReq?.ok && debugSessions.hasLiveForProject(projectId)) {
            throw new Error(
              "Debugger is active; stop it before running tests or builds.",
            );
          }

          // M86: the sandbox reads the workspace from disk, which lags the
          // collaboration room by the persistence debounce. Land every edit
          // the room already holds first; refuse rather than run stale code.
          const persisted =
            await collaborationManager.persistLiveEdits(projectId);
          if (!persisted.ok) {
            throw new Error(
              `${describeUnpersistedLiveEdits(persisted.unpersisted)}; not started so stale code is not run.`,
            );
          }

          if (workflowReq?.ok) {
            const wf = await runWorkflowTask({
              cfg,
              projectId,
              workspaceDir: cwd,
              userId,
              taskId: workflowReq.taskId,
              targetPath: workflowReq.targetPath,
              onStdout: (data) => streamOut("stdout", data),
              onStderr: (data) => streamOut("stderr", data),
              onStatus: streamStatus,
              onController: (ctrl) => {
                controller = ctrl;
              },
              isCancelled: () => disconnected,
            });
            if (!wf.ok) throw new Error(wf.error);
            result = wf.value.result;
            workflowTests = wf.value.tests;
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "workflow",
                  taskId: wf.value.taskId,
                  kind: wf.value.kind,
                  tests: wf.value.tests,
                }),
              );
            }
          } else {
            let secretEnv: Record<string, string> | undefined;
            if (db) {
              try {
                const resolved = resolveSecretsForInjection(db, cfg, projectId, {
                  userId,
                  context: "run",
                });
                if (Object.keys(resolved).length > 0) secretEnv = resolved;
              } catch (err) {
                throw toGenericSecretError(err);
              }
            }
            result = await runProject(cfg, projectId, cwd, {
              language: parsed.language,
              activeFile: parsed.activeFile,
              userId,
              secretEnv,
              onStdout: (data) => streamOut("stdout", data),
              onStderr: (data) => streamOut("stderr", data),
              onStatus: streamStatus,
              onController: (ctrl) => {
                controller = ctrl;
              },
              isCancelled: () => disconnected,
            });
          }

          const execSummary = telemetryHistorian.queryExecutionTelemetry(
            projectId,
            executionId,
          ).summary;

          // The run phase always reports `type: 'success'` regardless of how the
          // process actually ended, and a SIGKILL'd child reports
          // `exitCode: null`. Persisting `exitCode ?? 0` would file an
          // explicitly stopped (or timed-out, or disconnected) run in history as
          // a clean `success`/`0`, indistinguishable from a real completion.
          let historyStatus: string = result.type;
          let historyExitCode: number | null =
            result.exitCode ?? (result.type === "success" ? 0 : 1);

          if (disconnected) {
            historyStatus = "cancelled";
            historyExitCode = null;
          } else if (result.type === "success" && result.exitCode === null) {
            historyStatus = result.timedOut ? "timeout" : "killed";
            historyExitCode = null;
          }

          // Record run into SQLite execution history
          if (db) {
            try {
              db.prepare(
                `
                INSERT INTO runs (id, project_id, user_id, language, file_path, status, exit_code, signal, duration_ms, peak_memory_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              ).run(
                executionId,
                projectId,
                userId,
                result.language ?? "unknown",
                result.mainFile ?? (parsed.activeFile || "unknown"),
                historyStatus,
                historyExitCode,
                result.signal ?? null,
                result.durationMs,
                execSummary.peakMemoryBytes || 0,
              );
            } catch (dbErr) {
              console.error("[execution] failed to record run history:", dbErr);
            }
          }

          if (ws.readyState === ws.OPEN) {
            if (result.type !== "success" && result.stderr) {
              ws.send(JSON.stringify({ type: "stderr", data: result.stderr }));
            }
            ws.send(
              JSON.stringify({
                type: "exit",
                executionId,
                result,
                telemetrySummary: execSummary,
                tests: workflowTests,
              }),
            );
          }
          // M54: authoritative terminal run status from the real outcome.
          publishTerminal(result, false);
        } catch (err) {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: "error",
                data: err instanceof Error ? err.message : String(err),
              }),
            );
          }
          publishTerminal(result, true);
        } finally {
          finish();
        }
      } else if (parsed.type === "stdin") {
        if (controller) {
          controller.writeStdin(parsed.data);
        }
      } else if (parsed.type === "stop") {
        stopRequested = true;
        if (controller) {
          controller.kill();
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    disconnected = true;
    if (controller) {
      controller.kill();
    }
    if (activeCleanup) {
      activeCleanup();
    }
  });
}
