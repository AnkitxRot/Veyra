import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const IS_WINDOWS = process.platform === "win32";

export interface Limits {
  /** CPU seconds (rlimit, Linux only) */
  cpuSeconds: number;
  nofile: number;
  fsizeBytes: number;
  nproc: number;
  coreBytes: number;
  /** cgroup v2 cpu.max quota (Linux only) */
  cpuQuota: number;
  memoryBytes: number;
  pidsLimit: number;
}

export interface RunUser {
  user: string;
  uid: number;
  gid: number;
}

export interface AppConfig {
  port: number;
  adminUsername: string;
  dataDir: string;
  dbPath: string;
  cgroupRoot: string;
  runUser: RunUser;
  sessionTtlMs: number;
  runTimeoutMs: number;
  buildTimeoutMs: number;
  limits: Limits;
  workspacesDir: string;
  authRateLimit: { max: number; windowMs: number };
  minPasswordLength: number;
  projectQuota: number;
  maxConcurrentRuns: number;
  sandboxIdleTimeoutMs: number;
  sandboxReaperIntervalMs: number;
  sessionGcIntervalMs: number;
  demoAccountTtlMs: number;
  demoGcIntervalMs: number;
  trustProxy: boolean;
  cookieSecure: boolean;
  maxSandboxes: number;
  maxSandboxesPerUser: number;
  maxTerminalsPerUser: number;
  shutdownGraceMs: number;
  frontendDist: string;
  containerized: boolean;
  telemetryRetentionHours: number;
  telemetryFlushIntervalMs: number;
  telemetrySampleIntervalMs: number;
  maxSnapshotsPerProject: number;
  maxSnapshotBytesPerProject: number;
  maxSnapshotSizeBytes: number;
  maxArchiveUploadBytes: number;
  maxArchiveUncompressedBytes: number;
  maxArchiveEntries: number;
  maxArchiveSingleFileBytes: number;
  maxSingleUploadFileBytes: number;
  maxAggregateUploadBytes: number;
  maxUploadFileCount: number;
  backupDir: string;
  maxDatabaseBackups: number;
  maxBackupBytes: number;
  backupLockStaleMs: number;
  maxWorkspaceBackupsPerProject: number;
  maxWorkspaceBackupBytesPerProject: number;
  backupHealthWarningAgeMs: number;
  backupHealthCriticalAgeMs: number;
  /** M6: collaboration broadcast coalescing + backpressure. Kept
   *  env-configurable, like every other tunable in this file, specifically
   *  so the load harness can vary them without touching production code —
   *  see collab/manager.ts's DEFAULT_* constants for the actual defaults
   *  and the rationale for each. */
  collabYjsCoalesceMs: number;
  collabAwarenessCoalesceMs: number;
  collabHighWatermarkBytes: number;
  collabLowWatermarkBytes: number;
  /** M47: operator-supplied master key for project-secret encryption.
   *  Raw value exactly as configured (base64- or hex-encoded 32 bytes); the
   *  secrets crypto module validates/normalizes it. `undefined` when unset —
   *  the server still starts, but any operation that must decrypt an existing
   *  secret fails closed. NEVER logged, backed up, or returned by the API. */
  secretsMasterKey: string | undefined;
}

export const DEFAULT_LIMITS: Limits = {
  cpuSeconds: 5,
  nofile: 128,
  fsizeBytes: 10 * 1024 * 1024,
  nproc: 64,
  coreBytes: 0,
  cpuQuota: 100_000,
  memoryBytes: 512 * 1024 * 1024,
  pidsLimit: 64,
};

/**
 * Resolve the unprivileged user that will execute user code.
 *
 * On Linux: probe for `ide` or `nobody` via the `id` command.
 * On Windows: uid/gid are not used; we just record the current username.
 */
export function resolveRunUser(want: string): RunUser {
  if (IS_WINDOWS) {
    return { user: process.env.USERNAME ?? "user", uid: -1, gid: -1 };
  }

  const candidates = [want, "nobody"];
  for (const user of candidates) {
    try {
      const uid = parseInt(
        execFileSync("id", ["-u", user], { encoding: "utf8" }).trim(),
        10,
      );
      const gid = parseInt(
        execFileSync("id", ["-g", user], { encoding: "utf8" }).trim(),
        10,
      );
      return { user, uid, gid };
    } catch {
      // try next candidate
    }
  }
  // Last resort: use current process uid
  return {
    user: "current",
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
  };
}

export type ConfigOverrides = Partial<Omit<AppConfig, "runUser" | "limits">> & {
  runUser?: RunUser;
  limits?: Limits;
};

export function resolveConfig(overrides: ConfigOverrides = {}): AppConfig {
  const defaultDataDir = IS_WINDOWS
    ? join(homedir(), ".cloud-ide")
    : "/var/lib/cloud-ide";

  const dataDir = overrides.dataDir ?? process.env.DATA_DIR ?? defaultDataDir;
  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3000),
    adminUsername:
      overrides.adminUsername ?? process.env.ADMIN_USERNAME ?? "admin",
    dataDir,
    dbPath:
      overrides.dbPath ??
      process.env.DATABASE_PATH ??
      join(dataDir, "cloudide.db"),
    cgroupRoot:
      overrides.cgroupRoot ??
      process.env.CGROUP_ROOT ??
      "/sys/fs/cgroup/cloudide",
    runUser: overrides.runUser ?? resolveRunUser(process.env.RUN_USER ?? "ide"),
    sessionTtlMs: overrides.sessionTtlMs ?? 30 * 24 * 3600 * 1000,
    runTimeoutMs: overrides.runTimeoutMs ?? 15_000,
    buildTimeoutMs: overrides.buildTimeoutMs ?? 60_000,
    limits: overrides.limits ?? DEFAULT_LIMITS,
    workspacesDir: join(dataDir, "workspaces"),
    authRateLimit: overrides.authRateLimit ?? {
      max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20),
      windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000),
    },
    minPasswordLength:
      overrides.minPasswordLength ??
      Number(process.env.MIN_PASSWORD_LENGTH ?? 8),
    projectQuota:
      overrides.projectQuota ?? Number(process.env.PROJECT_QUOTA ?? 20),
    maxConcurrentRuns:
      overrides.maxConcurrentRuns ??
      Number(process.env.MAX_CONCURRENT_RUNS ?? 3),
    sandboxIdleTimeoutMs:
      overrides.sandboxIdleTimeoutMs ??
      Number(process.env.SANDBOX_IDLE_TIMEOUT_MS ?? 30 * 60_000),
    sandboxReaperIntervalMs:
      overrides.sandboxReaperIntervalMs ??
      Number(process.env.SANDBOX_REAPER_INTERVAL_MS ?? 60_000),
    sessionGcIntervalMs:
      overrides.sessionGcIntervalMs ??
      Number(process.env.SESSION_GC_INTERVAL_MS ?? 3_600_000),
    demoAccountTtlMs:
      overrides.demoAccountTtlMs ??
      Number(process.env.DEMO_ACCOUNT_TTL_MS ?? 2 * 3600 * 1000),
    demoGcIntervalMs:
      overrides.demoGcIntervalMs ??
      Number(process.env.DEMO_GC_INTERVAL_MS ?? 600_000),
    trustProxy:
      overrides.trustProxy ??
      (process.env.TRUST_PROXY !== undefined
        ? process.env.TRUST_PROXY === "1" ||
          process.env.TRUST_PROXY.toLowerCase() === "true"
        : false),
    cookieSecure:
      overrides.cookieSecure ??
      (process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === "1" ||
          process.env.COOKIE_SECURE.toLowerCase() === "true"
        : process.env.NODE_ENV === "production"),
    maxSandboxes:
      overrides.maxSandboxes ?? Number(process.env.MAX_SANDBOXES ?? 20),
    // Global maxSandboxes is a host-wide safety cap; this is the per-owner
    // fairness limit underneath it, so one user opening many projects can't
    // consume the whole host's sandbox budget alone. 5 is generous for
    // normal multi-project work while staying well under the default global
    // cap of 20 (mirrors projectQuota's per-owner convention).
    maxSandboxesPerUser:
      overrides.maxSandboxesPerUser ??
      Number(process.env.MAX_SANDBOXES_PER_USER ?? 5),
    // Terminal PTYs are a distinct resource class from live sandbox count (a
    // user can have many terminal tabs open against one project's single
    // sandbox), so they get their own budget — same reasoning as searchGate
    // being separate from runGate.
    maxTerminalsPerUser:
      overrides.maxTerminalsPerUser ??
      Number(process.env.MAX_TERMINALS_PER_USER ?? 5),
    // Defaults mirror collab/manager.ts's DEFAULT_* constants — duplicated
    // here as literals rather than imported, to keep this foundational
    // config module decoupled from collab internals.
    collabYjsCoalesceMs:
      overrides.collabYjsCoalesceMs ??
      Number(process.env.COLLAB_YJS_COALESCE_MS ?? 25),
    collabAwarenessCoalesceMs:
      overrides.collabAwarenessCoalesceMs ??
      Number(process.env.COLLAB_AWARENESS_COALESCE_MS ?? 50),
    collabHighWatermarkBytes:
      overrides.collabHighWatermarkBytes ??
      Number(process.env.COLLAB_HIGH_WATERMARK_BYTES ?? 1_000_000),
    collabLowWatermarkBytes:
      overrides.collabLowWatermarkBytes ??
      Number(process.env.COLLAB_LOW_WATERMARK_BYTES ?? 200_000),
    shutdownGraceMs:
      overrides.shutdownGraceMs ??
      Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000),
    frontendDist:
      overrides.frontendDist ??
      process.env.FRONTEND_DIST ??
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "frontend",
        "dist",
      ),
    containerized:
      overrides.containerized ??
      (process.env.APP_CONTAINERIZED === "1" ||
        process.env.APP_CONTAINERIZED === "true"),
    telemetryRetentionHours:
      overrides.telemetryRetentionHours ??
      Number(process.env.TELEMETRY_RETENTION_HOURS ?? 2),
    telemetryFlushIntervalMs:
      overrides.telemetryFlushIntervalMs ??
      Number(process.env.TELEMETRY_FLUSH_INTERVAL_MS ?? 5000),
    telemetrySampleIntervalMs:
      overrides.telemetrySampleIntervalMs ??
      Number(process.env.TELEMETRY_SAMPLE_INTERVAL_MS ?? 2000),
    maxSnapshotsPerProject:
      overrides.maxSnapshotsPerProject ??
      Number(process.env.MAX_SNAPSHOTS_PER_PROJECT ?? 10),
    maxSnapshotBytesPerProject:
      overrides.maxSnapshotBytesPerProject ??
      Number(process.env.MAX_SNAPSHOT_BYTES_PER_PROJECT ?? 20 * 1024 * 1024),
    maxSnapshotSizeBytes:
      overrides.maxSnapshotSizeBytes ??
      Number(process.env.MAX_SNAPSHOT_SIZE_BYTES ?? 5 * 1024 * 1024),
    maxArchiveUploadBytes:
      overrides.maxArchiveUploadBytes ??
      Number(process.env.MAX_ARCHIVE_UPLOAD_BYTES ?? 25 * 1024 * 1024),
    maxArchiveUncompressedBytes:
      overrides.maxArchiveUncompressedBytes ??
      Number(process.env.MAX_ARCHIVE_UNCOMPRESSED_BYTES ?? 50 * 1024 * 1024),
    maxArchiveEntries:
      overrides.maxArchiveEntries ??
      Number(process.env.MAX_ARCHIVE_ENTRIES ?? 1000),
    maxArchiveSingleFileBytes:
      overrides.maxArchiveSingleFileBytes ??
      Number(process.env.MAX_ARCHIVE_SINGLE_FILE_BYTES ?? 10 * 1024 * 1024),
    maxSingleUploadFileBytes:
      overrides.maxSingleUploadFileBytes ??
      Number(process.env.MAX_SINGLE_UPLOAD_FILE_BYTES ?? 10 * 1024 * 1024),
    maxAggregateUploadBytes:
      overrides.maxAggregateUploadBytes ??
      Number(process.env.MAX_AGGREGATE_UPLOAD_BYTES ?? 25 * 1024 * 1024),
    maxUploadFileCount:
      overrides.maxUploadFileCount ??
      Number(process.env.MAX_UPLOAD_FILE_COUNT ?? 500),
    backupDir:
      overrides.backupDir ?? process.env.BACKUP_DIR ?? join(dataDir, "backups"),
    maxDatabaseBackups:
      overrides.maxDatabaseBackups ??
      Number(process.env.MAX_DATABASE_BACKUPS ?? 10),
    maxBackupBytes:
      overrides.maxBackupBytes ??
      Number(process.env.MAX_BACKUP_BYTES ?? 100 * 1024 * 1024),
    // A non-numeric BACKUP_LOCK_STALE_MS would silently disable stale-lock
    // recovery (Date.now() - mtime > NaN is always false, so an abandoned
    // lock would block backups permanently) — fall back to the default
    // rather than propagate NaN.
    backupLockStaleMs:
      overrides.backupLockStaleMs ??
      (() => {
        const raw = Number(process.env.BACKUP_LOCK_STALE_MS);
        return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
      })(),
    maxWorkspaceBackupsPerProject:
      overrides.maxWorkspaceBackupsPerProject ??
      Number(process.env.MAX_WORKSPACE_BACKUPS_PER_PROJECT ?? 5),
    maxWorkspaceBackupBytesPerProject:
      overrides.maxWorkspaceBackupBytesPerProject ??
      Number(
        process.env.MAX_WORKSPACE_BACKUP_BYTES_PER_PROJECT ?? 250 * 1024 * 1024,
      ),
    // Defaults assume a once-daily backup cadence (the cron example in
    // deploy/README.md) with slack for the job simply running a bit late,
    // not a signal of a real problem: 26h tolerates one slow/delayed run
    // before warning; 48h (a full missed day) means the daily job has
    // failed outright, not just run late.
    backupHealthWarningAgeMs:
      overrides.backupHealthWarningAgeMs ??
      Number(process.env.BACKUP_HEALTH_WARNING_AGE_MS ?? 26 * 60 * 60 * 1000),
    backupHealthCriticalAgeMs:
      overrides.backupHealthCriticalAgeMs ??
      Number(process.env.BACKUP_HEALTH_CRITICAL_AGE_MS ?? 48 * 60 * 60 * 1000),
    // Deliberately NOT given a default: a silently auto-generated key would
    // become undecryptable across restarts and would defeat the "operator
    // must supply and safeguard the key" contract (see backend/src/secrets/
    // crypto.ts and deploy/README.md). Absent => secret-dependent operations
    // fail closed.
    secretsMasterKey:
      overrides.secretsMasterKey ?? process.env.SECRETS_MASTER_KEY ?? undefined,
  };
}
