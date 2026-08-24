import { promises as fs, constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { IS_WINDOWS } from "../config.js";
import { listFiles } from "../files/service.js";
import { detectLanguage, resolveMainFile } from "./detect.js";
import { getLang } from "./languages.js";
import { sandboxRun, type SandboxController } from "./sandbox.js";
import { isDockerRunning, isRunnerImageAvailable } from "../tools.js";

export type RunOutcome =
  | "success"
  | "compile_error"
  | "missing_toolchain"
  | "no_language"
  | "no_main_file"
  | "not_runnable";

export interface RunResult {
  type: RunOutcome;
  language: string | null;
  mainFile: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  oom: boolean;
  durationMs: number;
}

interface RunSpec {
  language?: string;
  activeFile?: string;
  stdin?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onStatus?: (data: string) => void;
  onController?: (ctrl: SandboxController) => void;
  isCancelled?: () => boolean;
  /** Charged against the per-owner sandbox quota — see SandboxOptions.userId. */
  userId: number;
}

export async function runProject(
  cfg: AppConfig,
  projectId: string,
  workspaceDir: string,
  spec: RunSpec,
): Promise<RunResult> {
  const files = await listFiles(workspaceDir);
  const lang =
    getLang(spec.language ?? "") ??
    detectLanguage(files, spec.language ?? null, spec.activeFile ?? null);

  const base: RunResult = {
    type: "success",
    language: lang?.id ?? null,
    mainFile: null,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: false,
    oom: false,
    durationMs: 0,
  };

  if (!lang) {
    return {
      ...base,
      type: "no_language",
      stderr: "could not determine the project language",
    };
  }

  if (!isDockerRunning()) {
    return {
      ...base,
      type: "missing_toolchain",
      language: lang.id,
      stderr:
        "Docker Sandbox unavailable.\nCloudeeeIDE requires Docker Desktop for execution.\nNo host compiler installation is required.",
    };
  }

  if (!isRunnerImageAvailable()) {
    return {
      ...base,
      type: "missing_toolchain",
      language: lang.id,
      stderr:
        "Runner Image unavailable.\nPlease build cloudeeeide-runner:latest using: npm run runner:build",
    };
  }

  const mainFile = resolveMainFile(lang, files, spec.activeFile);
  if (!mainFile) {
    return {
      ...base,
      type: "no_main_file",
      language: lang.id,
      stderr: `no entry file found (expected ${lang.mainFiles.join(" or ")} or a single ${lang.extensions.join("/")} file)`,
    };
  }

  if (!lang.run) {
    return {
      ...base,
      type: "not_runnable",
      language: lang.id,
      mainFile,
      stderr: `Files of type ${lang.name} cannot be executed directly.`,
    };
  }

  if (spec.onStatus) spec.onStatus("Preparing Docker sandbox...");

  const runId = randomUUID();
  const buildDirName = `.cloudide-build-${runId}`;
  const buildDir = join(workspaceDir, buildDirName);

  const ctx = { workspaceDir, mainFile, buildDir: buildDirName, files };

  if (lang.compile) {
    if (spec.onStatus) spec.onStatus(`Compiling with ${lang.compile.cmd}...`);
    await fs.mkdir(buildDir, { recursive: true });
    if (!IS_WINDOWS) {
      // fs.mkdir's default mode (0755, owned by whoever this process runs
      // as) is not automatically inherited from the already-writable
      // workspace root — a freshly-created directory gets its own default
      // permissions. The sandbox container always writes compiler output
      // here as its fixed, image-baked-in `ide` user (see
      // docker/Dockerfile.runner), which is almost never the uid of the
      // process running this backend, so this needs its own explicit,
      // permissive mode regardless of who created it.
      try {
        await fs.chmod(buildDir, 0o777);
      } catch {
        // best-effort
      }
    }

    const compileRes = await sandboxRun(projectId, workspaceDir, {
      command: lang.compile.cmd,
      args: lang.compile.args(ctx),
      cwd: workspaceDir,
      // Compilers don't take interactive input; without an explicit stdin
      // string, sandboxRun leaves the pipe open whenever onController is
      // set (so a genuinely interactive run can stream stdin via
      // writeStdin) — an empty string here still triggers `write` + `end`,
      // matching the pre-existing close-immediately behavior for builds.
      stdin: "",
      onStdout: spec.onStdout,
      onStderr: spec.onStderr,
      onController: spec.onController,
      isCancelled: spec.isCancelled,
      kind: "build",
      timeoutMs: cfg.buildTimeoutMs,
      config: cfg,
      userId: spec.userId,
    });
    if (compileRes.exitCode !== 0) {
      await fs.rm(buildDir, { recursive: true, force: true });
      return {
        ...base,
        type: "compile_error",
        language: lang.id,
        mainFile,
        stdout: compileRes.stdout,
        stderr: compileRes.stderr,
        exitCode: compileRes.exitCode,
        signal: compileRes.signal,
        timedOut: compileRes.timedOut,
        oom: compileRes.oom,
        durationMs: compileRes.durationMs,
      };
    }
    if (spec.onStatus) spec.onStatus("Compilation successful.");
  }

  if (spec.onStatus) spec.onStatus(`Running ${mainFile}...`);
  const runRes = await sandboxRun(projectId, workspaceDir, {
    command: lang.run.cmd(ctx),
    args: lang.run.args(ctx),
    cwd: workspaceDir,
    stdin: spec.stdin,
    onStdout: spec.onStdout,
    onStderr: spec.onStderr,
    onController: spec.onController,
    isCancelled: spec.isCancelled,
    kind: "run",
    timeoutMs: cfg.runTimeoutMs,
    config: cfg,
    userId: spec.userId,
  });

  if (lang.compile) {
    try {
      await fs.access(buildDir, constants.F_OK);
      await fs.rm(buildDir, { recursive: true, force: true });
    } catch {}
  }

  return {
    ...base,
    type: "success",
    language: lang.id,
    mainFile,
    stdout: runRes.stdout,
    stderr: runRes.stderr,
    exitCode: runRes.exitCode,
    signal: runRes.signal,
    timedOut: runRes.timedOut,
    oom: runRes.oom,
    durationMs: runRes.durationMs,
  };
}
