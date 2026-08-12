import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';

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
  dataDir: string;
  dbPath: string;
  cgroupRoot: string;
  runUser: RunUser;
  sessionTtlMs: number;
  runTimeoutMs: number;
  buildTimeoutMs: number;
  limits: Limits;
  workspacesDir: string;
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
    return { user: process.env.USERNAME ?? 'user', uid: -1, gid: -1 };
  }

  const candidates = [want, 'nobody'];
  for (const user of candidates) {
    try {
      const uid = parseInt(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim(), 10);
      const gid = parseInt(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim(), 10);
      return { user, uid, gid };
    } catch {
      // try next candidate
    }
  }
  // Last resort: use current process uid
  return { user: 'current', uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
}

export type ConfigOverrides = Partial<Omit<AppConfig, 'runUser' | 'limits'>> & {
  runUser?: RunUser;
  limits?: Limits;
};

export function resolveConfig(overrides: ConfigOverrides = {}): AppConfig {
  const defaultDataDir = IS_WINDOWS
    ? join(homedir(), '.cloud-ide')
    : '/var/lib/cloud-ide';

  const dataDir = overrides.dataDir ?? process.env.DATA_DIR ?? defaultDataDir;
  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3000),
    dataDir,
    dbPath: overrides.dbPath ?? process.env.DATABASE_PATH ?? join(dataDir, 'cloudide.db'),
    cgroupRoot: overrides.cgroupRoot ?? process.env.CGROUP_ROOT ?? '/sys/fs/cgroup/cloudide',
    runUser: overrides.runUser ?? resolveRunUser(process.env.RUN_USER ?? 'ide'),
    sessionTtlMs: overrides.sessionTtlMs ?? 30 * 24 * 3600 * 1000,
    runTimeoutMs: overrides.runTimeoutMs ?? 15_000,
    buildTimeoutMs: overrides.buildTimeoutMs ?? 60_000,
    limits: overrides.limits ?? DEFAULT_LIMITS,
    workspacesDir: join(dataDir, 'workspaces'),
  };
}
