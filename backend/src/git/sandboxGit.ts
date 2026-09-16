import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import {
  isDockerRunningAsync,
  isRunnerImageAvailableAsync,
} from "../tools.js";
import { sandboxManager } from "../execution/sandbox.js";
import { lspHostDockerEnv } from "../lsp/process.js";

/**
 * M87 — project Git runs inside the project sandbox.
 *
 * The repository is sandbox-writable (`/workspace` is a bind mount), so its
 * `.git/config`, attributes, hooks, filters, fsmonitor, includes, and nested
 * repositories are hostile input. Git honors all of them. Running Git on the
 * host (M51–M86) let a collaborator execute commands on the backend host
 * through a filter driver. Here Git runs as the sandbox `ide` user inside the
 * container that already executes arbitrary project code, so anything the
 * repository makes Git execute runs with exactly the privileges the
 * collaborator already has in the terminal — never on the host.
 *
 * The host only authorizes, chooses the argv, and parses the output as
 * untrusted text. It never passes a secret into the sandbox: remote
 * transport (credentials, network) stays on the host in `transport.ts` and
 * never reads this repository.
 *
 * Invocation (`docker exec`, no shell, no host env):
 *   docker exec -i -u ide -w /workspace ide-sandbox-<id>
 *     /bin/sh -c 'umask 0; exec "$@"' veyra-git
 *     /usr/bin/env -i <fixed env>
 *     /usr/bin/timeout -s KILL <secs> /usr/bin/git <base -c> <args>
 *
 *  - `env -i`: the container's own environment is not inherited; the
 *    process sees only the fixed variables below.
 *  - `GIT_DIR` / `GIT_WORK_TREE` are explicit: no repository discovery, no
 *    parent-directory config, always `/workspace/.git`.
 *  - `GIT_CONFIG_GLOBAL=/dev/null`; system config is the image's own
 *    read-only `/etc/gitconfig` (it only sets `safe.directory`).
 *  - `timeout -s KILL` kills Git and every child in its process group inside
 *    the container, so a timed-out filter cannot outlive the request even
 *    though killing the host `docker exec` client would not reach it.
 *  - umask 0 (with `core.sharedRepository=world` at init) keeps the M51
 *    property that a backend whose uid differs from the sandbox uid can
 *    still manage the files Git creates.
 *
 * The `-c` values below keep Veyra's product semantics (no hooks, no
 * signing, no background maintenance, no network). They are NOT the
 * security boundary — the container is.
 */

export const SANDBOX_WORKSPACE = "/workspace";
export const SANDBOX_GIT_DIR = "/workspace/.git";

const SANDBOX_GIT_ENV: readonly string[] = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp",
  "LANG=C",
  "LC_ALL=C",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_CEILING_DIRECTORIES=/",
  "GIT_TERMINAL_PROMPT=0",
  "GIT_PAGER=cat",
  "PAGER=cat",
  "GIT_EDITOR=true",
  // Empty list: every transport is disallowed for sandbox Git.
  "GIT_ALLOW_PROTOCOL=",
  // Reads run outside the project lock; they must not take index.lock.
  "GIT_OPTIONAL_LOCKS=0",
];

const REPO_ENV: readonly string[] = [
  `GIT_DIR=${SANDBOX_GIT_DIR}`,
  `GIT_WORK_TREE=${SANDBOX_WORKSPACE}`,
];

export const SANDBOX_GIT_BASE_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "advice.detachedHead=false",
];

export const GIT_TIMEOUT_MS = 15_000;
/** Remote-adjacent sandbox steps (pack indexing / generation, checkout). */
export const GIT_TRANSFER_TIMEOUT_MS = 120_000;
export const GIT_MAX_BUFFER = 12 * 1024 * 1024;
/** Grace for the host watchdog beyond the in-container `timeout`. */
const HOST_WATCHDOG_GRACE_MS = 10_000;

let timeoutOverrideMs: number | null = null;
/** Test-only: shorten the default sandbox Git timeout. */
export function setSandboxGitTimeoutForTests(ms: number | null): void {
  timeoutOverrideMs = ms;
}

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// ---------------------------------------------------------------------------
// Project → sandbox binding
// ---------------------------------------------------------------------------

type OwnerResolver = (projectId: string) => number | undefined;
const ownerResolvers = new WeakMap<AppConfig, OwnerResolver>();

/**
 * Registered by `gitRoutes` for its config: the sandbox is charged to the
 * project owner (the same "owner" slot `SandboxManager` tracks), and a
 * project that no longer exists never gets a container.
 */
export function registerGitSandboxOwnerResolver(
  cfg: AppConfig,
  resolve: OwnerResolver,
): void {
  ownerResolvers.set(cfg, resolve);
}

export function assertGitProjectId(projectId: string): void {
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw new ApiError(404, "project not found", "not_found");
  }
}

function sandboxUnavailable(detail?: string): ApiError {
  return new ApiError(
    503,
    detail
      ? `Git runs in the project sandbox, which is unavailable: ${detail}`
      : "Git runs in the project sandbox, which is unavailable",
    "git_unavailable",
  );
}

/**
 * Resolve the container for `projectId`, creating it if needed. The
 * container name is derived only from the validated project id, and the
 * sandbox manager creates `ide-sandbox-<id>` with exactly that project's
 * workspace as its only bind mount, so an exec by this name can only ever
 * reach this project's repository.
 */
export async function gitSandboxContainer(
  cfg: AppConfig,
  projectId: string,
): Promise<string> {
  assertGitProjectId(projectId);
  const workspaceDir = await workspacePath(cfg, projectId);
  const ownerId = ownerResolvers.get(cfg)?.(projectId);
  if (ownerId === undefined) {
    throw new ApiError(404, "project not found", "not_found");
  }
  if (!(await isDockerRunningAsync())) {
    throw sandboxUnavailable("Docker is not running");
  }
  if (!(await isRunnerImageAvailableAsync())) {
    throw sandboxUnavailable("the runner image is missing");
  }
  let containerId: string;
  try {
    containerId = await sandboxManager.ensureProjectSandbox(
      projectId,
      cfg,
      workspaceDir,
      ownerId,
    );
  } catch (err: any) {
    throw sandboxUnavailable(String(err?.message ?? "start failed").slice(0, 200));
  }
  if (containerId !== `ide-sandbox-${projectId}`) {
    throw sandboxUnavailable("unexpected container");
  }
  sandboxManager.touch(projectId);
  return containerId;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface SandboxGitOpts {
  allowNonZero?: boolean;
  /** Written to Git's stdin, then closed. */
  input?: string | Buffer;
  timeoutMs?: number;
  /** Cap on collected stdout (and on piped bytes for `stdinFrom`). */
  maxOutputBytes?: number;
  /** `git init` runs without GIT_DIR/GIT_WORK_TREE (cwd is /workspace). */
  noRepoEnv?: boolean;
  /** Pipe this stream into Git's stdin (pack transfer). */
  stdinFrom?: Readable;
  /** Hand Git's stdout to the caller instead of collecting it. */
  stdoutTo?: Writable;
}

export interface SandboxGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const capturedArgv: string[][] = [];

/** Test-only: drain the docker argv recorded by the sandbox runner. */
export function _takeCapturedSandboxGitArgvForTests(): string[][] {
  return capturedArgv.splice(0);
}

export function sandboxGitArgv(
  containerId: string,
  args: string[],
  opts: { timeoutMs: number; noRepoEnv?: boolean },
): string[] {
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  return [
    "exec",
    "-i",
    "-u",
    "ide",
    "-w",
    SANDBOX_WORKSPACE,
    containerId,
    "/bin/sh",
    "-c",
    'umask 0; exec "$@"',
    "veyra-git",
    "/usr/bin/env",
    "-i",
    ...SANDBOX_GIT_ENV,
    ...(opts.noRepoEnv ? [] : REPO_ENV),
    "/usr/bin/timeout",
    "-s",
    "KILL",
    String(secs),
    "/usr/bin/git",
    ...SANDBOX_GIT_BASE_ARGS,
    ...args,
  ];
}

const DOCKER_FAILURE_RE =
  /Error response from daemon|No such container|is not running|cannot connect to the docker daemon/i;

/**
 * A Git killed by its timeout (or by the sandbox going away) cannot remove
 * the `*.lock` files it held, which would wedge every later Veyra write.
 * Remember when the killed operation started and delete, inside the
 * container, only lock files created since then — immediately if the
 * container survived, otherwise before the next Git call for the project.
 */
const staleLocksSince = new Map<string, number>();

async function clearStaleGitLocks(
  containerId: string,
  sinceEpochSec: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-u",
        "ide",
        containerId,
        "/usr/bin/timeout",
        "-s",
        "KILL",
        "10",
        "/usr/bin/find",
        SANDBOX_GIT_DIR,
        "-xdev",
        "-maxdepth",
        "6",
        "-name",
        "*.lock",
        "-type",
        "f",
        "-newermt",
        `@${sinceEpochSec}`,
        "-delete",
      ],
      { stdio: "ignore", windowsHide: true, env: lspHostDockerEnv() },
    );
    const done = () => resolve();
    child.on("error", done);
    child.on("close", done);
  });
}

function noteKilledOperation(projectId: string, startedMs: number): void {
  const since = Math.floor(startedMs / 1000) - 1;
  const prev = staleLocksSince.get(projectId);
  staleLocksSince.set(projectId, prev === undefined ? since : Math.min(prev, since));
}

export async function runSandboxGit(
  cfg: AppConfig,
  projectId: string,
  args: string[],
  opts: SandboxGitOpts = {},
): Promise<SandboxGitResult> {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) {
      throw new ApiError(400, "invalid git argument", "invalid_git_arg");
    }
  }
  const containerId = await gitSandboxContainer(cfg, projectId);
  const pendingSince = staleLocksSince.get(projectId);
  if (pendingSince !== undefined) {
    staleLocksSince.delete(projectId);
    await clearStaleGitLocks(containerId, pendingSince);
  }
  const timeoutMs = opts.timeoutMs ?? timeoutOverrideMs ?? GIT_TIMEOUT_MS;
  const maxOut = opts.maxOutputBytes ?? GIT_MAX_BUFFER;
  const argv = sandboxGitArgv(containerId, args, {
    timeoutMs,
    noRepoEnv: opts.noRepoEnv,
  });
  capturedArgv.push([...argv]);

  const started = Date.now();
  const child = spawn("docker", argv, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: lspHostDockerEnv(),
  });
  child.stdin!.on("error", () => {});

  const result = await collect(child, {
    timeoutMs,
    maxOut,
    input: opts.input,
    stdinFrom: opts.stdinFrom,
    stdoutTo: opts.stdoutTo,
  });
  sandboxManager.touch(projectId);

  if (result.spawnError) {
    throw sandboxUnavailable("the docker CLI is not available");
  }
  if (result.overflow) {
    throw new ApiError(413, "git output too large", "git_output_too_large");
  }
  const elapsed = Date.now() - started;
  const timedOut =
    result.hostKilled ||
    result.code === 124 ||
    (result.code === 137 && elapsed >= timeoutMs - 250);
  if (timedOut) {
    noteKilledOperation(projectId, started);
    if (sandboxManager.hasActiveSandbox(projectId)) {
      staleLocksSince.delete(projectId);
      await clearStaleGitLocks(containerId, Math.floor(started / 1000) - 1);
    }
    throw new ApiError(504, "git operation timed out", "git_timeout");
  }
  if (result.code === 137) {
    noteKilledOperation(projectId, started);
    throw sandboxUnavailable("Git was stopped by the sandbox");
  }
  // `docker exec` itself failed (container removed / stopped mid-operation).
  if (
    result.code !== 0 &&
    (result.code === 125 ||
      result.code === 126 ||
      result.code === 127 ||
      (result.code === 1 && DOCKER_FAILURE_RE.test(result.stderr)))
  ) {
    noteKilledOperation(projectId, started);
    throw sandboxUnavailable("the sandbox stopped during the Git operation");
  }
  return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

interface Collected {
  stdout: string;
  stderr: string;
  code: number;
  overflow: boolean;
  hostKilled: boolean;
  spawnError: boolean;
}

function collect(
  child: ChildProcess,
  o: {
    timeoutMs: number;
    maxOut: number;
    input?: string | Buffer;
    stdinFrom?: Readable;
    stdoutTo?: Writable;
  },
): Promise<Collected> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let hostKilled = false;
    let spawnError = false;
    let settled = false;

    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const watchdog = setTimeout(() => {
      hostKilled = true;
      kill();
    }, o.timeoutMs + HOST_WATCHDOG_GRACE_MS);

    if (o.stdoutTo) {
      // A consumer that gave up destroys the pipe; stop producing.
      // Drain what is left so `close` is not held up by a paused stream.
      o.stdoutTo.on("error", () => {
        child.stdout!.unpipe();
        child.stdout!.resume();
        kill();
      });
      child.stdout!.pipe(o.stdoutTo);
    } else {
      child.stdout!.on("data", (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > o.maxOut) {
          overflow = true;
          kill();
          return;
        }
        out.push(d);
      });
    }
    child.stderr!.on("data", (d: Buffer) => {
      // stderr is diagnostics only; keep the first megabyte.
      if (errBytes < 1024 * 1024) err.push(d);
      errBytes += d.length;
    });

    if (o.stdinFrom) {
      let piped = 0;
      o.stdinFrom.on("data", (d: Buffer) => {
        piped += d.length;
        if (piped > o.maxOut) {
          overflow = true;
          o.stdinFrom!.destroy();
          kill();
        }
      });
      o.stdinFrom.on("error", () => kill());
      o.stdinFrom.pipe(child.stdin!);
    } else if (o.input !== undefined) {
      child.stdin!.end(o.input);
    } else {
      child.stdin!.end();
    }

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
        overflow,
        hostKilled,
        spawnError,
      });
    };
    child.on("error", () => {
      spawnError = true;
      finish(-1);
    });
    child.on("close", (code, signal) => {
      finish(typeof code === "number" ? code : signal ? 137 : -1);
    });
  });
}
