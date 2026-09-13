import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import {
  runGit,
  mapGitError,
  assertRepo,
  getCurrentBranch,
  getStatus,
  collectMutationBlockingPaths,
  isRepository,
  GIT_REMOTE_TIMEOUT_MS,
  type GitStatus,
} from "./service.js";
import {
  validateHttpsGitRemoteUrl,
  httpsRemoteHost,
  httpsRemotesEquivalent,
  sanitizeRemoteUrlForClient,
} from "./remoteUrl.js";
import { redactGitOutput, firstRedactedLine } from "./redact.js";
import { withGitAskpass, type GitAskpassCreds } from "./askpass.js";

export const ORIGIN = "origin";

const REMOTE_BASE_ARGS = ["-c", "credential.helper="];

export interface RemoteOpCreds {
  username: string;
  token: string;
}

function askpassCreds(
  url: string,
  creds: RemoteOpCreds | null,
): GitAskpassCreds | null {
  if (!creds) return null;
  return {
    username: creds.username,
    token: creds.token,
    host: httpsRemoteHost(url),
  };
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
  if (
    /authentication failed|invalid username or password|401|403 forbidden|access denied|could not read username|terminal prompts disabled|authentication required/i.test(
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
  if (/non-fast-forward|failed to push some refs/i.test(text)) {
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
  return mapGitError(err, secrets);
}

async function runRemoteGit(
  cfg: AppConfig,
  projectId: string,
  args: string[],
  opts: {
    creds: RemoteOpCreds | null;
    urlForHost: string;
    allowNonZero?: boolean;
  },
) {
  return withGitAskpass(cfg, askpassCreds(opts.urlForHost, opts.creds), async (s) => {
    try {
      const raw = await runGit(
        cfg,
        projectId,
        [...REMOTE_BASE_ARGS, ...args],
        {
          allowHttps: true,
          timeoutMs: GIT_REMOTE_TIMEOUT_MS,
          extraEnv: s.extraEnv,
          redact: s.secrets,
          allowNonZero: true,
        },
      );
      const res = {
        ...raw,
        stdout: redactGitOutput(raw.stdout, s.secrets),
        stderr: redactGitOutput(raw.stderr, s.secrets),
      };
      if (res.code !== 0 && !opts.allowNonZero) {
        throw mapRemoteGitError(
          { stderr: res.stderr, message: res.stderr },
          s.secrets,
          Boolean(opts.creds),
        );
      }
      return res;
    } catch (err) {
      throw mapRemoteGitError(err, s.secrets, Boolean(opts.creds));
    }
  });
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

  await runRemoteGit(cfg, projectId, ["clone", "--", url, "."], {
    creds,
    urlForHost: url,
  });

  if (!(await isRepository(cfg, projectId))) {
    throw new ApiError(502, "clone did not produce a git repository", "git_error");
  }

  const size = await directorySize(cwd);
  if (size > cfg.maxAggregateUploadBytes) {
    throw new ApiError(
      413,
      `cloned repository exceeds storage limit of ${cfg.maxAggregateUploadBytes} bytes`,
      "clone_too_large",
    );
  }

  const { username } = user;
  await runGit(cfg, projectId, ["config", "user.name", username], {
    allowNonZero: true,
  });
  await runGit(
    cfg,
    projectId,
    ["config", "user.email", `${username}@veyra.local`],
    { allowNonZero: true },
  );

  const { branch } = await getCurrentBranch(cfg, projectId);
  return { branch, remote: url };
}

export async function fetchOrigin(
  cfg: AppConfig,
  projectId: string,
  creds: RemoteOpCreds | null,
): Promise<{ ok: true; remote: string }> {
  await assertRepo(cfg, projectId);
  const url = await requireOriginUrl(cfg, projectId);
  await runRemoteGit(cfg, projectId, ["fetch", "--", ORIGIN], {
    creds,
    urlForHost: url,
  });
  return { ok: true, remote: url };
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
  creds: RemoteOpCreds | null,
): Promise<PullPreview> {
  await assertRepo(cfg, projectId);
  const url = await requireOriginUrl(cfg, projectId);
  const { branch, detached } = await getCurrentBranch(cfg, projectId);
  if (detached || !branch) {
    throw new ApiError(
      409,
      "cannot pull in detached HEAD state",
      "detached_head",
    );
  }

  await runRemoteGit(cfg, projectId, ["fetch", "--", ORIGIN], {
    creds,
    urlForHost: url,
  });

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
    { allowNonZero: true },
  );
  if (res.code !== 0) {
    throw mapRemoteGitError({ stderr: res.stderr });
  }
}

export async function pushCurrentBranch(
  cfg: AppConfig,
  projectId: string,
  creds: RemoteOpCreds | null,
): Promise<{ ok: true; branch: string; remote: string }> {
  await assertRepo(cfg, projectId);
  const url = await requireOriginUrl(cfg, projectId);
  const { branch, detached } = await getCurrentBranch(cfg, projectId);
  if (detached || !branch) {
    throw new ApiError(
      409,
      "cannot push in detached HEAD state",
      "detached_head",
    );
  }

  const res = await runRemoteGit(
    cfg,
    projectId,
    ["push", "--set-upstream", "--", ORIGIN, branch],
    { creds, urlForHost: url, allowNonZero: true },
  );
  if (res.code !== 0) {
    throw mapRemoteGitError({ stderr: res.stderr, message: res.stderr });
  }
  return { ok: true, branch, remote: url };
}

async function requireOriginUrl(
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
    if (entry.isDirectory()) {
      total += await directorySize(p);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(p)).size;
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
