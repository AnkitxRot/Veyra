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
  chmodSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
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
 * Restricts a freshly-created backup file to owner-only read/write (0o600).
 * `VACUUM INTO` creates its destination file honoring the process umask,
 * which commonly leaves it group/world-readable (e.g. 0644) — and a backup
 * is a full database export (password hashes, session tokens), so it should
 * not be readable by other local accounts on a shared host. Best-effort: a
 * chmod failure (e.g. an unsupported filesystem, or Windows where this is a
 * no-op) must not fail the backup itself.
 * @param {string} filePath
 */
export function secureBackupFilePermissions(filePath) {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort — see doc comment above.
  }
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
  // 0o700: backup files contain full database exports (password hashes,
  // session tokens) — owner-only. No-op on Windows (NTFS ACLs, not POSIX
  // mode bits), meaningful on the Linux/Docker production target.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
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
  // 0o700: backup files contain full database exports (password hashes,
  // session tokens) — owner-only. No-op on Windows (NTFS ACLs, not POSIX
  // mode bits), meaningful on the Linux/Docker production target.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
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
  // 0o700: backup files contain full database exports (password hashes,
  // session tokens) — owner-only. No-op on Windows (NTFS ACLs, not POSIX
  // mode bits), meaningful on the Linux/Docker production target.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
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

/**
 * Same filename-allowlist validation `service.ts`'s `assertValidBackupFilename`
 * and the admin download route already apply — re-checked here rather than
 * imported, since neither of those is exported from a shared module, and
 * `BACKUP_FILENAME_RE` (the actual reusable primitive) already anchors this
 * to the same allowlist regex they both use.
 * @param {string} filename
 */
function assertValidRestoreFilename(filename) {
  if (
    typeof filename !== "string" ||
    !BACKUP_FILENAME_RE.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    throw new Error(`Invalid backup filename: ${JSON.stringify(filename)}`);
  }
}

export class RestoreIntegrityError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RestoreIntegrityError";
  }
}

export class RestoreVerificationError extends Error {
  /**
   * @param {string} message
   * @param {{ safetyCopyPath: string | null, postRestoreIntegrity: string }} details
   */
  constructor(message, details) {
    super(message);
    this.name = "RestoreVerificationError";
    this.safetyCopyPath = details.safetyCopyPath;
    this.postRestoreIntegrity = details.postRestoreIntegrity;
  }
}

/**
 * @typedef {Object} RestoreResult
 * @property {string} restoredFrom
 * @property {number} backupSizeBytes
 * @property {string | null} safetyCopyPath
 * @property {string} postRestoreIntegrity
 * @property {number} durationMs
 */

/**
 * Restores the live SQLite database file at `dbPath` from a verified backup
 * file in `backupDir`.
 *
 * OFFLINE OPERATION ONLY: this function replaces the live database file on
 * disk and cannot reliably detect whether some other process (the running
 * application) still has it open — it does not try to guess. The caller
 * (the CLI) is responsible for documenting that the application must be
 * stopped first; see deploy/README.md's Offline Disaster Recovery Runbook.
 *
 * Sequence (never mutates the backup source, never leaves a partially
 * written live database file):
 *   1. Validate `filename` against the same allowlist backup routes use.
 *   2. Verify the BACKUP's own integrity via `PRAGMA integrity_check`
 *      *before* touching the live database at all. A failed check aborts
 *      here with the live database provably untouched.
 *   3. If a live database file already exists, copy it (plus any `-wal`/
 *      `-shm` sidecars) into a timestamped safety copy under
 *      `<dbDir>/restore-safety/` *before* any destructive action. Safety
 *      copies are never deleted automatically.
 *   4. Copy the backup into a temp file in the same directory as `dbPath`,
 *      then `renameSync` it over `dbPath` — a single filesystem rename is
 *      the platform's safest available replacement primitive (POSIX
 *      `rename(2)` is atomic; Windows' underlying `MoveFileExW` with
 *      `MOVEFILE_REPLACE_EXISTING` is the closest equivalent, though it is
 *      not documented by Microsoft as atomic across every filesystem/
 *      journaling scenario — this is *not* claimed as universal atomicity,
 *      only as never writing byte-by-byte into the final live path, so a
 *      failure during the copy-to-temp step can never leave `dbPath`
 *      partially written).
 *   5. Remove the now-stale `-wal`/`-shm` sidecars at the *live* path (they
 *      describe the pre-restore database generation and must not be
 *      replayed against the freshly-restored file). The safety copy's own
 *      sidecars are left untouched.
 *   6. Re-verify integrity of the now-live restored file. A failure here
 *      does NOT trigger an automatic rollback — it reports failure
 *      prominently and leaves the safety copy in place for manual
 *      recovery, rather than silently reporting success or guessing at an
 *      automated fix for a state this function cannot fully diagnose.
 *
 * @param {Object} opts
 * @param {string} opts.dbPath - Live database file path.
 * @param {string} opts.backupDir - Directory containing backup files.
 * @param {string} opts.filename - Backup filename to restore from.
 * @param {(filePath: string) => string} [opts.integrityCheckFn] - Defaults
 *   to {@link verifyDatabaseBackupIntegrity}. Overridable only so tests can
 *   deterministically exercise the post-restore-verification-failure branch
 *   without needing genuine disk corruption; production callers (the CLI)
 *   never override this.
 * @returns {RestoreResult}
 */
export function restoreDatabaseFromBackup(opts) {
  const {
    dbPath,
    backupDir,
    filename,
    integrityCheckFn = verifyDatabaseBackupIntegrity,
  } = opts;

  assertValidRestoreFilename(filename);

  const backupPath = join(backupDir, filename);
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }

  // Verify the BACKUP's own integrity before touching the live DB at all —
  // a failed check means no mutation has happened, so no safety copy is
  // needed and none is made.
  const backupIntegrity = integrityCheckFn(backupPath);
  if (backupIntegrity !== "ok") {
    throw new RestoreIntegrityError(
      `Backup integrity verification failed (${backupIntegrity}) -- the live database was not touched.`,
    );
  }

  const backupStat = statSync(backupPath);
  const startTime = Date.now();
  const dbDir = dirname(dbPath);

  // Safety copy of whatever currently lives at dbPath, before any
  // destructive action. No live DB yet (e.g. first-ever restore onto a
  // fresh deployment) is a legitimate case — nothing to copy then.
  let safetyCopyPath = null;
  if (existsSync(dbPath)) {
    const safetyDir = join(dbDir, "restore-safety");
    mkdirSync(safetyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const nonce = randomBytes(3).toString("hex");
    safetyCopyPath = join(
      safetyDir,
      `${basename(dbPath)}.pre-restore-${stamp}-${nonce}`,
    );
    copyFileSync(dbPath, safetyCopyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) {
        copyFileSync(dbPath + suffix, safetyCopyPath + suffix);
      }
    }
  }

  // Copy the backup into a same-directory temp file, then rename it over
  // dbPath — the rename is the only operation that ever touches the final
  // live path, so a failure during the copy can never leave dbPath
  // partially written.
  const tempPath = join(
    dbDir,
    `.restoring-${process.pid}-${randomBytes(3).toString("hex")}`,
  );
  try {
    copyFileSync(backupPath, tempPath);
    renameSync(tempPath, dbPath);
  } catch (/** @type {any} */ err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
    throw new Error(`Failed to replace live database file: ${err.message}`);
  }

  // The old -wal/-shm at the live path describe the pre-restore generation
  // and must not be replayed against the freshly-restored file. The safety
  // copy's own sidecars (already captured above) are left untouched.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {}
  }

  const postRestoreIntegrity = integrityCheckFn(dbPath);
  const durationMs = Date.now() - startTime;

  if (postRestoreIntegrity !== "ok") {
    // No automatic rollback: report failure and leave the safety copy in
    // place rather than silently claim success or guess at a fix.
    throw new RestoreVerificationError(
      `Post-restore integrity check failed (${postRestoreIntegrity}). The live database at ${dbPath} may be damaged.`,
      { safetyCopyPath, postRestoreIntegrity },
    );
  }

  return {
    restoredFrom: filename,
    backupSizeBytes: backupStat.size,
    safetyCopyPath,
    postRestoreIntegrity,
    durationMs,
  };
}
