import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { IS_WINDOWS } from "../config.js";
import { projectDir, workspacePath } from "../projects/service.js";
import { firstRedactedLine } from "./redact.js";
import {
  containsAsciiControlChars,
  sanitizeRemoteUrlForClient,
} from "./remoteUrl.js";

const execFileAsync = promisify(execFile);

/**
 * M51 — first-class local Git version control, one repository per project at
 * `<workspacePath>/.git`.
 *
 * Every operation here shells out to the real `git` binary via `execFile`
 * (never a shell), against a cwd resolved **only** from the server's trusted
 * project lookup — the client never supplies a path, a `--git-dir`, a
 * `--work-tree`, a `-c`, a config path, or an executable.
 *
 * Safety envelope applied to every invocation (see `runGit`):
 *  - argv array, no shell, bounded timeout + output buffer, `windowsHide`;
 *  - a sanitized environment: no system/global/user git config, no
 *    credential helpers, no transport protocols, no interactive prompts;
 *  - `core.hooksPath` forced to a server-owned empty directory, so a hook
 *    committed into `.git/hooks` can never execute on this process;
 *  - client-provided branch names validated by git's own
 *    `check-ref-format --branch`; client pathspecs normalized, `--`-guarded,
 *    and rejected if absolute / traversing / targeting `.git` internals /
 *    option-like.
 */

const GIT_TIMEOUT_MS = 15_000;
export const GIT_REMOTE_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 12 * 1024 * 1024;
const LOG_DEFAULT_LIMIT = 50;
const LOG_MAX_LIMIT = 200;
const MAX_COMMIT_MESSAGE = 20_000;
const MAX_BRANCH_NAME = 240;
const MAX_PATHS_PER_CALL = 2000;
const MAX_FILE_DIFF_LINES = 4000;

const US = "\x1f"; // unit separator for --pretty / for-each-ref fields

// ---------------------------------------------------------------------------
// Environment + base arguments
// ---------------------------------------------------------------------------

let noHooksDirPromise: Promise<string> | null = null;
async function ensureNoHooksDir(cfg: AppConfig): Promise<string> {
  if (!noHooksDirPromise) {
    noHooksDirPromise = (async () => {
      const d = join(cfg.dataDir, ".git-no-hooks");
      await fs.mkdir(d, { recursive: true });
      return d;
    })().catch((err) => {
      noHooksDirPromise = null;
      throw err;
    });
  }
  return noHooksDirPromise;
}

function gitEnv(
  isolatedHome: string,
  opts: {
    allowHttps?: boolean;
    extraEnv?: NodeJS.ProcessEnv;
    sslCaInfo?: string;
  } = {},
): NodeJS.ProcessEnv {
  const devNull = IS_WINDOWS ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {
    // `git` must still be found on PATH.
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot, // Windows: git needs this to run
    // Hard isolation from any ambient / user configuration.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: IS_WINDOWS ? "cmd /c exit 1" : "true",
    GIT_PAGER: "cat",
    // No `~/.gitconfig`, no `~/.git-credentials`.
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    LANG: "C",
    LC_ALL: "C",
    ...(opts.extraEnv ?? {}),
  };
  // Protocol isolation is not overridable via extraEnv: local operations stay
  // transport-less; remote operations may enable HTTPS and nothing else.
  env.GIT_ALLOW_PROTOCOL = opts.allowHttps ? "https" : "";
  if (opts.allowHttps && opts.sslCaInfo) {
    env.GIT_SSL_CAINFO = opts.sslCaInfo;
    env.SSL_CERT_FILE = opts.sslCaInfo;
  }
  return env;
}

function baseArgs(hooksDir: string): string[] {
  return [
    "-c",
    `core.hooksPath=${hooksDir}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "gc.auto=0",
    "-c",
    "advice.detachedHead=false",
  ];
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function gitCwd(cfg: AppConfig, projectId: string): Promise<string> {
  // Trusted lookup only. `workspacePath` throws 404 if the directory is gone.
  return workspacePath(cfg, projectId);
}

export function mapGitError(err: any, secrets: string[] = []): ApiError {
  const raw = String(err?.stderr ?? err?.message ?? "");
  const blob = firstRedactedLine(raw, secrets).slice(0, 800);

  if (/not a git repository/i.test(raw)) {
    return new ApiError(409, "not a git repository", "not_a_repo");
  }
  if (
    /would be overwritten by checkout|would be overwritten by merge|Please commit your changes or stash/i.test(
      raw,
    )
  ) {
    return new ApiError(
      409,
      "local changes would be overwritten",
      "checkout_conflict",
    );
  }
  if (/not fully merged/i.test(raw)) {
    return new ApiError(409, "branch is not fully merged", "branch_not_merged");
  }
  if (
    /does not have any commits yet|bad (revision|default revision) '?HEAD'?|ambiguous argument 'HEAD'|unknown revision/i.test(
      raw,
    )
  ) {
    return new ApiError(400, "repository has no commits yet", "no_commits");
  }
  if (/already exists/i.test(raw) && /branch/i.test(raw)) {
    return new ApiError(409, "branch already exists", "branch_exists");
  }
  return new ApiError(422, `git: ${blob}`, "git_error");
}

export interface RunGitOpts {
  allowNonZero?: boolean;
  input?: string;
  /** Remote HTTPS operations only. Default remains no-protocol. */
  allowHttps?: boolean;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  /** Values to strip from mapped errors (tokens, usernames). */
  redact?: string[];
}

const capturedGitArgv: string[][] = [];

/** Test-only: drain argv recorded by `runGit` (never includes env values). */
export function _takeCapturedGitArgvForTests(): string[][] {
  return capturedGitArgv.splice(0);
}

export async function runGit(
  cfg: AppConfig,
  projectId: string,
  args: string[],
  opts: RunGitOpts = {},
): Promise<GitResult> {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) {
      throw new ApiError(400, "invalid git argument", "invalid_git_arg");
    }
  }
  const cwd = await gitCwd(cfg, projectId);
  const hooksDir = await ensureNoHooksDir(cfg);
  const argv = [...baseArgs(hooksDir), ...args];
  capturedGitArgv.push([...argv]);

  try {
    const child = execFileAsync("git", argv, {
      cwd,
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(hooksDir, {
        allowHttps: opts.allowHttps === true,
        extraEnv: opts.extraEnv,
        sslCaInfo: cfg.gitSslCaInfo,
      }),
      windowsHide: true,
      encoding: "utf8" as const,
    });
    if (opts.input !== undefined && child.child.stdin) {
      child.child.stdin.end(opts.input);
    }
    const { stdout, stderr } = await child;
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new ApiError(
        500,
        "git is not available on this server",
        "git_unavailable",
      );
    }
    if (err?.killed || err?.signal === "SIGTERM") {
      throw new ApiError(504, "git operation timed out", "git_timeout");
    }
    if (typeof err?.message === "string" && err.message.includes("maxBuffer")) {
      throw new ApiError(413, "git output too large", "git_output_too_large");
    }
    if (opts.allowNonZero && typeof err?.code === "number") {
      return {
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? ""),
        code: err.code,
      };
    }
    throw mapGitError(err, opts.redact);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Normalize a client pathspec to a workspace-relative POSIX path, rejecting
 *  anything unsafe. The result is always safe to pass to git after `--`. */
export function normalizePathspec(p: unknown): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) {
    throw new ApiError(400, "invalid path", "invalid_path");
  }
  if (p.includes("\0")) throw new ApiError(400, "invalid path", "invalid_path");
  // Reject absolute paths outright — never silently relativize them.
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[/\\]/.test(p)) {
    throw new ApiError(400, "absolute paths are not allowed", "invalid_path");
  }
  const norm = p.replace(/\\/g, "/");
  if (norm.length === 0 || norm.startsWith("-") || norm.startsWith("/")) {
    throw new ApiError(400, "invalid path", "invalid_path");
  }
  const parts = norm.split("/");
  if (parts.some((s) => s === "..")) {
    throw new ApiError(400, "path escapes the workspace", "invalid_path");
  }
  if (parts[0] === ".git") {
    throw new ApiError(400, "cannot operate on .git internals", "invalid_path");
  }
  return norm;
}

function normalizePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    throw new ApiError(400, "paths must be an array", "invalid_path");
  }
  if (paths.length > MAX_PATHS_PER_CALL) {
    throw new ApiError(400, "too many paths in one request", "too_many_paths");
  }
  return paths.map(normalizePathspec);
}

async function assertValidBranchName(
  cfg: AppConfig,
  projectId: string,
  name: unknown,
): Promise<string> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_BRANCH_NAME
  ) {
    throw new ApiError(400, "invalid branch name", "invalid_branch_name");
  }
  if (containsAsciiControlChars(name) || name.startsWith("-")) {
    throw new ApiError(400, "invalid branch name", "invalid_branch_name");
  }
  // Git's own grammar is the authoritative check.
  const res = await runGit(
    cfg,
    projectId,
    ["check-ref-format", "--branch", name],
    { allowNonZero: true },
  );
  if (res.code !== 0 || res.stdout.trim() !== name) {
    throw new ApiError(400, "invalid branch name", "invalid_branch_name");
  }
  return name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitFileEntry {
  path: string;
  /** index (staged) status char: M A D R C or space */
  index: string;
  /** worktree (unstaged) status char: M D ? or space */
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  origPath?: string;
}

export interface GitRemoteInfo {
  name: string;
  url: string;
}

export interface GitStatus {
  initialized: boolean;
  branch: string | null;
  detached: boolean;
  hasCommits: boolean;
  clean: boolean;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  remote: GitRemoteInfo | null;
}

export interface GitDiffStatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitDiffLine {
  type: "add" | "del" | "context" | "meta";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}

export interface GitFileDiff {
  path: string;
  staged: boolean;
  binary: boolean;
  truncated: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: GitDiffHunk[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  shortHash: string | null;
  unborn: boolean;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function isRepository(
  cfg: AppConfig,
  projectId: string,
): Promise<boolean> {
  const cwd = projectDir(cfg, projectId);
  try {
    const st = await fs.stat(join(cwd, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function initRepository(
  cfg: AppConfig,
  projectId: string,
  user: { username: string },
): Promise<{ initialized: boolean; alreadyRepo: boolean; branch: string }> {
  if (await isRepository(cfg, projectId)) {
    const branch = (await getCurrentBranch(cfg, projectId)).branch ?? "main";
    return { initialized: false, alreadyRepo: true, branch };
  }

  try {
    await runGit(cfg, projectId, ["init", "-b", "main"]);
  } catch {
    // Older git without `-b`: fall back and rename the unborn branch.
    await runGit(cfg, projectId, ["init"]);
    await runGit(cfg, projectId, ["symbolic-ref", "HEAD", "refs/heads/main"], {
      allowNonZero: true,
    });
  }

  const { username } = user;
  await runGit(cfg, projectId, ["config", "user.name", username]);
  await runGit(cfg, projectId, [
    "config",
    "user.email",
    `${username}@veyra.local`,
  ]);

  if (!IS_WINDOWS) {
    // The backend process and the sandbox `ide` user (which runs the
    // terminal git) may differ in uid on some hosts; make the object store
    // group/other accessible so both can operate on the same repository.
    await runGit(cfg, projectId, ["config", "core.sharedRepository", "world"], {
      allowNonZero: true,
    });
    try {
      const cwd = await gitCwd(cfg, projectId);
      await execFileAsync("chmod", ["-R", "a+rwX", join(cwd, ".git")], {
        timeout: 5000,
      });
    } catch {
      // best-effort
    }
  }

  const branch = (await getCurrentBranch(cfg, projectId)).branch ?? "main";
  return { initialized: true, alreadyRepo: false, branch };
}

export async function getCurrentBranch(
  cfg: AppConfig,
  projectId: string,
): Promise<{ branch: string | null; detached: boolean }> {
  const res = await runGit(
    cfg,
    projectId,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowNonZero: true },
  );
  if (res.code === 0) {
    return { branch: res.stdout.trim() || null, detached: false };
  }
  // Detached HEAD (or unborn without symbolic-ref, which shouldn't happen
  // after init). Report the short hash as the "branch" label.
  const head = await runGit(cfg, projectId, ["rev-parse", "--short", "HEAD"], {
    allowNonZero: true,
  });
  return {
    branch: head.code === 0 ? head.stdout.trim() : null,
    detached: head.code === 0,
  };
}

export async function hasCommits(cfg: AppConfig, projectId: string): Promise<boolean> {
  const res = await runGit(
    cfg,
    projectId,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    { allowNonZero: true },
  );
  return res.code === 0;
}

function classifyEntry(
  index: string,
  worktree: string,
  path: string,
): {
  staged: GitFileEntry | null;
  unstaged: GitFileEntry | null;
} {
  const untracked = index === "?";
  const base = { path, index, worktree, untracked };
  const staged: GitFileEntry | null =
    !untracked && index !== " "
      ? { ...base, staged: true, unstaged: false }
      : null;
  const unstaged: GitFileEntry | null =
    untracked || worktree !== " "
      ? { ...base, staged: false, unstaged: true }
      : null;
  return { staged, unstaged };
}

export async function getStatus(
  cfg: AppConfig,
  projectId: string,
): Promise<GitStatus> {
  if (!(await isRepository(cfg, projectId))) {
    return {
      initialized: false,
      branch: null,
      detached: false,
      hasCommits: false,
      clean: true,
      staged: [],
      unstaged: [],
      remote: null,
    };
  }

  const { branch, detached } = await getCurrentBranch(cfg, projectId);
  const committed = await hasCommits(cfg, projectId);

  const res = await runGit(cfg, projectId, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);

  const tokens = res.stdout.split("\0");
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    const index = rec[0];
    const worktree = rec[1];
    let path = rec.slice(3);
    let origPath: string | undefined;
    if (
      index === "R" ||
      index === "C" ||
      worktree === "R" ||
      worktree === "C"
    ) {
      // Rename/copy: the ORIGINAL path is the next NUL-delimited token.
      origPath = tokens[i + 1] ?? undefined;
      i++;
    }
    // Normalize any accidental backslashes for display consistency.
    path = path.replace(/\\/g, "/");

    const { staged: s, unstaged: u } = classifyEntry(index, worktree, path);
    if (s) {
      staged.push(origPath ? { ...s, origPath } : s);
    }
    if (u) {
      unstaged.push(origPath ? { ...u, origPath } : u);
    }
  }

  return {
    initialized: true,
    branch,
    detached,
    hasCommits: committed,
    clean: staged.length === 0 && unstaged.length === 0,
    staged,
    unstaged,
    remote: await readOriginRemote(cfg, projectId),
  };
}

async function readOriginRemote(
  cfg: AppConfig,
  projectId: string,
): Promise<GitRemoteInfo | null> {
  const rem = await runGit(cfg, projectId, ["remote", "get-url", "origin"], {
    allowNonZero: true,
  });
  if (rem.code !== 0) return null;
  const raw = rem.stdout.trim();
  if (!raw) return null;
  return { name: "origin", url: sanitizeRemoteUrlForClient(raw) };
}

export async function getDiffStat(
  cfg: AppConfig,
  projectId: string,
  staged: boolean,
): Promise<GitDiffStatEntry[]> {
  await assertRepo(cfg, projectId);
  const args = ["diff", "--numstat", "-z"];
  if (staged) args.push("--cached");
  args.push("--", ".");
  const res = await runGit(cfg, projectId, args);
  const parts = res.stdout.split("\0").filter(Boolean);
  const out: GitDiffStatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    const m = line.match(/^(\S+)\t(\S+)\t(.*)$/);
    if (!m) continue;
    let path = m[3];
    // `--numstat -z` emits `\t` between counts and, for renames, the path
    // field is empty followed by two NUL tokens (old, new).
    if (path === "") {
      const oldP = parts[i + 1];
      const newP = parts[i + 2];
      i += 2;
      path = newP ?? oldP ?? "";
    }
    out.push({
      path: path.replace(/\\/g, "/"),
      additions: m[1] === "-" ? 0 : parseInt(m[1], 10) || 0,
      deletions: m[2] === "-" ? 0 : parseInt(m[2], 10) || 0,
      binary: m[1] === "-" && m[2] === "-",
    });
  }
  return out;
}

export async function getFileDiff(
  cfg: AppConfig,
  projectId: string,
  rawPath: string,
  staged: boolean,
): Promise<GitFileDiff> {
  await assertRepo(cfg, projectId);
  const path = normalizePathspec(rawPath);

  // An untracked file is invisible to `git diff` — show its full content as
  // an addition (matching how editors present a brand-new file).
  if (!staged) {
    const tracked = await runGit(
      cfg,
      projectId,
      ["ls-files", "--error-unmatch", "--", path],
      { allowNonZero: true },
    );
    if (tracked.code !== 0) {
      const res = await runGit(
        cfg,
        projectId,
        [
          "diff",
          "--no-color",
          "-U3",
          "--no-index",
          "--",
          IS_WINDOWS ? "NUL" : "/dev/null",
          path,
        ],
        { allowNonZero: true },
      );
      const parsed = parseUnifiedDiff(path, false, res.stdout);
      parsed.isNew = true;
      return parsed;
    }
  }

  const args = ["diff", "--no-color", "-U3"];
  if (staged) args.push("--cached");
  args.push("--", path);
  const res = await runGit(cfg, projectId, args);
  return parseUnifiedDiff(path, staged, res.stdout);
}

function parseUnifiedDiff(
  path: string,
  staged: boolean,
  raw: string,
): GitFileDiff {
  const lines = raw.split("\n");
  const hunks: GitDiffHunk[] = [];
  let binary = false;
  let isNew = false;
  let isDeleted = false;
  let truncated = false;
  let current: GitDiffHunk | null = null;
  let oldLn = 0;
  let newLn = 0;
  let emitted = 0;

  for (const line of lines) {
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      binary = true;
      continue;
    }
    if (line.startsWith("new file mode")) isNew = true;
    if (line.startsWith("deleted file mode")) isDeleted = true;
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLn = m ? parseInt(m[1], 10) : 0;
      newLn = m ? parseInt(m[2], 10) : 0;
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (emitted >= MAX_FILE_DIFF_LINES) {
      truncated = true;
      break;
    }
    if (line.startsWith("+")) {
      current.lines.push({
        type: "add",
        content: line.slice(1),
        oldLine: null,
        newLine: newLn++,
      });
      emitted++;
    } else if (line.startsWith("-")) {
      current.lines.push({
        type: "del",
        content: line.slice(1),
        oldLine: oldLn++,
        newLine: null,
      });
      emitted++;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        type: "context",
        content: line.slice(1),
        oldLine: oldLn++,
        newLine: newLn++,
      });
      emitted++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      current.lines.push({
        type: "meta",
        content: line.slice(2),
        oldLine: null,
        newLine: null,
      });
    }
  }

  return { path, staged, binary, truncated, isNew, isDeleted, hunks };
}

export async function stage(
  cfg: AppConfig,
  projectId: string,
  opts: { paths?: unknown; all?: boolean },
): Promise<void> {
  await assertRepo(cfg, projectId);
  if (opts.all) {
    await runGit(cfg, projectId, ["add", "-A", "--", "."]);
    return;
  }
  const paths = normalizePaths(opts.paths);
  if (paths.length === 0) {
    throw new ApiError(400, "no paths to stage", "invalid_path");
  }
  await runGit(cfg, projectId, ["add", "--", ...paths]);
}

export async function unstage(
  cfg: AppConfig,
  projectId: string,
  opts: { paths?: unknown; all?: boolean },
): Promise<void> {
  await assertRepo(cfg, projectId);
  const target = opts.all ? ["."] : normalizePaths(opts.paths);
  if (target.length === 0) {
    throw new ApiError(400, "no paths to unstage", "invalid_path");
  }
  if (await hasCommits(cfg, projectId)) {
    await runGit(cfg, projectId, ["reset", "-q", "HEAD", "--", ...target]);
  } else {
    // No HEAD yet: "unstage" means remove the entry from the index entirely.
    await runGit(
      cfg,
      projectId,
      ["rm", "--cached", "-r", "-q", "--", ...target],
      {
        allowNonZero: true,
      },
    );
  }
}

export async function commit(
  cfg: AppConfig,
  projectId: string,
  rawMessage: unknown,
  user: { username: string },
): Promise<{ hash: string; shortHash: string; subject: string }> {
  await assertRepo(cfg, projectId);
  if (typeof rawMessage !== "string") {
    throw new ApiError(400, "commit message is required", "invalid_message");
  }
  const message = rawMessage.replace(/\0/g, "").trim();
  if (message.length === 0) {
    throw new ApiError(400, "commit message is required", "invalid_message");
  }
  if (message.length > MAX_COMMIT_MESSAGE) {
    throw new ApiError(400, "commit message is too long", "message_too_long");
  }

  // Nothing staged?  `diff --cached --quiet` exits 0 when the index matches
  // HEAD (or, with no commits, when the index is empty).
  const staged = await runGit(cfg, projectId, ["diff", "--cached", "--quiet"], {
    allowNonZero: true,
  });
  if (staged.code === 0) {
    throw new ApiError(400, "nothing staged to commit", "nothing_to_commit");
  }

  const { username } = user;
  await runGit(cfg, projectId, [
    "-c",
    `user.name=${username}`,
    "-c",
    `user.email=${username}@veyra.local`,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    message,
  ]);

  const hashRes = await runGit(cfg, projectId, ["rev-parse", "HEAD"]);
  const shortRes = await runGit(cfg, projectId, [
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  return {
    hash: hashRes.stdout.trim(),
    shortHash: shortRes.stdout.trim(),
    subject: message.split("\n")[0].slice(0, 200),
  };
}

export async function getLog(
  cfg: AppConfig,
  projectId: string,
  limit?: number,
): Promise<GitCommit[]> {
  await assertRepo(cfg, projectId);
  const n = Math.max(
    1,
    Math.min(
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.floor(limit)
        : LOG_DEFAULT_LIMIT,
      LOG_MAX_LIMIT,
    ),
  );
  const res = await runGit(
    cfg,
    projectId,
    [
      "log",
      "-z",
      "--no-color",
      `--max-count=${n}`,
      `--pretty=format:%H${US}%h${US}%an${US}%ae${US}%aI${US}%s`,
    ],
    { allowNonZero: true },
  );
  if (res.code !== 0) {
    // "does not have any commits yet"
    return [];
  }
  return res.stdout
    .split("\0")
    .filter(Boolean)
    .map((rec) => {
      const [hash, shortHash, author, email, date, ...rest] = rec.split(US);
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        author: author ?? "",
        email: email ?? "",
        date: date ?? "",
        subject: (rest.join(US) ?? "").replace(/\n/g, " "),
      };
    })
    .filter((c) => c.hash);
}

export async function getCommitFiles(
  cfg: AppConfig,
  projectId: string,
  hash: unknown,
): Promise<Array<{ status: string; path: string }>> {
  await assertRepo(cfg, projectId);
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    throw new ApiError(400, "invalid commit hash", "invalid_hash");
  }
  const res = await runGit(cfg, projectId, [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    hash,
  ]);
  const parts = res.stdout.split("\0").filter(Boolean);
  const out: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      out.push({
        status: status[0],
        path: (parts[i + 2] ?? "").replace(/\\/g, "/"),
      });
      i += 2;
    } else {
      out.push({
        status: status[0],
        path: (parts[i + 1] ?? "").replace(/\\/g, "/"),
      });
      i += 1;
    }
  }
  return out;
}

export async function listBranches(
  cfg: AppConfig,
  projectId: string,
): Promise<{ current: string | null; branches: GitBranch[] }> {
  await assertRepo(cfg, projectId);
  const { branch: current } = await getCurrentBranch(cfg, projectId);
  // `for-each-ref` has no `-z`; branch names cannot contain a newline, so a
  // newline-delimited format is unambiguous.
  const res = await runGit(cfg, projectId, [
    "for-each-ref",
    `--format=%(refname:short)${US}%(objectname:short)`,
    "refs/heads",
  ]);
  const branches: GitBranch[] = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((rec) => {
      const [name, short] = rec.split(US);
      return {
        name,
        current: name === current,
        shortHash: short || null,
        unborn: false,
      };
    });
  // A freshly-initialized repo has an unborn current branch with no ref yet.
  if (current && !branches.some((b) => b.name === current)) {
    branches.unshift({
      name: current,
      current: true,
      shortHash: null,
      unborn: true,
    });
  }
  branches.sort((a, b) =>
    a.current === b.current ? a.name.localeCompare(b.name) : a.current ? -1 : 1,
  );
  return { current, branches };
}

export async function createBranch(
  cfg: AppConfig,
  projectId: string,
  name: unknown,
): Promise<{ name: string }> {
  await assertRepo(cfg, projectId);
  const branchName = await assertValidBranchName(cfg, projectId, name);
  if (!(await hasCommits(cfg, projectId))) {
    throw new ApiError(
      400,
      "make at least one commit before creating a branch",
      "no_commits",
    );
  }
  const res = await runGit(cfg, projectId, ["branch", "--", branchName], {
    allowNonZero: true,
  });
  if (res.code !== 0) {
    if (/already exists/i.test(res.stderr)) {
      throw new ApiError(409, "branch already exists", "branch_exists");
    }
    throw mapGitError({ stderr: res.stderr });
  }
  return { name: branchName };
}

export async function checkoutBranch(
  cfg: AppConfig,
  projectId: string,
  name: unknown,
  dirtyOpenPaths: unknown,
  opts?: { preview?: boolean },
): Promise<
  | { ok: true; branch: string; changedPaths: string[] }
  | { ok: false; conflict: true; blockingPaths: string[] }
> {
  await assertRepo(cfg, projectId);
  const branchName = await assertValidBranchName(cfg, projectId, name);

  const exists = await runGit(
    cfg,
    projectId,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
    { allowNonZero: true },
  );
  if (exists.code !== 0) {
    throw new ApiError(404, "branch not found", "branch_not_found");
  }

  const { branch: currentBranch } = await getCurrentBranch(cfg, projectId);
  if (currentBranch === branchName) {
    return { ok: true, branch: branchName, changedPaths: [] };
  }

  // Files that differ between HEAD and the target branch — a checkout would
  // change these on disk.
  const changed = new Set(
    (
      await runGit(cfg, projectId, [
        "diff",
        "--name-only",
        "-z",
        "HEAD",
        branchName,
        "--",
      ])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, "/")),
  );

  // A checkout must not clobber uncommitted work. Two sources of "dirty",
  // both authoritative for a *different* reason:
  //  - git's own worktree/index modifications — git itself refuses these;
  //  - the caller's open editor buffers with genuinely unsaved edits
  //    (content not yet written to disk, so git can't see them) — captured
  //    by the client BEFORE the checkout request, so a switch that would
  //    overwrite one of those files on disk is rejected rather than
  //    orphaning the editor buffer.
  const st = await getStatus(cfg, projectId);

  const blocking = collectMutationBlockingPaths(
    [...changed],
    st,
    dirtyOpenPaths,
  );

  if (blocking.length > 0) {
    return { ok: false, conflict: true, blockingPaths: blocking };
  }

  // M56: preview mode computes the change set + runs the initiator dirty
  // check without switching branches, so the route can consult live
  // collaboration state before committing to the checkout.
  if (opts?.preview) {
    return { ok: true, branch: branchName, changedPaths: [...changed].sort() };
  }

  await runGit(cfg, projectId, ["checkout", branchName, "--"]);
  return { ok: true, branch: branchName, changedPaths: [...changed].sort() };
}

export async function deleteBranch(
  cfg: AppConfig,
  projectId: string,
  name: unknown,
  force: boolean,
): Promise<{ name: string; forced: boolean }> {
  await assertRepo(cfg, projectId);
  const branchName = await assertValidBranchName(cfg, projectId, name);
  const { branch: current } = await getCurrentBranch(cfg, projectId);
  if (current === branchName) {
    throw new ApiError(
      409,
      "cannot delete the current branch",
      "cannot_delete_current",
    );
  }
  const res = await runGit(
    cfg,
    projectId,
    ["branch", force ? "-D" : "-d", "--", branchName],
    { allowNonZero: true },
  );
  if (res.code !== 0) {
    if (/not found|does not exist/i.test(res.stderr)) {
      throw new ApiError(404, "branch not found", "branch_not_found");
    }
    if (/not fully merged/i.test(res.stderr)) {
      throw new ApiError(
        409,
        "branch is not fully merged — deletion requires force",
        "branch_not_merged",
      );
    }
    throw mapGitError({ stderr: res.stderr });
  }
  return { name: branchName, forced: force };
}

/**
 * Shared M56-style dirty-buffer gate: a disk-mutating Git operation may not
 * overwrite a path that is worktree/index dirty or listed in the initiator's
 * unsaved editor buffers.
 */
export function collectMutationBlockingPaths(
  changedPaths: string[],
  status: GitStatus,
  dirtyOpenPaths: unknown,
): string[] {
  const worktreeDirty = new Set<string>();
  for (const f of [...status.staged, ...status.unstaged]) {
    worktreeDirty.add(f.path);
    if (f.origPath) worktreeDirty.add(f.origPath);
  }
  const clientDirty = new Set(
    Array.isArray(dirtyOpenPaths)
      ? (dirtyOpenPaths as unknown[]).flatMap((raw) => {
          try {
            return [normalizePathspec(raw)];
          } catch {
            return [];
          }
        })
      : [],
  );
  return [...new Set(changedPaths)]
    .filter((p) => worktreeDirty.has(p) || clientDirty.has(p))
    .sort();
}

export async function assertRepo(cfg: AppConfig, projectId: string): Promise<void> {
  if (!(await isRepository(cfg, projectId))) {
    throw new ApiError(
      409,
      "this project is not a git repository yet",
      "not_a_repo",
    );
  }
}
