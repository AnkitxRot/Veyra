import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { recordAuditLog } from "../audit.js";
import {
  BACKUP_FILENAME_RE,
  BackupLockTimeoutError,
  ensureBackupDir,
  generateBackupFilename,
  listBackupFilesSync,
  pruneBackupFilesSync,
  verifyDatabaseBackupIntegrity,
  withBackupLockAsync,
  type RawBackupEntry,
} from "./shared.js";

export {
  BACKUP_FILENAME_RE,
  generateBackupFilename,
  verifyDatabaseBackupIntegrity,
};

export interface BackupMetadata {
  filename: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
  integrity: "ok" | "failed" | "unverified";
}

/**
 * Cross-process filesystem lock (shared.js) is the single source of truth
 * for serializing create/prune/delete — it also naturally serializes
 * concurrent same-process callers, so no separate in-process mutex is kept
 * on top of it. Uses the async acquire variant so a contended lock (e.g. a
 * cron CLI backup already running) doesn't block the Node event loop —
 * and every other request this process is serving — while waiting its
 * turn; only the eventual VACUUM INTO itself is unavoidably synchronous.
 */
async function withBackupLock<T>(cfg: AppConfig, fn: () => T): Promise<T> {
  try {
    return await withBackupLockAsync(
      cfg.backupDir,
      { staleMs: cfg.backupLockStaleMs },
      fn,
    );
  } catch (err: any) {
    if (err instanceof BackupLockTimeoutError) {
      throw new ApiError(503, err.message, "backup_lock_timeout");
    }
    throw err;
  }
}

function assertValidBackupFilename(filename: string): void {
  if (
    !BACKUP_FILENAME_RE.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    throw new ApiError(400, "Invalid backup filename", "invalid_filename");
  }
}

/**
 * Lists all database backup files in the backup directory, sorted
 * newest-first.
 *
 * Integrity is honest by default: listing does not silently claim
 * verification that never happened. Entries are reported as 'unverified'
 * unless `options.verify` is set, in which case each file is re-checked via
 * `PRAGMA integrity_check` (accepting that cost) and reported as 'ok' or
 * 'failed'. `createDatabaseBackup`'s own return value is the only place
 * 'ok' is produced "for free", since that backup was just verified at
 * creation time.
 */
export async function listDatabaseBackups(
  cfg: AppConfig,
  options?: { verify?: boolean },
): Promise<BackupMetadata[]> {
  const raw: RawBackupEntry[] = listBackupFilesSync(cfg.backupDir);
  return raw.map((entry) => ({
    ...entry,
    integrity: options?.verify
      ? verifyDatabaseBackupIntegrity(entry.filePath) === "ok"
        ? ("ok" as const)
        : ("failed" as const)
      : ("unverified" as const),
  }));
}

/**
 * Prunes older backups to stay within count and byte quotas (oldest-first
 * eviction). Serializes with create/delete via the backup lock so prune
 * never races a backup that is still being finalized/written.
 */
export async function pruneDatabaseBackups(
  cfg: AppConfig,
): Promise<{ prunedCount: number; prunedBytes: number }> {
  return withBackupLock(cfg, () => {
    const { prunedCount, prunedBytes } = pruneBackupFilesSync(
      cfg.backupDir,
      cfg.maxDatabaseBackups,
      cfg.maxBackupBytes,
    );
    return { prunedCount, prunedBytes };
  });
}

/**
 * Creates a verified point-in-time online SQLite backup using VACUUM INTO.
 */
export async function createDatabaseBackup(
  db: Db,
  cfg: AppConfig,
  options?: { actorUserId?: number; ipAddress?: string },
): Promise<BackupMetadata> {
  return withBackupLock(cfg, () => {
    // The lock acquisition itself already created cfg.backupDir; this is a
    // defensive no-op if called with a pre-existing directory.
    ensureBackupDir(cfg.backupDir);

    const filename = generateBackupFilename();
    const backupPath = join(cfg.backupDir, filename);

    if (existsSync(backupPath)) {
      throw new ApiError(
        409,
        "Backup destination collision",
        "backup_collision",
      );
    }

    try {
      const escapedPath = backupPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escapedPath}'`);
    } catch (err: any) {
      try {
        rmSync(backupPath, { force: true });
      } catch {}
      throw new ApiError(
        500,
        `Database backup failed: ${err.message}`,
        "backup_failed",
      );
    }

    const integrity = verifyDatabaseBackupIntegrity(backupPath);
    if (integrity !== "ok") {
      try {
        rmSync(backupPath, { force: true });
      } catch {}
      throw new ApiError(
        500,
        `Backup integrity verification failed: ${integrity}`,
        "backup_integrity_failed",
      );
    }

    const stat = statSync(backupPath);
    const createdAt = new Date().toISOString();

    // Prune older backups now, while still holding the lock — this backup
    // is only prune/delete-eligible once fully written and verified, and
    // calling the lock-free prune primitive directly here (instead of the
    // locking `pruneDatabaseBackups` export) avoids self-deadlocking on a
    // lock we already hold.
    pruneBackupFilesSync(
      cfg.backupDir,
      cfg.maxDatabaseBackups,
      cfg.maxBackupBytes,
    );

    recordAuditLog(db, {
      userId: options?.actorUserId,
      eventType: "DATABASE_BACKUP_CREATED",
      details: {
        filename,
        sizeBytes: stat.size,
        integrity: "ok",
      },
      ipAddress: options?.ipAddress,
    });

    return {
      filename,
      filePath: backupPath,
      sizeBytes: stat.size,
      createdAt,
      integrity: "ok",
    };
  });
}

/**
 * Deletes a specific database backup file by filename. Serializes with
 * create/prune via the same backup lock so delete never races a backup
 * that is still being finalized.
 */
export async function deleteDatabaseBackup(
  db: Db,
  cfg: AppConfig,
  filename: string,
  options?: { actorUserId?: number; ipAddress?: string },
): Promise<boolean> {
  assertValidBackupFilename(filename);

  return withBackupLock(cfg, () => {
    const filePath = join(cfg.backupDir, filename);
    if (!existsSync(filePath)) {
      throw new ApiError(404, "Backup not found", "not_found");
    }

    try {
      rmSync(filePath, { force: true });
    } catch (err: any) {
      throw new ApiError(
        500,
        `Failed to delete backup: ${err.message}`,
        "delete_failed",
      );
    }

    recordAuditLog(db, {
      userId: options?.actorUserId,
      eventType: "DATABASE_BACKUP_DELETED",
      details: { filename },
      ipAddress: options?.ipAddress,
    });

    return true;
  });
}
