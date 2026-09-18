import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { IS_WINDOWS } from "../config.js";
import {
  assertGitProjectId,
  runSandboxGit,
  GIT_TRANSFER_TIMEOUT_MS,
} from "./sandboxGit.js";
import { withGitAskpass, type GitAskpassCreds } from "./askpass.js";
import { redactGitOutput } from "./redact.js";
import { httpsRemoteHost } from "./remoteUrl.js";

/**
 * M87 — credential-bearing Git transport, host side.
 *
 * Remote HTTPS operations need the project's PAT. The sandbox is shared by
 * every collaborator and runs their code as one uid, so a secret handed to a
 * sandbox process (env, file, askpass) is readable by any collaborator's
 * background process. The PAT therefore never enters the sandbox.
 *
 * Instead the host talks to the remote from a **server-owned bare mirror**
 * (`<dataDir>/git-transport/<projectId>.git`). That repository is created
 * and configured only by this module, is not under any workspace, and is
 * not mounted into any container, so the host Git that runs there never
 * reads repository-controlled configuration, attributes, hooks, or a work
 * tree. Every invocation still pins `GIT_DIR`, disables system/global
 * config, hooks, fsmonitor, and credential helpers, and allows only HTTPS
 * (network steps) or no transport at all (local steps).
 *
 * Objects cross the boundary as raw pack streams:
 *  - remote → sandbox: host `pack-objects` → sandbox `index-pack --stdin`,
 *    then sandbox `update-ref` for `refs/remotes/origin/*`;
 *  - sandbox → remote: sandbox `pack-objects` → host
 *    `index-pack --stdin --strict` (full fsck of every object), a host
 *    connectivity check, then host `push <sha>:refs/heads/<branch>`.
 * Everything the sandbox reports (object ids, branch names) is validated
 * before it reaches a host argv.
 */

export const GIT_REMOTE_TIMEOUT_MS = 120_000;
const HOST_LOCAL_TIMEOUT_MS = 60_000;
const HOST_MAX_BUFFER = 12 * 1024 * 1024;
/** Upper bound on one pack crossing the sandbox boundary. */
export const GIT_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const REMOTE_TRACKING_PREFIX = "refs/remotes/origin/";

export function isObjectId(s: unknown): s is string {
  return typeof s === "string" && OID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Host environment (mirror only)
// ---------------------------------------------------------------------------

export function transportRoot(cfg: AppConfig): string {
  return join(cfg.dataDir, "git-transport");
}

export function mirrorDir(cfg: AppConfig, projectId: string): string {
  assertGitProjectId(projectId);
  return join(transportRoot(cfg), `${projectId}.git`);
}

function isolatedHome(cfg: AppConfig): string {
  return join(transportRoot(cfg), ".home");
}

function noHooksDir(cfg: AppConfig): string {
  return join(transportRoot(cfg), ".no-hooks");
}

type HostProtocol = "none" | "https";

function hostGitEnv(
  cfg: AppConfig,
  gitDir: string,
  protocol: HostProtocol,
  extraEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const devNull = IS_WINDOWS ? "NUL" : "/dev/null";
  const home = isolatedHome(cfg);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot, // Windows: git needs this to run
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: IS_WINDOWS ? "cmd /c exit 1" : "true",
    GIT_PAGER: "cat",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    LANG: "C",
    LC_ALL: "C",
    ...extraEnv,
  };
  // Pinned after extraEnv: the repository and protocol are never overridable.
  env.GIT_DIR = gitDir;
  env.GIT_CEILING_DIRECTORIES = dirname(gitDir);
  env.GIT_ALLOW_PROTOCOL = protocol === "https" ? "https" : "";
  if (protocol === "https" && cfg.gitSslCaInfo) {
    env.GIT_SSL_CAINFO = cfg.gitSslCaInfo;
    env.SSL_CERT_FILE = cfg.gitSslCaInfo;
  }
  return env;
}

function hostBaseArgs(cfg: AppConfig): string[] {
  return [
    "-c",
    `core.hooksPath=${noHooksDir(cfg)}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "transfer.fsckObjects=true",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
  ];
}

const capturedHostArgv: string[][] = [];

/** Test-only: drain argv recorded by the host transport (never env). */
export function _takeCapturedTransportArgvForTests(): string[][] {
  return capturedHostArgv.splice(0);
}

interface HostGitOpts {
  protocol?: HostProtocol;
  extraEnv?: NodeJS.ProcessEnv;
  input?: string;
  stdinFrom?: Readable;
  stdoutTo?: Writable;
  timeoutMs?: number;
  maxInputBytes?: number;
}

interface HostGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run host Git against this project's mirror. There is no cwd/git-dir
 * parameter: the only repository host Git can touch is `mirrorDir`.
 */
async function runHostGit(
  cfg: AppConfig,
  projectId: string,
  args: string[],
  opts: HostGitOpts = {},
): Promise<HostGitResult> {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) {
      throw new ApiError(400, "invalid git argument", "invalid_git_arg");
    }
  }
  const gitDir = mirrorDir(cfg, projectId);
  const argv = [...hostBaseArgs(cfg), ...args];
  capturedHostArgv.push([...argv]);
  const timeoutMs = opts.timeoutMs ?? HOST_LOCAL_TIMEOUT_MS;
  const child = spawn("git", argv, {
    cwd: gitDir,
    env: hostGitEnv(cfg, gitDir, opts.protocol ?? "none", opts.extraEnv ?? {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});

  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    if (opts.stdoutTo) {
      // A consumer that gave up destroys the pipe; stop producing.
      // Drain what is left so `close` is not held up by a paused stream.
      opts.stdoutTo.on("error", () => {
        child.stdout.unpipe();
        child.stdout.resume();
        kill();
      });
      child.stdout.pipe(opts.stdoutTo);
    } else {
      child.stdout.on("data", (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > HOST_MAX_BUFFER) {
          overflow = true;
          kill();
          return;
        }
        out.push(d);
      });
    }
    child.stderr.on("data", (d: Buffer) => {
      if (errBytes < 1024 * 1024) err.push(d);
      errBytes += d.length;
    });
    if (opts.stdinFrom) {
      let piped = 0;
      const cap = opts.maxInputBytes ?? GIT_TRANSFER_MAX_BYTES;
      opts.stdinFrom.on("data", (d: Buffer) => {
        piped += d.length;
        if (piped > cap) {
          overflow = true;
          opts.stdinFrom!.destroy();
          kill();
        }
      });
      opts.stdinFrom.on("error", () => kill());
      opts.stdinFrom.pipe(child.stdin);
    } else {
      child.stdin.end(opts.input ?? "");
    }

    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new ApiError(504, "git operation timed out", "git_timeout"));
        return;
      }
      if (overflow) {
        reject(
          new ApiError(413, "git transfer too large", "git_output_too_large"),
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    };
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new ApiError(500, "git is not available on this server", "git_unavailable")
          : new ApiError(500, "git could not be started", "git_unavailable"),
      );
    });
    child.on("close", (code, signal) => {
      done(typeof code === "number" ? code : signal ? 137 : -1);
    });
  });
}

// ---------------------------------------------------------------------------
// Mirror lifecycle
// ---------------------------------------------------------------------------

const ORIGIN_MARKER = "veyra-origin-url";

/**
 * Make sure the project's mirror exists and belongs to `url`. A mirror that
 * was fetched from a different URL is discarded, so refs of a previous
 * origin never flow into the project as `origin/*`.
 */
export async function ensureMirror(
  cfg: AppConfig,
  projectId: string,
  url: string,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const dir = mirrorDir(cfg, projectId);
  await fs.mkdir(noHooksDir(cfg), { recursive: true, mode: 0o700 });
  await fs.mkdir(isolatedHome(cfg), { recursive: true, mode: 0o700 });
  let current: string | null = null;
  try {
    current = await fs.readFile(join(dir, ORIGIN_MARKER), "utf8");
  } catch {
    current = null;
  }
  if (!opts.fresh && current === url) return;
  await removeMirror(cfg, projectId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const init = await runHostGit(cfg, projectId, ["init", "--bare", "-q"]);
  if (init.code !== 0) {
    throw new ApiError(500, "could not prepare the Git transport", "git_error");
  }
  await fs.writeFile(join(dir, ORIGIN_MARKER), url, { mode: 0o600 });
}

export async function removeMirror(
  cfg: AppConfig,
  projectId: string,
): Promise<void> {
  await fs.rm(mirrorDir(cfg, projectId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Network steps (host, HTTPS only, credentials via askpass files)
// ---------------------------------------------------------------------------

export interface TransportCreds {
  username: string;
  token: string;
}

export interface RemoteFailure {
  stderr: string;
  secrets: string[];
}

function askpassFor(url: string, creds: TransportCreds | null): GitAskpassCreds | null {
  if (!creds) return null;
  return { username: creds.username, token: creds.token, host: httpsRemoteHost(url) };
}

/**
 * Run `fn` with a credential session for `url`. `net` runs one HTTPS Git
 * command in the mirror and returns its redacted result; a non-zero exit is
 * reported through `onFailure` (which must throw).
 */
async function withRemote<T>(
  cfg: AppConfig,
  projectId: string,
  url: string,
  creds: TransportCreds | null,
  onFailure: (f: RemoteFailure) => never,
  fn: (net: (args: string[]) => Promise<HostGitResult>) => Promise<T>,
): Promise<T> {
  return withGitAskpass(cfg, askpassFor(url, creds), async (s) => {
    const net = async (args: string[]) => {
      let res: HostGitResult;
      try {
        res = await runHostGit(cfg, projectId, args, {
          protocol: "https",
          extraEnv: s.extraEnv,
          timeoutMs: GIT_REMOTE_TIMEOUT_MS,
        });
      } catch (err: any) {
        if (err instanceof ApiError && err.message) {
          err.message = redactGitOutput(err.message, s.secrets);
        }
        throw err;
      }
      const red = {
        ...res,
        stdout: redactGitOutput(res.stdout, s.secrets),
        stderr: redactGitOutput(res.stderr, s.secrets),
      };
      if (red.code !== 0) onFailure({ stderr: red.stderr, secrets: s.secrets });
      return red;
    };
    return fn(net);
  });
}

/** Fetch every remote branch into the mirror's `refs/remotes/origin/*`. */
export async function mirrorFetch(
  cfg: AppConfig,
  projectId: string,
  url: string,
  creds: TransportCreds | null,
  onFailure: (f: RemoteFailure) => never,
  opts: { fresh?: boolean; readHead?: boolean } = {},
): Promise<{ headBranch: string | null }> {
  await ensureMirror(cfg, projectId, url, { fresh: opts.fresh });
  return withRemote(cfg, projectId, url, creds, onFailure, async (net) => {
    await net([
      "fetch",
      "--prune",
      "--no-tags",
      "--no-write-fetch-head",
      "--quiet",
      "--",
      url,
      `+refs/heads/*:${REMOTE_TRACKING_PREFIX}*`,
    ]);
    let headBranch: string | null = null;
    if (opts.readHead) {
      const ls = await net(["ls-remote", "--symref", "--", url, "HEAD"]);
      const m = ls.stdout.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m);
      headBranch = m ? m[1] : null;
    }
    return { headBranch };
  });
}

/** Push a commit the mirror already holds. Never forces. */
export async function mirrorPush(
  cfg: AppConfig,
  projectId: string,
  url: string,
  creds: TransportCreds | null,
  sha: string,
  branch: string,
  onFailure: (f: RemoteFailure) => never,
): Promise<void> {
  if (!isObjectId(sha)) {
    throw new ApiError(400, "invalid commit", "invalid_hash");
  }
  await assertHostBranchName(cfg, projectId, branch);
  await withRemote(cfg, projectId, url, creds, onFailure, async (net) => {
    await net([
      "push",
      "--porcelain",
      "--no-verify",
      "--",
      url,
      `${sha}:refs/heads/${branch}`,
    ]);
  });
  await runHostGit(cfg, projectId, [
    "update-ref",
    `${REMOTE_TRACKING_PREFIX}${branch}`,
    sha,
  ]);
}

// ---------------------------------------------------------------------------
// Validation helpers (host, trusted mirror)
// ---------------------------------------------------------------------------

export async function assertHostBranchName(
  cfg: AppConfig,
  projectId: string,
  branch: unknown,
): Promise<string> {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > 240 ||
    !/^[\x21-\x7e]+$/.test(branch) ||
    branch.startsWith("-")
  ) {
    throw new ApiError(400, "invalid branch name", "invalid_branch_name");
  }
  const res = await runHostGit(cfg, projectId, [
    "check-ref-format",
    "--branch",
    branch,
  ]);
  if (res.code !== 0 || res.stdout.trim() !== branch) {
    throw new ApiError(400, "invalid branch name", "invalid_branch_name");
  }
  return branch;
}

async function mirrorTips(
  cfg: AppConfig,
  projectId: string,
): Promise<Map<string, string>> {
  const res = await runHostGit(cfg, projectId, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    REMOTE_TRACKING_PREFIX,
  ]);
  const tips = new Map<string, string>();
  for (const line of res.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const oid = line.slice(0, sp);
    const ref = line.slice(sp + 1);
    if (!isObjectId(oid) || !ref.startsWith(REMOTE_TRACKING_PREFIX)) continue;
    const name = ref.slice(REMOTE_TRACKING_PREFIX.length);
    if (!name || name === "HEAD") continue;
    tips.set(name, oid);
  }
  return tips;
}

/** Which of `oids` exist in the mirror. */
async function mirrorHas(
  cfg: AppConfig,
  projectId: string,
  oids: string[],
): Promise<Set<string>> {
  if (oids.length === 0) return new Set();
  const res = await runHostGit(cfg, projectId, ["cat-file", "--batch-check"], {
    input: oids.join("\n") + "\n",
  });
  return parseBatchCheck(res.stdout, oids);
}

/** Which of `oids` exist in the project repository (sandbox, untrusted). */
async function sandboxHas(
  cfg: AppConfig,
  projectId: string,
  oids: string[],
): Promise<Set<string>> {
  if (oids.length === 0) return new Set();
  const res = await runSandboxGit(cfg, projectId, ["cat-file", "--batch-check"], {
    input: oids.join("\n") + "\n",
    allowNonZero: true,
  });
  return parseBatchCheck(res.stdout, oids);
}

function parseBatchCheck(stdout: string, asked: string[]): Set<string> {
  const wanted = new Set(asked);
  const have = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (commit|tree|blob|tag) \d+$/);
    if (m && wanted.has(m[1])) have.add(m[1]);
  }
  return have;
}

function packRevInput(tips: string[], haves: string[]): string {
  const lines = [...tips];
  if (haves.length > 0) lines.push("--not", ...haves);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Object transfer
// ---------------------------------------------------------------------------

/**
 * Copy the mirror's remote-tracking branches into the project repository
 * (`refs/remotes/origin/*`). Existing remote-tracking refs the remote no
 * longer has are left alone (the pre-M87 fetch did not prune either).
 */
export async function deliverRemoteTracking(
  cfg: AppConfig,
  projectId: string,
): Promise<Map<string, string>> {
  const tips = await mirrorTips(cfg, projectId);
  if (tips.size === 0) return tips;

  const wanted = [...new Set(tips.values())];
  const present = await sandboxHas(cfg, projectId, wanted);
  const missing = wanted.filter((o) => !present.has(o));

  if (missing.length > 0) {
    const local = await runSandboxGit(
      cfg,
      projectId,
      [
        "for-each-ref",
        "--format=%(objectname)",
        "refs/heads/",
        REMOTE_TRACKING_PREFIX,
      ],
      { allowNonZero: true },
    );
    const claimed = [
      ...new Set(local.stdout.split("\n").map((s) => s.trim()).filter(isObjectId)),
    ];
    const haves = [...(await mirrorHas(cfg, projectId, claimed))];
    await pipeHostPackToSandbox(cfg, projectId, packRevInput(missing, haves));
  }

  const updates = [...tips.entries()]
    .map(([name, oid]) => `update ${REMOTE_TRACKING_PREFIX}${name} ${oid}\n`)
    .join("");
  const upd = await runSandboxGit(cfg, projectId, ["update-ref", "--stdin"], {
    input: updates,
    allowNonZero: true,
  });
  if (upd.code !== 0) {
    throw new ApiError(502, "could not update remote-tracking branches", "git_error");
  }
  return tips;
}

async function pipeHostPackToSandbox(
  cfg: AppConfig,
  projectId: string,
  revInput: string,
): Promise<void> {
  const ok = await transferPack(
    (pipe) =>
      runHostGit(cfg, projectId, PACK_OBJECTS, {
        input: revInput,
        stdoutTo: pipe,
        timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
      }),
    (pipe) =>
      runSandboxGit(cfg, projectId, ["index-pack", "--stdin", "--fix-thin"], {
        stdinFrom: pipe,
        allowNonZero: true,
        timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
        maxOutputBytes: GIT_TRANSFER_MAX_BYTES,
      }),
  );
  if (!ok) {
    throw new ApiError(502, "could not transfer objects into the project", "git_error");
  }
}

const PACK_OBJECTS = [
  "pack-objects",
  "--stdout",
  "--revs",
  "--thin",
  "--delta-base-offset",
  "-q",
];

/**
 * Stream a pack from `produce` into `consume`. Whichever side fails first
 * tears the pipe down so the other side stops instead of waiting for its
 * timeout. Resolves true only when both sides exited 0.
 */
async function transferPack(
  produce: (out: PassThrough) => Promise<{ code: number }>,
  consume: (inp: PassThrough) => Promise<{ code: number }>,
): Promise<boolean> {
  const pipe = new PassThrough();
  pipe.on("error", () => {});
  // The side that fails first decides the outcome; the other side is then
  // torn down by us, and its resulting kill error must not mask the cause.
  let firstFailure: "producer" | "consumer" | null = null;
  const abort = (side: "producer" | "consumer") => {
    firstFailure ??= side;
    if (!pipe.destroyed) pipe.destroy(new Error("pack transfer aborted"));
  };
  const [producer, consumer] = await Promise.allSettled([
    produce(pipe).then(
      (r) => {
        if (r.code === 0) pipe.end();
        else abort("producer");
        return r;
      },
      (e) => {
        abort("producer");
        throw e;
      },
    ),
    consume(pipe).then(
      (r) => {
        if (r.code !== 0) abort("consumer");
        return r;
      },
      (e) => {
        abort("consumer");
        throw e;
      },
    ),
  ]);
  const first = firstFailure === "producer" ? producer : consumer;
  if (firstFailure !== null) {
    if (first.status === "rejected") throw first.reason;
    return false;
  }
  if (consumer.status === "rejected") throw consumer.reason;
  if (producer.status === "rejected") throw producer.reason;
  return producer.value.code === 0 && consumer.value.code === 0;
}

/**
 * Make sure the mirror holds `sha` and everything reachable from it that the
 * remote may need. The pack comes from the sandbox and is untrusted:
 * `index-pack --strict` fscks every object, and `rev-list --objects` proves
 * the commit is fully connected before anything is pushed.
 */
export async function importCommitFromSandbox(
  cfg: AppConfig,
  projectId: string,
  sha: string,
): Promise<void> {
  if (!isObjectId(sha)) {
    throw new ApiError(400, "invalid commit", "invalid_hash");
  }
  const tips = [...new Set((await mirrorTips(cfg, projectId)).values())];
  const hasCommit = await mirrorHas(cfg, projectId, [sha]);
  if (!hasCommit.has(sha)) {
    const haves = [...(await sandboxHas(cfg, projectId, tips))];
    const ok = await transferPack(
      (pipe) =>
        runSandboxGit(cfg, projectId, PACK_OBJECTS, {
          input: packRevInput([sha], haves),
          stdoutTo: pipe,
          allowNonZero: true,
          timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
        }),
      (pipe) =>
        runHostGit(
          cfg,
          projectId,
          ["index-pack", "--stdin", "--fix-thin", "--strict"],
          { stdinFrom: pipe, timeoutMs: GIT_TRANSFER_TIMEOUT_MS },
        ),
    );
    if (!ok) {
      throw new ApiError(
        422,
        "the commit could not be read from the project repository",
        "git_error",
      );
    }
  }
  const type = await runHostGit(cfg, projectId, ["cat-file", "-t", sha]);
  if (type.code !== 0 || type.stdout.trim() !== "commit") {
    throw new ApiError(422, "the branch does not point at a commit", "git_error");
  }
  const connected = await runHostGit(cfg, projectId, [
    "rev-list",
    "--objects",
    "--quiet",
    sha,
    ...(tips.length > 0 ? ["--not", ...tips] : []),
  ]);
  if (connected.code !== 0) {
    throw new ApiError(
      422,
      "the commit's history is incomplete in the project repository",
      "git_error",
    );
  }
  await runHostGit(cfg, projectId, ["update-ref", "refs/veyra/outgoing", sha]);
}

/** Pack size in bytes currently stored in the mirror. */
export async function mirrorPackBytes(
  cfg: AppConfig,
  projectId: string,
): Promise<number> {
  const res = await runHostGit(cfg, projectId, ["count-objects", "-v"]);
  let kib = 0;
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(size|size-pack): (\d+)$/);
    if (m) kib += Number(m[2]);
  }
  return kib * 1024;
}
