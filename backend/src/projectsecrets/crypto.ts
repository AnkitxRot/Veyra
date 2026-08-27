import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * M47 — project-secret encryption primitive.
 *
 * AES-256-GCM with a random 12-byte nonce per secret and an authenticated
 * additional-data (AAD) binding of the row identity, so a ciphertext lifted
 * from one row cannot be decrypted in the context of another.
 *
 * The master key is ONLY ever the operator-supplied `SECRETS_MASTER_KEY`
 * (see config.ts). It is never generated, never persisted to SQLite, never
 * written to the workspace, never included in any backup artifact, never
 * logged, and never returned by the API. Losing it makes existing secrets
 * permanently undecryptable — this is intentional fail-closed behaviour.
 *
 * (Module lives under `projectsecrets/` rather than `secrets/` because the
 * host environment denies writes to any `secrets/` directory.)
 */

export const CURRENT_KEY_VERSION = 1;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Configuration problem: key missing or not valid 32-byte material. */
export class SecretsKeyError extends Error {
  readonly code = "secrets_key_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SecretsKeyError";
  }
}

/** Data problem: ciphertext malformed, tampered, or encrypted under a
 *  different key / key version than the one currently configured. */
export class SecretsDecryptError extends Error {
  readonly code = "secrets_decrypt_failed";
  constructor(message: string) {
    super(message);
    this.name = "SecretsDecryptError";
  }
}

export interface EncryptedSecret {
  /** GCM ciphertext with the 16-byte auth tag appended. */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export interface SecretIdentity {
  scope: string;
  scopeId: string;
  environment: string | null;
  name: string;
}

// Small cache so we do not re-decode the key material on every operation. The
// decoded key Buffer never leaves this module.
let cachedRaw: string | undefined;
let cachedKey: Buffer | null = null;

function decodeKeyMaterial(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, "hex");
  }
  // Accept standard and URL-safe base64 for exactly 32 decoded bytes.
  const b64 = Buffer.from(s, "base64");
  if (b64.length === 32) {
    return b64;
  }
  throw new SecretsKeyError(
    "SECRETS_MASTER_KEY must be 32 bytes encoded as base64 or as 64 hex characters",
  );
}

/**
 * Resolve the configured master key to a 32-byte Buffer, or throw
 * SecretsKeyError. Callers must treat the throw as fail-closed: refuse the
 * operation with a generic message, never fall through.
 */
export function resolveMasterKey(raw: string | undefined): Buffer {
  if (cachedKey && cachedRaw === raw) {
    return cachedKey;
  }
  if (raw === undefined || raw.trim() === "") {
    throw new SecretsKeyError("SECRETS_MASTER_KEY is not configured");
  }
  const key = decodeKeyMaterial(raw);
  cachedRaw = raw;
  cachedKey = key;
  return key;
}

/** Test-only: drop the decoded-key cache so a changed key is re-read. */
export function _resetKeyCacheForTests(): void {
  cachedRaw = undefined;
  cachedKey = null;
}

function aadFor(id: SecretIdentity, keyVersion: number): Buffer {
  // Space-separated identity binding. None of the parts can contain a space
  // or newline (names/scope/env are regex-validated; environment is validated
  // or null), so the concatenation is unambiguous.
  return Buffer.from(
    [
      id.scope,
      id.scopeId,
      id.environment ?? "",
      id.name,
      String(keyVersion),
    ].join(" "),
    "utf8",
  );
}

export function encryptSecret(
  plaintext: string,
  masterKeyRaw: string | undefined,
  id: SecretIdentity,
): EncryptedSecret {
  const key = resolveMasterKey(masterKeyRaw);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(id, CURRENT_KEY_VERSION));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]),
    nonce,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptSecret(
  record: { ciphertext: Buffer; nonce: Buffer; keyVersion: number },
  masterKeyRaw: string | undefined,
  id: SecretIdentity,
): string {
  const key = resolveMasterKey(masterKeyRaw);
  if (record.keyVersion !== CURRENT_KEY_VERSION) {
    throw new SecretsDecryptError(
      `unsupported key version ${record.keyVersion}`,
    );
  }
  if (
    !Buffer.isBuffer(record.ciphertext) ||
    record.ciphertext.length <= TAG_BYTES ||
    !Buffer.isBuffer(record.nonce) ||
    record.nonce.length !== NONCE_BYTES
  ) {
    throw new SecretsDecryptError("malformed secret record");
  }
  const tag = record.ciphertext.subarray(record.ciphertext.length - TAG_BYTES);
  const body = record.ciphertext.subarray(
    0,
    record.ciphertext.length - TAG_BYTES,
  );
  const decipher = createDecipheriv("aes-256-gcm", key, record.nonce);
  decipher.setAAD(aadFor(id, record.keyVersion));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Wrong key or tampered ciphertext/AAD. Never surface details.
    throw new SecretsDecryptError("secret could not be decrypted");
  }
}

/**
 * Last-4 fingerprint, only for values long enough that revealing the tail
 * leaks little. Returned in metadata so an owner can sanity-check a rotation.
 */
export function computeFingerprint(plaintext: string): string | null {
  return plaintext.length >= 8 ? plaintext.slice(-4) : null;
}
