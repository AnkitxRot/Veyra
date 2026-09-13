import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { recordAuditLog } from "../audit.js";
import {
  encryptSecret,
  decryptSecret,
  computeFingerprint,
  resolveMasterKey,
  SecretsKeyError,
  SecretsDecryptError,
  type SecretIdentity,
} from "./crypto.js";

/**
 * M47 — per-project secret store.
 *
 * One unified table holds both true secrets (`is_secret = 1`, write-only in
 * the API) and plain configuration (`is_secret = 0`, value retrievable by the
 * owner). Both are AES-256-GCM encrypted at rest and both are injected into
 * execution identically as environment variables.
 *
 * v1 only ever uses scope = 'project', scope_id = <project id>.
 */

export const SECRET_SCOPE_PROJECT = "project";

/** M80: reserved names for Git HTTPS credentials. Stored as ordinary
 *  project secrets (encrypted, write-only) but never injected into
 *  run/terminal environments. */
export const GIT_HTTPS_USERNAME_SECRET = "GIT_HTTPS_USERNAME";
export const GIT_HTTPS_TOKEN_SECRET = "GIT_HTTPS_TOKEN";
/** Host the stored PAT is pinned to. Never injected; write-only. */
export const GIT_HTTPS_HOST_SECRET = "GIT_HTTPS_HOST";

const NON_INJECTABLE_SECRET_NAMES = new Set([
  GIT_HTTPS_USERNAME_SECRET,
  GIT_HTTPS_TOKEN_SECRET,
  GIT_HTTPS_HOST_SECRET,
]);

const MAX_NAME_LEN = 128;
const MAX_VALUE_BYTES = 32 * 1024;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface SecretMetadata {
  name: string;
  environment: string | null;
  isSecret: boolean;
  fingerprint: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

interface SecretRow {
  id: number;
  scope: string;
  scope_id: string;
  environment: string | null;
  name: string;
  ciphertext: Buffer | Uint8Array;
  nonce: Buffer | Uint8Array;
  key_version: number;
  is_secret: number;
  fingerprint: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export function validateSecretName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new ApiError(400, "secret name is required", "invalid_secret_name");
  }
  if (name.length > MAX_NAME_LEN) {
    throw new ApiError(
      400,
      `secret name must be at most ${MAX_NAME_LEN} characters`,
      "invalid_secret_name",
    );
  }
  if (!NAME_RE.test(name)) {
    throw new ApiError(
      400,
      "secret name must match [A-Za-z_][A-Za-z0-9_]* (letters, digits, underscore; not starting with a digit)",
      "invalid_secret_name",
    );
  }
  return name;
}

export function normalizeEnvironment(env: unknown): string | null {
  if (env === undefined || env === null || env === "") {
    return null;
  }
  if (typeof env !== "string" || !ENV_RE.test(env)) {
    throw new ApiError(
      400,
      "environment must match [A-Za-z0-9_.-]{1,64}",
      "invalid_secret_environment",
    );
  }
  return env;
}

function validateValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "secret value must be a string",
      "invalid_secret_value",
    );
  }
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    throw new ApiError(
      400,
      `secret value must be at most ${MAX_VALUE_BYTES} bytes`,
      "invalid_secret_value",
    );
  }
  if (value.includes("\0")) {
    throw new ApiError(
      400,
      "secret value must not contain NUL bytes",
      "invalid_secret_value",
    );
  }
  return value;
}

function identityOf(
  projectId: string,
  name: string,
  environment: string | null,
): SecretIdentity {
  return {
    scope: SECRET_SCOPE_PROJECT,
    scopeId: projectId,
    environment,
    name,
  };
}

function toMetadata(row: SecretRow): SecretMetadata {
  return {
    name: row.name,
    environment: row.environment ?? null,
    isSecret: row.is_secret !== 0,
    fingerprint: row.fingerprint ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

function selectRow(
  db: Db,
  projectId: string,
  name: string,
  environment: string | null,
): SecretRow | null {
  const row = db
    .prepare(
      `SELECT * FROM secrets
       WHERE scope = ? AND scope_id = ?
         AND COALESCE(environment, '') = COALESCE(?, '')
         AND name = ?`,
    )
    .get(SECRET_SCOPE_PROJECT, projectId, environment, name) as
    SecretRow | undefined;
  return row ?? null;
}

/** Metadata for every secret on a project. Never decrypts, never returns a
 *  value — always safe to call regardless of master-key state. */
export function getProjectSecretMetadata(
  db: Db,
  projectId: string,
): SecretMetadata[] {
  const rows = db
    .prepare(
      `SELECT * FROM secrets
       WHERE scope = ? AND scope_id = ?
       ORDER BY name ASC, COALESCE(environment, '') ASC`,
    )
    .all(SECRET_SCOPE_PROJECT, projectId) as unknown as SecretRow[];
  return rows.map(toMetadata);
}

export function hasProjectSecret(
  db: Db,
  projectId: string,
  name: string,
  environment: string | null,
): boolean {
  return selectRow(db, projectId, name, environment) !== null;
}

/**
 * Server-side decrypt of a single secret. Returns null when the row does
 * not exist. Never used by a public route for is_secret=1 values.
 */
export function decryptProjectSecret(
  db: Db,
  cfg: AppConfig,
  projectId: string,
  name: string,
  environment: string | null,
): string | null {
  const row = selectRow(db, projectId, name, environment);
  if (!row) return null;
  return decryptSecret(
    {
      ciphertext: Buffer.from(row.ciphertext),
      nonce: Buffer.from(row.nonce),
      keyVersion: row.key_version,
    },
    cfg.secretsMasterKey,
    identityOf(projectId, name, environment),
  );
}

export function countProjectSecrets(db: Db, projectId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM secrets WHERE scope = ? AND scope_id = ?",
    )
    .get(SECRET_SCOPE_PROJECT, projectId) as { c: number };
  return row?.c ?? 0;
}

/** Any encrypted secret anywhere — used to decide whether a missing master
 *  key is a hard fault or merely "nothing to decrypt yet". */
export function anyEncryptedSecretsExist(db: Db): boolean {
  const row = db.prepare("SELECT 1 FROM secrets LIMIT 1").get() as
    { 1: number } | undefined;
  return row !== undefined;
}

function assertReservedGitSecretWriteOnly(
  name: string,
  isSecret: boolean,
): void {
  if (NON_INJECTABLE_SECRET_NAMES.has(name) && !isSecret) {
    throw new ApiError(
      400,
      "Git HTTPS credentials must remain write-only secrets",
      "reserved_secret",
    );
  }
}

/** Owner-only retrieval of a plain-configuration value (is_secret = 0). */
export function getConfigValue(
  db: Db,
  cfg: AppConfig,
  projectId: string,
  name: string,
  environment: string | null,
): string {
  const row = selectRow(db, projectId, name, environment);
  if (!row) {
    throw new ApiError(404, "secret not found", "not_found");
  }
  // Reserved Git credential names are never readable via the config API,
  // even if a row were marked is_secret=0.
  if (row.is_secret !== 0 || NON_INJECTABLE_SECRET_NAMES.has(name)) {
    throw new ApiError(
      403,
      "this entry is a secret and its value is write-only",
      "secret_write_only",
    );
  }
  return decryptSecret(
    {
      ciphertext: Buffer.from(row.ciphertext),
      nonce: Buffer.from(row.nonce),
      keyVersion: row.key_version,
    },
    cfg.secretsMasterKey,
    identityOf(projectId, name, environment),
  );
}

export interface UpsertInput {
  projectId: string;
  name: string;
  environment: string | null;
  isSecret: boolean;
  value: string;
  createdBy: number | null;
}

export function createProjectSecret(
  db: Db,
  cfg: AppConfig,
  input: UpsertInput,
): SecretMetadata {
  assertReservedGitSecretWriteOnly(input.name, input.isSecret);
  const value = validateValue(input.value);
  if (selectRow(db, input.projectId, input.name, input.environment)) {
    throw new ApiError(
      409,
      "a secret with this name already exists",
      "secret_exists",
    );
  }
  const enc = encryptSecret(
    value,
    cfg.secretsMasterKey,
    identityOf(input.projectId, input.name, input.environment),
  );
  const fingerprint = computeFingerprint(value);
  db.prepare(
    `INSERT INTO secrets
       (scope, scope_id, environment, name, ciphertext, nonce, key_version,
        is_secret, fingerprint, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SECRET_SCOPE_PROJECT,
    input.projectId,
    input.environment,
    input.name,
    enc.ciphertext,
    enc.nonce,
    enc.keyVersion,
    input.isSecret ? 1 : 0,
    fingerprint,
    input.createdBy,
  );
  return toMetadata(
    selectRow(db, input.projectId, input.name, input.environment)!,
  );
}

export function updateProjectSecret(
  db: Db,
  cfg: AppConfig,
  input: UpsertInput,
): SecretMetadata {
  assertReservedGitSecretWriteOnly(input.name, input.isSecret);
  const existing = selectRow(
    db,
    input.projectId,
    input.name,
    input.environment,
  );
  if (!existing) {
    throw new ApiError(404, "secret not found", "not_found");
  }
  const value = validateValue(input.value);
  const enc = encryptSecret(
    value,
    cfg.secretsMasterKey,
    identityOf(input.projectId, input.name, input.environment),
  );
  const fingerprint = computeFingerprint(value);
  db.prepare(
    `UPDATE secrets
       SET ciphertext = ?, nonce = ?, key_version = ?, is_secret = ?,
           fingerprint = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    enc.ciphertext,
    enc.nonce,
    enc.keyVersion,
    input.isSecret ? 1 : 0,
    fingerprint,
    existing.id,
  );
  return toMetadata(
    selectRow(db, input.projectId, input.name, input.environment)!,
  );
}

export function deleteProjectSecret(
  db: Db,
  projectId: string,
  name: string,
  environment: string | null,
): boolean {
  const info = db
    .prepare(
      `DELETE FROM secrets
       WHERE scope = ? AND scope_id = ?
         AND COALESCE(environment, '') = COALESCE(?, '')
         AND name = ?`,
    )
    .run(SECRET_SCOPE_PROJECT, projectId, environment, name);
  return Number(info.changes) > 0;
}

/** Hard-delete every secret row for a project. Belt-and-suspenders alongside
 *  the ON DELETE CASCADE FK — called explicitly from deleteProject(). */
export function deleteAllProjectSecrets(db: Db, projectId: string): number {
  const info = db
    .prepare("DELETE FROM secrets WHERE scope = ? AND scope_id = ?")
    .run(SECRET_SCOPE_PROJECT, projectId);
  return Number(info.changes);
}

/**
 * Decrypt every secret on a project for runtime injection. Bumps
 * `last_used_at`. Throws (fail closed) if the master key is unavailable or a
 * row cannot be decrypted — callers must abort the run/terminal, never
 * proceed with a partial or empty environment when rows exist.
 *
 * Returns {} when the project has no secrets at all.
 */
export function resolveInjectableSecrets(
  db: Db,
  cfg: AppConfig,
  projectId: string,
): Record<string, string> {
  const rows = db
    .prepare("SELECT * FROM secrets WHERE scope = ? AND scope_id = ?")
    .all(SECRET_SCOPE_PROJECT, projectId) as unknown as SecretRow[];
  if (rows.length === 0) {
    return {};
  }
  const out: Record<string, string> = {};
  const injectedNames: string[] = [];
  for (const row of rows) {
    if (NON_INJECTABLE_SECRET_NAMES.has(row.name)) continue;
    out[row.name] = decryptSecret(
      {
        ciphertext: Buffer.from(row.ciphertext),
        nonce: Buffer.from(row.nonce),
        keyVersion: row.key_version,
      },
      cfg.secretsMasterKey,
      identityOf(projectId, row.name, row.environment ?? null),
    );
    injectedNames.push(row.name);
  }
  if (injectedNames.length === 0) {
    return {};
  }
  const placeholders = injectedNames.map(() => "?").join(",");
  db.prepare(
    `UPDATE secrets SET last_used_at = datetime('now')
     WHERE scope = ? AND scope_id = ? AND name IN (${placeholders})`,
  ).run(SECRET_SCOPE_PROJECT, projectId, ...injectedNames);
  return out;
}

export type InjectionContext = "run" | "terminal";

/**
 * Resolve a project's secrets for runtime injection and record a single
 * SECRET_ACCESSED audit entry (metadata only: the context and the secret
 * NAMES, never values). Returns {} when the project has no secrets — in that
 * case no audit entry is written.
 *
 * Throws (fail closed) on any key/decrypt problem; callers must abort the
 * run or terminal rather than proceed without the secrets.
 */
export function resolveSecretsForInjection(
  db: Db,
  cfg: AppConfig,
  projectId: string,
  opts: {
    userId: number;
    context: InjectionContext;
    ipAddress?: string | null;
  },
): Record<string, string> {
  const env = resolveInjectableSecrets(db, cfg, projectId);
  const names = Object.keys(env);
  if (names.length === 0) {
    return {};
  }
  recordAuditLog(db, {
    userId: opts.userId,
    projectId,
    eventType: "SECRET_ACCESSED",
    details: { context: opts.context, names },
    ipAddress: opts.ipAddress ?? null,
  });
  return env;
}

/**
 * Startup advisory: if the database already holds encrypted secrets but the
 * configured master key is missing/invalid, log a clear operational message.
 * Deliberately does NOT exit — the server still starts (contract), but every
 * secret-dependent operation will fail closed until the key is fixed.
 */
export function verifySecretsKeyOnStartup(cfg: AppConfig, db: Db): void {
  if (!anyEncryptedSecretsExist(db)) return;
  try {
    resolveMasterKey(cfg.secretsMasterKey);
  } catch {
    console.error(
      "[secrets] Encrypted project secrets exist but SECRETS_MASTER_KEY is missing or " +
        "invalid. Secret CRUD and run/terminal secret injection will fail until a valid " +
        "32-byte key (base64 or 64 hex chars) is configured. See deploy/README.md.",
    );
  }
}

/** Map a crypto error to a generic, non-leaking API error. */
export function toGenericSecretError(err: unknown): ApiError {
  if (err instanceof SecretsKeyError) {
    return new ApiError(
      503,
      "secret encryption is not configured on this server",
      "secrets_key_unavailable",
    );
  }
  if (err instanceof SecretsDecryptError) {
    return new ApiError(
      500,
      "a stored secret could not be decrypted",
      "secrets_decrypt_failed",
    );
  }
  if (err instanceof ApiError) {
    return err;
  }
  return new ApiError(500, "secret operation failed", "secrets_error");
}
