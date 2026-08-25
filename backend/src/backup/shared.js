// @ts-check
/**
 * Shared SQLite backup logic used by BOTH the TypeScript backend service
 * (backend/src/backup/service.ts) and the plain-Node CLI
 * (scripts/backup-db.js).
 *
 * Kept as plain ESM JavaScript (JSDoc types only, no TypeScript-only
 * syntax) so scripts/backup-db.js keeps running with zero build step via
 * `node scripts/backup-db.js`, while service.ts consumes the exact same
 * functions (via `allowJs` in backend/tsconfig.json) instead of
 * duplicating filename generation / integrity verification / list+prune
 * retention math / cross-process locking.
 *
 * DB-connection acquisition legitimately stays separate per caller: the
 * server passes in its already-open `Db` handle, the CLI opens its own
 * `DatabaseSync(dbPath)`. Everything else backup-related lives here.
 */

import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
/** @type {{ DatabaseSync: any }} */
const { DatabaseSync } = require("node:sqlite");

export const BACKUP_FILENAME_RE = /^[a-zA-Z0-9_-]+\.db$/;

const LOCK_FILENAME = ".backup.lock";
export const DEFAULT_BACKUP_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_MAX_WAIT_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 50;

/**
 * @typedef {Object} RawBackupEntry
 * @property {string} filename
 * @property {string} filePath
 * @property {number} sizeBytes
 * @property {string} createdAt
 */

/** Generates a unique, filename-allowlist-safe backup file name. */
export function generateBackupFilename() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = randomBytes(4).toString("hex");
  return `cloudeeeide_backup_${ts}_${nonce}.db`;
}

/**
 * Verifies a SQLite database file via `PRAGMA integrity_check`.
 * @param {string} filePath
 * @returns {string} 'ok' on success, otherwise a human-readable failure reason.
 */
export function verifyDatabaseBackupIntegrity(filePath) {
  try {
    if (!existsSync(filePath)) {
      return "file not found";
    }
    const backupDb = new DatabaseSync(filePath, { readOnly: true });
    try {
      const row = backupDb.prepare("PRAGMA integrity_check").get();
      const status = row?.integrity_check ?? "unknown";
      return status === "ok" ? "ok" : String(status);
    } finally {
      backupDb.close();
    }
  } catch (/** @type {any} */ err) {
    return err?.message || "integrity check failed";
  }
}

/**
 * Ensures `backupDir` exists.
 * @param {string} backupDir
 */
export function ensureBackupDir(backupDir) {
  mkdirSync(backupDir, { recursive: true });
}

/**
 * Lists raw backup file entries in `backupDir`, newest first. Does NOT
 * verify integrity — callers decide whether/when to pay that cost.
 * @param {string} backupDir
 * @returns {RawBackupEntry[]}
 */
export function listBackupFilesSync(backupDir) {
  if (!existsSync(backupDir)) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(backupDir);
  } catch {
    return [];
  }

  /** @type {RawBackupEntry[]} */
  const list = [];
  for (const name of entries) {
    if (!BACKUP_FILENAME_RE.test(name)) continue;
    const filePath = join(backupDir, name);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      const createdAt =
        stat.birthtime && !isNaN(stat.birthtime.getTime())
          ? stat.birthtime.toISOString()
          : stat.mtime.toISOString();
      list.push({ filename: name, filePath, sizeBytes: stat.size, createdAt });
    } catch {
      // File removed or inaccessible between readdir and stat.
      continue;
    }
  }

  list.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return list;
}

/**
 * Prunes older backups to stay within count/byte quotas (oldest-first
 * eviction, always retaining at least 1 backup if any exist). Pure
 * filesystem operation — callers are responsible for holding the backup
 * lock around this if serialization with create/delete is required.
 * @param {string} backupDir
 * @param {number} maxBackups
 * @param {number} maxBytes
 */
export function pruneBackupFilesSync(backupDir, maxBackups, maxBytes) {
  const backups = listBackupFilesSync(backupDir);
  let prunedCount = 0;
  let prunedBytes = 0;
  let retainedCount = 0;
  let retainedBytes = 0;

  for (const backup of backups) {
    const wouldExceedCount = retainedCount >= maxBackups;
    const wouldExceedBytes = retainedBytes + backup.sizeBytes > maxBytes;

    if ((wouldExceedCount || wouldExceedBytes) && retainedCount > 0) {
      try {
        rmSync(backup.filePath, { force: true });
        prunedCount++;
        prunedBytes += backup.sizeBytes;
      } catch {
        // Ignored if file already removed.
      }
    } else {
      retainedCount++;
      retainedBytes += backup.sizeBytes;
    }
  }

  return {
    prunedCount,
    prunedBytes,
    remainingCount: retainedCount,
    remainingBytes: retainedBytes,
  };
}

export class BackupLockTimeoutError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "BackupLockTimeoutError";
  }
}

/**
 * Synchronous, non-busy-wait sleep (blocks this thread only).
 * @param {number} ms
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * @param {string} lockPath
 * @returns {{ pid?: number, acquiredAt?: string, token?: string } | null}
 */
function readLockPayload(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Checks whether a process with the given PID is still alive, without
 * killing it (signal 0). Works cross-platform, including Windows. Treats
 * "exists but we lack permission to signal it" (EPERM) as alive — safest
 * assumption for a reclaim decision.
 * @param {number | undefined} pid
 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (/** @type {any} */ err) {
    return err?.code === "EPERM";
  }
}

/**
 * Decides whether a held, non-stale-by-our-own-token lock at `lockPath` is
 * safe to reclaim, and does so if so. A lock is only reclaimed if it is
 * BOTH older than `staleMs` AND its recorded holder PID is no longer alive
 * — age alone is not sufficient, since a single large production database
 * can legitimately make one VACUUM INTO take longer than a short staleness
 * window, and the synchronous nature of that call means the holder cannot
 * "heartbeat" the lock file while it's mid-backup. Liveness is the
 * race-free signal that actually distinguishes "still legitimately working"
 * from "crashed and abandoned".
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean} true if the lock was reclaimed (or already gone) and the caller should retry immediately
 */
function tryReclaimStaleLock(lockPath, staleMs) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return true; // Vanished concurrently (released) — retry immediately.
  }

  const payload = readLockPayload(lockPath);
  const ageMs = Date.now() - stat.mtimeMs;
  const holderAlive = isProcessAlive(payload?.pid);

  if (ageMs <= staleMs) return false;
  if (holderAlive) return false; // Still legitimately working — do not reclaim.

  try {
    unlinkSync(lockPath);
  } catch {
    // Someone else may have reclaimed it first — caller retries either way.
  }
  return true;
}

/**
 * Acquires an exclusive, atomic, filesystem-based lock inside `backupDir`
 * that coordinates backup create/prune/delete across BOTH the server
 * process and any separately-invoked CLI/cron backup process. This is the
 * source of truth for cross-process serialization; the same file also
 * naturally serializes concurrent same-process callers (a second caller
 * retries until the first's `finally` releases it), so no separate
 * in-process mutex is layered on top.
 *
 * Uses `fs.openSync(path, 'wx')` (O_CREAT|O_EXCL) rather than flock,
 * since it is atomic on both POSIX and Windows/NTFS and this app runs on
 * Windows.
 *
 * Synchronous (blocks this process, including its event loop, while
 * waiting) — appropriate for the standalone CLI, which is a short-lived
 * dedicated process where that's harmless. Server-side code should use
 * {@link acquireBackupLockAsync} instead so lock contention doesn't stall
 * every other request the Node process is serving.
 *
 * @param {string} backupDir
 * @param {{ staleMs?: number, maxWaitMs?: number }} [opts]
 * @returns {{ lockPath: string, token: string }}
 */
export function acquireBackupLock(backupDir, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_BACKUP_LOCK_STALE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
  mkdirSync(backupDir, { recursive: true });
  const lockPath = join(backupDir, LOCK_FILENAME);
  const token = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            token,
          }),
        );
      } finally {
        closeSync(fd);
      }
      return { lockPath, token };
    } catch (/** @type {any} */ err) {
      if (err?.code !== "EEXIST") throw err;

      if (tryReclaimStaleLock(lockPath, staleMs)) continue;

      if (Date.now() >= deadline) {
        throw new BackupLockTimeoutError(
          `Timed out waiting for backup lock at ${lockPath} (held by another process/attempt)`,
        );
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
}

/**
 * Async equivalent of {@link acquireBackupLock} for use from the server
 * process: waits for lock contention via a real timer instead of a
 * synchronous `Atomics.wait` sleep, so a contended lock (e.g. a cron CLI
 * backup already running) doesn't freeze the Node event loop — and every
 * other request being served by this process — for up to `maxWaitMs`
 * while waiting its turn. The actual critical section once the lock is
 * held is unavoidably synchronous (VACUUM INTO has no async form), which
 * is a documented, accepted characteristic of this feature — this only
 * fixes the *waiting* portion.
 *
 * @param {string} backupDir
 * @param {{ staleMs?: number, maxWaitMs?: number }} [opts]
 * @returns {Promise<{ lockPath: string, token: string }>}
 */
export async function acquireBackupLockAsync(backupDir, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_BACKUP_LOCK_STALE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
  mkdirSync(backupDir, { recursive: true });
  const lockPath = join(backupDir, LOCK_FILENAME);
  const token = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            token,
          }),
        );
      } finally {
        closeSync(fd);
      }
      return { lockPath, token };
    } catch (/** @type {any} */ err) {
      if (err?.code !== "EEXIST") throw err;

      if (tryReclaimStaleLock(lockPath, staleMs)) continue;

      if (Date.now() >= deadline) {
        throw new BackupLockTimeoutError(
          `Timed out waiting for backup lock at ${lockPath} (held by another process/attempt)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
}

/**
 * Releases a lock acquired via {@link acquireBackupLock}. Best-effort and
 * ownership-checked: only unlinks the lock file if it still records the
 * token we acquired it with, so staleness-recovery by another
 * process/attempt is never clobbered. This is a local single-host lock,
 * not a distributed one, so a guarded try/catch is sufficient.
 * @param {{ lockPath: string, token: string } | null | undefined} lock
 */
export function releaseBackupLock(lock) {
  if (!lock) return;
  try {
    const payload = readLockPayload(lock.lockPath);
    if (payload && payload.token === lock.token) {
      unlinkSync(lock.lockPath);
    }
  } catch {
    // Best-effort; nothing meaningful to do if this fails.
  }
}

/**
 * Runs `fn` while holding the cross-process backup lock, always releasing
 * it in a `finally`.
 * @template T
 * @param {string} backupDir
 * @param {{ staleMs?: number, maxWaitMs?: number }} opts
 * @param {() => T} fn
 * @returns {T}
 */
export function withBackupLockSync(backupDir, opts, fn) {
  const lock = acquireBackupLock(backupDir, opts);
  try {
    return fn();
  } finally {
    releaseBackupLock(lock);
  }
}

/**
 * Async equivalent of {@link withBackupLockSync}, using
 * {@link acquireBackupLockAsync} so waiting for a contended lock doesn't
 * block the Node event loop. `fn` itself still runs synchronously once the
 * lock is held (VACUUM INTO has no async form), so this only improves the
 * *waiting* portion, not the backup's own execution time.
 * @template T
 * @param {string} backupDir
 * @param {{ staleMs?: number, maxWaitMs?: number }} opts
 * @param {() => T} fn
 * @returns {Promise<T>}
 */
export async function withBackupLockAsync(backupDir, opts, fn) {
  const lock = await acquireBackupLockAsync(backupDir, opts);
  try {
    return fn();
  } finally {
    releaseBackupLock(lock);
  }
}
