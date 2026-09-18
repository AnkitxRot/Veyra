import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import { invalidateTreeCache } from "../files/service.js";
import {
  runGit,
  mapGitError,
  assertRepo,
  getCurrentBranch,
  getStatus,
  collectMutationBlockingPaths,
  isRepository,
  type GitStatus,
} from "./service.js";
import {
  validateHttpsGitRemoteUrl,
  httpsRemotesEquivalent,
  sanitizeRemoteUrlForClient,
} from "./remoteUrl.js";
import { redactGitOutput, firstRedactedLine } from "./redact.js";
import { GIT_TRANSFER_TIMEOUT_MS } from "./sandboxGit.js";
import {
  assertHostBranchName,
  deliverRemoteTracking,
  ensureMirror,
  importCommitFromSandbox,
  isObjectId,
  mirrorFetch,
  mirrorPackBytes,
  mirrorPush,
  REMOTE_TRACKING_PREFIX,
  type RemoteFailure,
  type TransportCreds,
} from "./transport.js";

/**
 * M80 HTTPS remotes (clone / fetch / fast-forward pull / push).
 *
 * M87: the network and the credentials stay on the host, inside the
 * project's server-owned transport mirror (`transport.ts`); the project
 * repository itself is only ever touched by sandbox Git. The origin URL is
 * read from the project repository (untrusted), re-validated as HTTPS, and
 * resolved once — inside the project lock — together with the credentials
 * pinned to its host.
 */

export const ORIGIN = "origin";

export type RemoteOpCreds = TransportCreds;

/** A remote operation's target, resolved once inside the project lock. */
export interface RemoteTarget {
  url: string;
  creds: RemoteOpCreds | null;
}

function mapRemoteGitError(
  err: any,
  secrets: string[] = [],
  hadCreds = false,
): ApiError {
  if (err instanceof ApiError && err.code !== "git_error") {
    if (err.message) {
      err.message = redactGitOutput(err.message, secrets);
    }
    return err;
  }
  const raw = String(err?.stderr ?? err?.message ?? "");
  const text = redactGitOutput(raw, secrets);
  // M87: HTTP statuses are matched in Git's own phrasing only; a bare "401"
  // also matched ephemeral ports and object ids in the remote line.
  if (
    /authentication failed|invalid username or password|returned error: 40[13]\b|403 forbidden|access denied|could not read username|terminal prompts disabled|authentication required/i.test(
      text,
    )
  ) {
    return new ApiError(
      401,
      hadCreds
        ? "authentication with the remote failed"
        : "this remote requires credentials",
      hadCreds ? "auth_failed" : "credentials_required",
    );
  }
  if (
    /repository not found|not found.*repository|remote: not found/i.test(text)
  ) {
    return new ApiError(404, "remote repository not found", "repository_not_found");
  }
  if (
    /could not resolve host|failed to connect|connection refused|unable to access|network is unreachable|timed out|ssl|tls/i.test(
      text,
    )
  ) {
    return new ApiError(
      502,
      "remote repository is unavailable",
      "remote_unavailable",
    );
  }
  if (
    /not possible to fast-forward|diverged|refusing to merge unrelated histories/i.test(
      text,
    )
  ) {
    return new ApiError(
      409,
      "local and remote branches have diverged",
      "branch_diverged",
    );
  }
  if (/non-fast-forward|failed to push some refs|\[rejected\]/i.test(text)) {
    return new ApiError(
      409,
      "push rejected — remote has commits you do not have (non-fast-forward)",
      "non_fast_forward",
    );
  }
  if (
    /would be overwritten|please commit your changes or stash|uncommitted changes/i.test(
      text,
    )
  ) {
    return new ApiError(
      409,
      "local changes would be overwritten",
      "dirty_worktree",
    );
  }
  if (err instanceof ApiError) return err;
  return mapGitError(err, secrets);
}

function remoteFailure(hadCreds: boolean): (f: RemoteFailure) => never {
  return (f) => {
    throw mapRemoteGitError(
      { stderr: f.stderr, message: f.stderr },
      f.secrets,
      hadCreds,
    );
  };
}

async function transport<T>(fn: () => Promise<T>, hadCreds: boolean): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapRemoteGitError(err, [], hadCreds);
  }
}

/**
 * Resolve origin (validated HTTPS) and the credentials pinned to its host.
 * Runs inside the project lock, so the URL the credentials were resolved for
 * is exactly the URL the host transport uses — a concurrent terminal
 * `git remote set-url` cannot redirect a resolved PAT.
 */
export async function resolveRemoteTarget(
  cfg: AppConfig,
  projectId: string,
  credsFor: (url: string) => RemoteOpCreds | null,
): Promise<RemoteTarget> {
  await assertRepo(cfg, projectId);
  const url = await requireOriginUrl(cfg, projectId);
  return { url, creds: credsFor(url) };
}

export async function getOriginUrl(
  cfg: AppConfig,
  projectId: string,
): Promise<string | null> {
  await assertRepo(cfg, projectId);
  const rem = await runGit(cfg, projectId, ["remote", "get-url", ORIGIN], {
    allowNonZero: true,
  });
  if (rem.code !== 0) return null;
  const raw = rem.stdout.trim();
  return raw ? sanitizeRemoteUrlForClient(raw) : null;
}

export async function addOriginRemote(
  cfg: AppConfig,
  projectId: string,
  rawUrl: unknown,
  opts: { replace?: boolean } = {},
): Promise<{ name: string; url: string; replaced: boolean }> {
  await assertRepo(cfg, projectId);
  const url = validateHttpsGitRemoteUrl(rawUrl);
  const existing = await runGit(cfg, projectId, ["remote", "get-url", ORIGIN], {
    allowNonZero: true,
  });
  if (existing.code === 0 && existing.stdout.trim()) {
    const current = existing.stdout.trim();
    if (httpsRemotesEquivalent(current, url)) {
      return { name: ORIGIN, url, replaced: false };
    }
    if (!opts.replace) {
      throw new ApiError(
        409,
        `origin already points to ${sanitizeRemoteUrlForClient(current)}`,
        "remote_exists",
        { existingUrl: sanitizeRemoteUrlForClient(current) },
      );
    }
    await runGit(cfg, projectId, ["remote", "set-url", ORIGIN, "--", url]);
    return { name: ORIGIN, url, replaced: true };
  }
  await runGit(cfg, projectId, ["remote", "add", ORIGIN, "--", url]);
  return { name: ORIGIN, url, replaced: false };
}

export async function cloneIntoProject(
  cfg: AppConfig,
  projectId: string,
  rawUrl: unknown,
  user: { username: string },
  creds: RemoteOpCreds | null,
): Promise<{ branch: string | null; remote: string }> {
  const url = validateHttpsGitRemoteUrl(rawUrl);
  const cwd = await workspacePath(cfg, projectId);
  const entries = await fs.readdir(cwd);
  if (entries.length > 0) {
    throw new ApiError(
      409,
      "destination project workspace is not empty",
      "workspace_not_empty",
    );
  }

  const hadCreds = Boolean(creds);
  const { headBranch } = await transport(
    () =>
      mirrorFetch(cfg, projectId, url, creds, remoteFailure(hadCreds), {
        fresh: true,
        readHead: true,
      }),
    hadCreds,
  );
  if ((await mirrorPackBytes(cfg, projectId)) > cfg.maxAggregateUploadBytes) {
    throw cloneTooLarge(cfg);
  }

  let defaultBranch = "main";
  if (headBranch) {
    try {
      defaultBranch = await assertHostBranchName(cfg, projectId, headBranch);
    } catch {
      // keep "main" for a remote HEAD Git itself would not accept
    }
  }

  await runGit(
    cfg,
    projectId,
    ["init", "-q", "--shared=world", "-b", defaultBranch],
    { noRepoEnv: true },
  );
  if (!(await isRepository(cfg, projectId))) {
    throw new ApiError(502, "clone did not produce a git repository", "git_error");
  }
  const { username } = user;
  await runGit(cfg, projectId, ["config", "user.name", username]);
  await runGit(cfg, projectId, [
    "config",
    "user.email",
    `${username}@veyra.local`,
  ]);
  await runGit(cfg, projectId, ["remote", "add", ORIGIN, "--", url]);

  const tips = await transport(
    () => deliverRemoteTracking(cfg, projectId),
    hadCreds,
  );
  if (tips.has(defaultBranch)) {
    const tracking = `${REMOTE_TRACKING_PREFIX}${defaultBranch}`;
    await runGit(
      cfg,
      projectId,
      ["checkout", "-q", "-B", defaultBranch, tracking, "--"],
      { timeoutMs: GIT_TRANSFER_TIMEOUT_MS },
    );
    await setUpstream(cfg, projectId, defaultBranch);
    await runGit(cfg, projectId, [
      "symbolic-ref",
      `${REMOTE_TRACKING_PREFIX}HEAD`,
      tracking,
    ]);
  }

  if ((await directorySize(cwd)) > cfg.maxAggregateUploadBytes) {
    throw cloneTooLarge(cfg);
  }

  const { branch } = await getCurrentBranch(cfg, projectId);
  invalidateTreeCache(cwd);
  return { branch, remote: url };
}

function cloneTooLarge(cfg: AppConfig): ApiError {
  return new ApiError(
    413,
    `cloned repository exceeds storage limit of ${cfg.maxAggregateUploadBytes} bytes`,
    "clone_too_large",
  );
}

/** What `git push --set-upstream` and `git clone` record for a branch. */
async function setUpstream(
  cfg: AppConfig,
  projectId: string,
  branch: string,
): Promise<void> {
  await runGit(cfg, projectId, ["config", `branch.${branch}.remote`, ORIGIN]);
  await runGit(cfg, projectId, [
    "config",
    `branch.${branch}.merge`,
    `refs/heads/${branch}`,
  ]);
}

async function fetchIntoProject(
  cfg: AppConfig,
  projectId: string,
  target: RemoteTarget,
): Promise<void> {
  const hadCreds = Boolean(target.creds);
  await transport(async () => {
    await mirrorFetch(
      cfg,
      projectId,
      target.url,
      target.creds,
      remoteFailure(hadCreds),
    );
    await deliverRemoteTracking(cfg, projectId);
  }, hadCreds);
}

export async function fetchOrigin(
  cfg: AppConfig,
  projectId: string,
  target: RemoteTarget,
): Promise<{ ok: true; remote: string }> {
  await assertRepo(cfg, projectId);
  await fetchIntoProject(cfg, projectId, target);
  return { ok: true, remote: target.url };
}

export type PullPreview =
  | {
      ok: false;
      conflict: true;
      blockingPaths: string[];
    }
  | {
      ok: true;
      alreadyUpToDate: boolean;
      branch: string;
      changedPaths: string[];
      remote: string;
    };

export async function previewPull(
  cfg: AppConfig,
  projectId: string,
  dirtyOpenPaths: unknown,
  target: RemoteTarget,
): Promise<PullPreview> {
  await assertRepo(cfg, projectId);
  const url = target.url;
  const { branch, detached } = await getCurrentBranch(cfg, projectId);
  if (detached || !branch) {
    throw new ApiError(
      409,
      "cannot pull in detached HEAD state",
      "detached_head",
    );
  }

  await fetchIntoProject(cfg, projectId, target);

  const remoteRef = `${ORIGIN}/${branch}`;
  const exists = await runGit(
    cfg,
    projectId,
    ["rev-parse", "--verify", "--quiet", remoteRef],
    { allowNonZero: true },
  );
  if (exists.code !== 0) {
    throw new ApiError(
      409,
      `no upstream branch ${remoteRef}`,
      "no_upstream",
    );
  }

  const headIsAncestor = await runGit(
    cfg,
    projectId,
    ["merge-base", "--is-ancestor", "HEAD", remoteRef],
    { allowNonZero: true },
  );
  const remoteIsAncestor = await runGit(
    cfg,
    projectId,
    ["merge-base", "--is-ancestor", remoteRef, "HEAD"],
    { allowNonZero: true },
  );

  if (headIsAncestor.code !== 0 && remoteIsAncestor.code !== 0) {
    throw new ApiError(
      409,
      "local and remote branches have diverged — pull is fast-forward only",
      "branch_diverged",
    );
  }

  if (headIsAncestor.code === 0 && remoteIsAncestor.code === 0) {
    return {
      ok: true,
      alreadyUpToDate: true,
      branch,
      changedPaths: [],
      remote: url,
    };
  }
  if (remoteIsAncestor.code === 0 && headIsAncestor.code !== 0) {
    // Local is ahead — pull has nothing to apply.
    return {
      ok: true,
      alreadyUpToDate: true,
      branch,
      changedPaths: [],
      remote: url,
    };
  }

  const changed = (
    await runGit(cfg, projectId, [
      "diff",
      "--name-only",
      "-z",
      "HEAD",
      remoteRef,
      "--",
    ])
  ).stdout
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

  const st: GitStatus = await getStatus(cfg, projectId);
  const blocking = collectMutationBlockingPaths(changed, st, dirtyOpenPaths);
  if (blocking.length > 0) {
    return { ok: false, conflict: true, blockingPaths: blocking };
  }

  return {
    ok: true,
    alreadyUpToDate: false,
    branch,
    changedPaths: [...changed].sort(),
    remote: url,
  };
}

export async function commitFastForwardPull(
  cfg: AppConfig,
  projectId: string,
  branch: string,
): Promise<void> {
  const remoteRef = `${ORIGIN}/${branch}`;
  const res = await runGit(
    cfg,
    projectId,
    ["merge", "--ff-only", "--no-stat", "--", remoteRef],
    { allowNonZero: true, timeoutMs: GIT_TRANSFER_TIMEOUT_MS },
  );
  if (res.code !== 0) {
    throw mapRemoteGitError({ stderr: res.stderr });
  }
}

export async function pushCurrentBranch(
  cfg: AppConfig,
  projectId: string,
  target: RemoteTarget,
): Promise<{ ok: true; branch: string; remote: string }> {
  await assertRepo(cfg, projectId);
  const { branch, detached } = await getCurrentBranch(cfg, projectId);
  if (detached || !branch) {
    throw new ApiError(
      409,
      "cannot push in detached HEAD state",
      "detached_head",
    );
  }
  const hadCreds = Boolean(target.creds);
  await transport(async () => {
    await ensureMirror(cfg, projectId, target.url);
    // The branch name comes from the project repository: validate it on the
    // host before it becomes part of a host refspec.
    const name = await assertHostBranchName(cfg, projectId, branch);
    const rev = await runGit(
      cfg,
      projectId,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`],
      { allowNonZero: true },
    );
    const sha = rev.stdout.trim();
    if (rev.code !== 0 || !isObjectId(sha)) {
      throw new ApiError(400, "repository has no commits yet", "no_commits");
    }
    await importCommitFromSandbox(cfg, projectId, sha);
    await mirrorPush(
      cfg,
      projectId,
      target.url,
      target.creds,
      sha,
      name,
      remoteFailure(hadCreds),
    );
    await runGit(cfg, projectId, [
      "update-ref",
      `${REMOTE_TRACKING_PREFIX}${name}`,
      sha,
    ]);
    await setUpstream(cfg, projectId, name);
  }, hadCreds);
  return { ok: true, branch, remote: target.url };
}

export async function requireOriginUrl(
  cfg: AppConfig,
  projectId: string,
): Promise<string> {
  const rem = await runGit(cfg, projectId, ["remote", "get-url", ORIGIN], {
    allowNonZero: true,
  });
  if (rem.code !== 0 || !rem.stdout.trim()) {
    throw new ApiError(
      409,
      "no HTTPS remote is configured (origin)",
      "no_remote",
    );
  }
  const raw = rem.stdout.trim();
  // Re-validate so a terminal-set ssh/file remote cannot be used.
  try {
    return validateHttpsGitRemoteUrl(raw);
  } catch (err) {
    if (err instanceof ApiError && err.code === "credential_bearing_url") {
      throw new ApiError(
        409,
        "the configured origin URL contains credentials; replace it with a plain HTTPS URL",
        "credential_bearing_url",
      );
    }
    throw new ApiError(
      409,
      "origin is not a valid HTTPS remote",
      "invalid_remote_url",
    );
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    // Dirent types come from lstat semantics: symlinks are neither.
    if (entry.isDirectory()) {
      total += await directorySize(p);
    } else if (entry.isFile()) {
      try {
        total += (await fs.lstat(p)).size;
      } catch {
        // ignore
      }
    }
  }
  return total;
}

/** Exported for error-path tests that inspect redaction. */
export function _redactRemoteTextForTests(
  text: string,
  secrets: string[],
): string {
  return firstRedactedLine(text, secrets);
}
