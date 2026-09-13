import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import {
  createProjectSecret,
  updateProjectSecret,
  deleteProjectSecret,
  decryptProjectSecret,
  hasProjectSecret,
  GIT_HTTPS_TOKEN_SECRET,
  GIT_HTTPS_USERNAME_SECRET,
} from "../projectsecrets/store.js";

/**
 * M80 — Git HTTPS credentials stored as reserved M47 project secrets.
 *
 * Names: GIT_HTTPS_USERNAME, GIT_HTTPS_TOKEN. Both is_secret=1 (write-only
 * in the public secrets API). They are excluded from run/terminal injection
 * so a PAT never appears in a collaborator's sandbox environment by accident.
 */

const MAX_USERNAME = 256;
const MAX_TOKEN = 32 * 1024;

export interface GitHttpsCredentials {
  username: string;
  token: string;
}

export function hasGitHttpsCredentials(db: Db, projectId: string): boolean {
  return hasProjectSecret(db, projectId, GIT_HTTPS_TOKEN_SECRET, null);
}

export function resolveGitHttpsCredentials(
  db: Db,
  cfg: AppConfig,
  projectId: string,
): GitHttpsCredentials | null {
  const token = decryptProjectSecret(
    db,
    cfg,
    projectId,
    GIT_HTTPS_TOKEN_SECRET,
    null,
  );
  if (token === null || token.length === 0) return null;
  const username =
    decryptProjectSecret(db, cfg, projectId, GIT_HTTPS_USERNAME_SECRET, null) ||
    "git";
  return { username, token };
}

export function upsertGitHttpsCredentials(
  db: Db,
  cfg: AppConfig,
  projectId: string,
  input: { username?: unknown; token: unknown; createdBy: number | null },
): { configured: true } {
  const token = validateToken(input.token);
  const username = validateUsername(input.username);

  upsertOne(db, cfg, {
    projectId,
    name: GIT_HTTPS_TOKEN_SECRET,
    value: token,
    createdBy: input.createdBy,
  });
  upsertOne(db, cfg, {
    projectId,
    name: GIT_HTTPS_USERNAME_SECRET,
    value: username,
    createdBy: input.createdBy,
  });
  return { configured: true };
}

export function deleteGitHttpsCredentials(db: Db, projectId: string): boolean {
  const a = deleteProjectSecret(db, projectId, GIT_HTTPS_TOKEN_SECRET, null);
  const b = deleteProjectSecret(db, projectId, GIT_HTTPS_USERNAME_SECRET, null);
  return a || b;
}

function upsertOne(
  db: Db,
  cfg: AppConfig,
  input: {
    projectId: string;
    name: string;
    value: string;
    createdBy: number | null;
  },
): void {
  const payload = {
    projectId: input.projectId,
    name: input.name,
    environment: null,
    isSecret: true,
    value: input.value,
    createdBy: input.createdBy,
  };
  if (hasProjectSecret(db, input.projectId, input.name, null)) {
    updateProjectSecret(db, cfg, payload);
  } else {
    createProjectSecret(db, cfg, payload);
  }
}

function validateToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(
      400,
      "credential token is required",
      "invalid_git_credential",
    );
  }
  if (raw.includes("\0") || /[\r\n]/.test(raw)) {
    throw new ApiError(400, "invalid credential token", "invalid_git_credential");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_TOKEN) {
    throw new ApiError(400, "credential token is too long", "invalid_git_credential");
  }
  return raw;
}

function validateUsername(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "git";
  if (typeof raw !== "string") {
    throw new ApiError(
      400,
      "invalid credential username",
      "invalid_git_credential",
    );
  }
  const u = raw.trim();
  if (u.length === 0 || u.length > MAX_USERNAME) {
    throw new ApiError(
      400,
      "invalid credential username",
      "invalid_git_credential",
    );
  }
  if (u.includes("\0") || /[\r\n]/.test(u) || u.includes(":")) {
    throw new ApiError(
      400,
      "invalid credential username",
      "invalid_git_credential",
    );
  }
  return u;
}
