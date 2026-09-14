import type { AppConfig } from "../config.js";
import { sandboxRun, type SandboxController } from "../execution/sandbox.js";
import type { RunResult } from "../execution/pipeline.js";
import { parseTestOutput, type TestCaseResult } from "./parse.js";
import { resolveWorkflowTask, type ResolvedWorkflow } from "./resolve.js";

const MAX_CAPTURE = 64 * 1024;

export interface WorkflowRunResult {
  taskId: string;
  kind: ResolvedWorkflow["kind"];
  command: string;
  args: string[];
  result: RunResult;
  tests: TestCaseResult[];
}

export async function runWorkflowTask(opts: {
  cfg: AppConfig;
  projectId: string;
  workspaceDir: string;
  userId: number;
  taskId: unknown;
  targetPath?: unknown;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onStatus?: (data: string) => void;
  onController?: (ctrl: SandboxController) => void;
  isCancelled?: () => boolean;
}): Promise<
  { ok: true; value: WorkflowRunResult } | { ok: false; error: string }
> {
  const resolved = await resolveWorkflowTask(
    opts.workspaceDir,
    opts.taskId,
    opts.targetPath,
  );
  if (!resolved.ok) return resolved;

  const spec = resolved.value;
  opts.onStatus?.(
    spec.kind === "test"
      ? `Running tests (${spec.task.name})…`
      : `Running build (${spec.task.name})…`,
  );

  const sandbox = await sandboxRun(opts.projectId, opts.workspaceDir, {
    command: spec.command,
    args: spec.args,
    cwd: opts.workspaceDir,
    timeoutMs: opts.cfg.buildTimeoutMs,
    kind: "build",
    config: opts.cfg,
    userId: opts.userId,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
    onController: opts.onController,
    isCancelled: opts.isCancelled,
  });

  const combined = `${sandbox.stdout}\n${sandbox.stderr}`.slice(0, MAX_CAPTURE);
  let tests: TestCaseResult[] = [];
  if (spec.kind === "test") {
    try {
      tests = parseTestOutput(combined);
    } catch {
      tests = [];
    }
  }
  if (spec.kind === "test" && tests.length === 0) {
    tests = [
      {
        name: spec.task.name,
        status:
          sandbox.exitCode === 0 && !sandbox.timedOut && !sandbox.oom
            ? "passed"
            : sandbox.timedOut
              ? "error"
              : "failed",
        message:
          sandbox.exitCode === 0
            ? undefined
            : (sandbox.stderr || sandbox.stdout).slice(0, 800) ||
              (sandbox.timedOut ? "timed out" : "test task failed"),
      },
    ];
  }

  const result: RunResult = {
    type: sandbox.exitCode === 0 && !sandbox.timedOut && !sandbox.oom
      ? "success"
      : "compile_error",
    language: spec.task.origin === "pytest" ? "python" : "node",
    mainFile: spec.task.name,
    stdout: sandbox.stdout.slice(0, MAX_CAPTURE),
    stderr: sandbox.stderr.slice(0, MAX_CAPTURE),
    exitCode: sandbox.exitCode,
    signal: sandbox.signal,
    timedOut: sandbox.timedOut,
    oom: sandbox.oom,
    durationMs: sandbox.durationMs,
  };

  return {
    ok: true,
    value: {
      taskId: spec.task.id,
      kind: spec.kind,
      command: spec.command,
      args: spec.args,
      result,
      tests,
    },
  };
}
