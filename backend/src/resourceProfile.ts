import { cpus, totalmem } from "node:os";

/**
 * M111: host resource profile. `low` shrinks per-sandbox limits and the shared
 * caps (LSP, debug, runs, telemetry) so one weak host (2-4 GiB RAM, <=2 cores)
 * can serve many users; `standard` keeps the historical defaults. Pure: callers
 * pass host facts so selection is testable. Explicit env vars still win — see
 * resolveConfig().
 */
export type HostProfileSetting = "auto" | "low" | "standard";
export type HostProfileName = "low" | "standard";

export interface HostFacts {
  totalMemBytes: number;
  cpuCount: number;
}

export interface HostProfile {
  name: HostProfileName;
  memoryBytes: number;
  cpuQuota: number;
  pidsLimit: number;
  /** Sizes (MiB) of the sandbox tmpfs mounts. */
  tmpfsTmpMb: number;
  tmpfsRunMb: number;
  tmpfsCacheMb: number;
  maxSandboxes: number;
  maxLspServers: number;
  maxLspServersPerProject: number;
  lspIdleTimeoutMs: number;
  maxDebugSessions: number;
  maxDebugSessionsPerProject: number;
  /** Per-user concurrent runs. */
  maxConcurrentRuns: number;
  /** Host-wide concurrent runs. */
  maxGlobalRuns: number;
  telemetrySampleIntervalMs: number;
  /** Idle time before a sandbox is `docker stop`ped (kept, RAM freed). */
  sandboxStopAfterMs: number;
  /** Free host RAM kept back when admitting a sandbox. */
  memReserveBytes: number;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export function detectHostFacts(): HostFacts {
  return { totalMemBytes: totalmem(), cpuCount: Math.max(1, cpus().length) };
}

export function parseHostProfileSetting(raw: string | undefined): HostProfileSetting {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "low" || v === "standard" ? v : "auto";
}

export function selectProfileName(setting: HostProfileSetting, facts: HostFacts): HostProfileName {
  if (setting === "low" || setting === "standard") return setting;
  return facts.totalMemBytes < 4 * GiB || facts.cpuCount <= 2 ? "low" : "standard";
}

export function resolveHostProfile(
  setting: HostProfileSetting,
  facts: HostFacts = detectHostFacts(),
): HostProfile {
  const cpuCount = Math.max(1, facts.cpuCount);
  if (selectProfileName(setting, facts) === "standard") {
    return {
      name: "standard",
      memoryBytes: 512 * MiB,
      cpuQuota: 100_000,
      // Docker's --pids-limit counts threads; see DEFAULT_LIMITS (M86).
      pidsLimit: 256,
      tmpfsTmpMb: 64,
      tmpfsRunMb: 16,
      tmpfsCacheMb: 64,
      maxSandboxes: 20,
      maxLspServers: 8,
      maxLspServersPerProject: 2,
      lspIdleTimeoutMs: 120_000,
      maxDebugSessions: 4,
      maxDebugSessionsPerProject: 2,
      maxConcurrentRuns: 3,
      maxGlobalRuns: cpuCount,
      telemetrySampleIntervalMs: 2_000,
      sandboxStopAfterMs: 10 * 60_000,
      memReserveBytes: 256 * MiB,
    };
  }
  const memoryBytes = 256 * MiB;
  const fit = Math.floor((facts.totalMemBytes - GiB) / memoryBytes);
  return {
    name: "low",
    memoryBytes,
    cpuQuota: 50_000,
    pidsLimit: 128,
    tmpfsTmpMb: 32,
    tmpfsRunMb: 8,
    tmpfsCacheMb: 32,
    maxSandboxes: Math.min(20, Math.max(1, fit)),
    maxLspServers: 2,
    maxLspServersPerProject: 1,
    lspIdleTimeoutMs: 60_000,
    maxDebugSessions: 1,
    maxDebugSessionsPerProject: 1,
    maxConcurrentRuns: 1,
    maxGlobalRuns: cpuCount,
    telemetrySampleIntervalMs: 15_000,
    sandboxStopAfterMs: 3 * 60_000,
    memReserveBytes: 256 * MiB,
  };
}
