import { z } from "zod";

/** Numeric env vars read by resolveConfig(). Non-negative numbers; PORT is 1-65535. */
export const ENV_NUMBER_KEYS = [
  "AUDIT_GC_INTERVAL_MS", "AUTH_RATE_LIMIT_MAX", "AUTH_RATE_LIMIT_WINDOW_MS",
  "BACKUP_HEALTH_CRITICAL_AGE_MS", "BACKUP_HEALTH_WARNING_AGE_MS", "BACKUP_LOCK_STALE_MS",
  "COLLAB_AWARENESS_COALESCE_MS", "COLLAB_HIGH_WATERMARK_BYTES", "COLLAB_LOW_WATERMARK_BYTES",
  "COLLAB_YJS_COALESCE_MS", "DEMO_ACCOUNT_TTL_MS", "DEMO_GC_INTERVAL_MS",
  "MAX_AGGREGATE_UPLOAD_BYTES", "MAX_ARCHIVE_ENTRIES", "MAX_ARCHIVE_SINGLE_FILE_BYTES",
  "MAX_ARCHIVE_UNCOMPRESSED_BYTES", "MAX_ARCHIVE_UPLOAD_BYTES", "MAX_BACKUP_BYTES",
  "MAX_CONCURRENT_RUNS", "MAX_DATABASE_BACKUPS", "MAX_SANDBOXES", "MAX_SANDBOXES_PER_USER",
  "MAX_SINGLE_UPLOAD_FILE_BYTES", "MAX_SNAPSHOTS_PER_PROJECT", "MAX_SNAPSHOT_BYTES_PER_PROJECT",
  "MAX_SNAPSHOT_SIZE_BYTES", "MAX_TERMINALS_PER_USER", "MAX_UPLOAD_FILE_COUNT",
  "MAX_WORKSPACE_BACKUPS_PER_PROJECT", "MAX_WORKSPACE_BACKUP_BYTES_PER_PROJECT",
  "MIN_PASSWORD_LENGTH", "PROJECT_QUOTA", "SANDBOX_IDLE_TIMEOUT_MS", "SANDBOX_REAPER_INTERVAL_MS",
  "SESSION_GC_INTERVAL_MS", "SHUTDOWN_GRACE_MS", "TELEMETRY_FLUSH_INTERVAL_MS",
  "TELEMETRY_RETENTION_HOURS", "TELEMETRY_SAMPLE_INTERVAL_MS",
] as const;

export const ENV_BOOL_KEYS = ["TRUST_PROXY", "COOKIE_SECURE", "APP_CONTAINERIZED"] as const;

const num = z
  .string()
  .trim()
  .refine((v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0, "must be a non-negative number");
const bool = z.string().trim().toLowerCase().pipe(z.enum(["1", "0", "true", "false"]));

const shape: Record<string, z.ZodType> = {
  PORT: z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535, "must be an integer 1-65535"),
};
for (const k of ENV_NUMBER_KEYS) shape[k] = num;
for (const k of ENV_BOOL_KEYS) shape[k] = bool;

const envSchema = z.object(shape).partial();

/** Validates the environment; throws one Error listing every bad variable. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const picked: Record<string, string> = {};
  for (const k of Object.keys(shape)) {
    const v = env[k];
    if (v !== undefined && v !== "") picked[k] = v;
  }
  const res = envSchema.safeParse(picked);
  if (res.success) return;
  const lines = res.error.issues.map((i) => `  - ${String(i.path[0])}: ${i.message} (got "${picked[String(i.path[0])]}")`);
  throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
}
