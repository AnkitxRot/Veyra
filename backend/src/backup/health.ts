import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import {
  listDatabaseBackups,
  verifyDatabaseBackupIntegrity,
} from "./service.js";
import { listWorkspaceBackups } from "./workspaceBackup.js";

/**
 * Milestone 34 — Backup & Restore Operational Health Observability.
 *
 * Closes a real, evidence-backed blind spot: `GET /api/admin/health`
 * (admin/routes.ts) already reports database liveness, Docker liveness,
 * and sandbox counts, but says nothing about backup posture — despite
 * five prior milestones (M25/M27/M30/M31/M32) building comprehensive
 * backup/restore infrastructure. An operator who sets up the documented
 * `db:backup` cron job has no way to discover it silently stopped
 * running until the moment they actually need a backup.
 *
 * Deliberately ON-DEMAND ONLY — computed fresh every time the health
 * endpoint is called, no background scheduler, no caching. Deliberately
 * NOT wired into the PUBLIC `/api/health`/`/api/health/ready` routes:
 * those are process-liveness/readiness signals consumed by container
 * orchestration for restart decisions, and are documented as
 * deliberately independent even of Docker for that reason. A stale
 * backup is an operational fact about disaster-recovery posture, not
 * evidence the running process is broken — conflating the two would
 * make an unrelated cron failure trigger pointless container restarts
 * that do nothing to fix the actual problem.
 */

export type BackupHealthStatus = "ok" | "stale" | "critical" | "never";

export interface DatabaseBackupHealth {
  status: BackupHealthStatus;
  /** Total retained backup files, per `listDatabaseBackups` — this is an
   *  honest file count, independent of which (if any) are verified valid. */
  backupCount: number;
  /** Timestamp of the newest backup that actually passed
   *  `PRAGMA integrity_check`, not merely the newest file by name — a
   *  corrupt newest backup is skipped in favor of an older valid one,
   *  never reported as if it were a healthy backup. */
  latestBackupCreatedAt: string | null;
  latestBackupAgeMs: number | null;
  warningAgeMs: number;
  criticalAgeMs: number;
}

export interface WorkspaceBackupHealth {
  status: BackupHealthStatus;
  totalProjects: number;
  /** A project counts as covered once it has at least one backup file —
   *  this is a COVERAGE question, deliberately separate from FRESHNESS
   *  (oldestLatestBackupAgeMs below). A project can be covered but stale,
   *  or (if it has zero backups) uncovered regardless of age. */
  coveredProjects: number;
  uncoveredProjects: number;
  coveragePercent: number;
  /** Among covered projects only: the age of the single most
   *  out-of-date "most recent backup" — i.e. the freshness of the
   *  least-recently-backed-up project that has been backed up at all. */
  oldestLatestBackupAgeMs: number | null;
  oldestLatestBackupProjectId: string | null;
  warningAgeMs: number;
  criticalAgeMs: number;
}

export interface BackupHealthSummary {
  database: DatabaseBackupHealth;
  workspaces: WorkspaceBackupHealth;
}

function classifyAge(
  ageMs: number | null,
  warningAgeMs: number,
  criticalAgeMs: number,
): BackupHealthStatus {
  if (ageMs === null) return "never";
  if (ageMs > criticalAgeMs) return "critical";
  if (ageMs > warningAgeMs) return "stale";
  return "ok";
}

/**
 * Database backup health. Re-verifies backups newest-first via the same
 * `verifyDatabaseBackupIntegrity` (`PRAGMA integrity_check`) the backup
 * pipeline itself already uses, stopping at the first one that actually
 * passes — bounded by `cfg.maxDatabaseBackups` (default 10), so this is
 * at most a handful of single-file integrity checks per call, not an
 * unbounded scan. `listDatabaseBackups(cfg)` (no `{verify: true}`) is
 * used for the listing itself specifically so this doesn't pay to
 * re-verify every retained backup — only however many are checked before
 * the first valid one is found.
 */
export async function getDatabaseBackupHealth(
  cfg: AppConfig,
  now: number = Date.now(),
): Promise<DatabaseBackupHealth> {
  const warningAgeMs = cfg.backupHealthWarningAgeMs;
  const criticalAgeMs = cfg.backupHealthCriticalAgeMs;

  const backups = await listDatabaseBackups(cfg); // newest-first
  let latestValidCreatedAt: string | null = null;
  for (const backup of backups) {
    if (verifyDatabaseBackupIntegrity(backup.filePath) === "ok") {
      latestValidCreatedAt = backup.createdAt;
      break;
    }
  }

  const latestBackupAgeMs =
    latestValidCreatedAt === null
      ? null
      : now - new Date(latestValidCreatedAt).getTime();

  return {
    status: classifyAge(latestBackupAgeMs, warningAgeMs, criticalAgeMs),
    backupCount: backups.length,
    latestBackupCreatedAt: latestValidCreatedAt,
    latestBackupAgeMs,
    warningAgeMs,
    criticalAgeMs,
  };
}

/**
 * Workspace backup coverage + freshness across every project. Unlike the
 * database check above, listed workspace backups are NOT re-verified by
 * re-extracting their archives here: a workspace backup is fully
 * extraction-verified once, at creation time (`createWorkspaceBackup`'s
 * own `verifyArchiveExtractable` call), before it is ever durably
 * written — there is no in-place-mutation path that could silently
 * corrupt it afterward the way a bit-rotted SQLite file might. Doing a
 * full ZIP re-extraction per project on every health check (unlike one
 * bounded SQLite integrity_check system-wide for the database) would not
 * stay "cheap and bounded" as the number of projects grows, so listing
 * presence is treated as sufficient evidence of validity here — a
 * deliberate, documented asymmetry with the database check, not an
 * oversight.
 *
 * One `listWorkspaceBackups` call per project, each already cheap for an
 * uncovered project (an `existsSync` short-circuit before any directory
 * read) — bounded by the total project count, no new aggregate-scan
 * primitive introduced.
 */
export async function getWorkspaceBackupHealth(
  cfg: AppConfig,
  db: Db,
  now: number = Date.now(),
): Promise<WorkspaceBackupHealth> {
  const warningAgeMs = cfg.backupHealthWarningAgeMs;
  const criticalAgeMs = cfg.backupHealthCriticalAgeMs;

  const projectRows = db.prepare("SELECT id FROM projects").all() as Array<{
    id: string;
  }>;
  const totalProjects = projectRows.length;

  let coveredProjects = 0;
  let oldestLatestBackupAgeMs: number | null = null;
  let oldestLatestBackupProjectId: string | null = null;

  for (const { id: projectId } of projectRows) {
    const backups = await listWorkspaceBackups(cfg, projectId); // newest-first
    if (backups.length === 0) continue;
    coveredProjects++;
    const ageMs = now - new Date(backups[0].createdAt).getTime();
    if (oldestLatestBackupAgeMs === null || ageMs > oldestLatestBackupAgeMs) {
      oldestLatestBackupAgeMs = ageMs;
      oldestLatestBackupProjectId = projectId;
    }
  }

  const uncoveredProjects = totalProjects - coveredProjects;
  const coveragePercent =
    totalProjects === 0
      ? 100
      : Math.round((coveredProjects / totalProjects) * 100);

  let status: BackupHealthStatus;
  if (totalProjects === 0) {
    status = "ok"; // nothing to cover
  } else if (coveredProjects === 0) {
    status = "never";
  } else if (
    uncoveredProjects > 0 ||
    (oldestLatestBackupAgeMs !== null &&
      oldestLatestBackupAgeMs > criticalAgeMs)
  ) {
    status = "critical";
  } else if (
    oldestLatestBackupAgeMs !== null &&
    oldestLatestBackupAgeMs > warningAgeMs
  ) {
    status = "stale";
  } else {
    status = "ok";
  }

  return {
    status,
    totalProjects,
    coveredProjects,
    uncoveredProjects,
    coveragePercent,
    oldestLatestBackupAgeMs,
    oldestLatestBackupProjectId,
    warningAgeMs,
    criticalAgeMs,
  };
}

export async function getBackupHealthSummary(
  cfg: AppConfig,
  db: Db,
  now: number = Date.now(),
): Promise<BackupHealthSummary> {
  const [database, workspaces] = await Promise.all([
    getDatabaseBackupHealth(cfg, now),
    getWorkspaceBackupHealth(cfg, db, now),
  ]);
  return { database, workspaces };
}
