import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { freemem, hostname } from "node:os";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { isDockerRunning, isDockerRunningAsync, isRunnerImageAvailableAsync } from "../tools.js";
import { ALLOWED_PREVIEW_PORTS } from "./previewPorts.js";
import { RunGate, globalRunGate, GLOBAL_RUN_KEY, runGate } from "./runGate.js";
import { terminalSessions } from "./terminalSessions.js";
import { languageServers } from "../lsp/manager.js";
import { debugSessions } from "../debug/manager.js";
import { recordAuditLog } from "../audit.js";
import {
  renderSecretsEnvFile,
  secretsExecPrefix,
  writeContainerSecretsFile,
  type ContainerSecretsFile,
} from "../projectsecrets/inject.js";
import { log } from "../logger.js";
import { resolveRuntimeImage } from "./runtime.js";
import { ApiError, errorInfo, serverBusy } from "../errors.js";

const execFileAsync = promisify(execFile);

/** M111: a sandbox must be idle this long before pressure-eviction may stop it. */
const EVICT_MIN_IDLE_MS = 15_000;

interface ProjectContainerInfo {
  containerId: string;
  ports: Record<number, number>;
  lastUsed: number;
  /** Owner charged against `sandboxGate` for this live container.
   *  Undefined only for entries adopted by `reconcile()` when the
   *  owning project's row could not be resolved. */
  ownerId: number | undefined;
  /** M74: true once the idle reaper has observed this project's
   *  collaboration room with >=1 live client. Gates the room-empty
   *  grace path so a never-occupied container (terminal-only, no
   *  provider) keeps pure `idleTimeoutMs` semantics. */
  roomEverOccupied: boolean;
  /** M74: timestamp the reaper first observed a previously-occupied
   *  room now empty; null while occupied or never observed empty. */
  roomEmptyAt: number | null;
  /** M111: container is `docker stop`ped (RAM freed) but kept, with its
   *  network, for a fast `docker start` resume. A stopped entry holds no
   *  `sandboxGate` slot and does not count against `maxSandboxes`. */
  stopped: boolean;
  stoppedAt: number | null;
}

/**
 * Per-owner live-sandbox count, separate from the global `maxSandboxes`
 * safety cap. Exported so tests can inspect/reset it directly (mirrors how
 * `getHeartbeatController` is exposed for the same reason in ws/index.ts).
 */
export const sandboxGate = new RunGate();

export interface SandboxController {
  writeStdin(data: string): void;
  kill(): void;
}

export interface SandboxOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** M47: project secrets to inject as environment variables. Delivered via
   *  a 0600 file streamed into the container's /run tmpfs (never on the host
   *  argv), then sourced by the target process. Omitted for install and for
   *  ai/verify runs. */
  secretEnv?: Record<string, string>;
  stdin?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onController?: (ctrl: SandboxController) => void;
  isCancelled?: () => boolean;
  timeoutMs: number;
  kind: "run" | "build";
  config: AppConfig;
  /** Charged against the per-owner sandbox quota if this call actually
   *  creates a new container (a no-op when the project's sandbox already
   *  exists and is running). */
  userId: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  oom: boolean;
  durationMs: number;
}

export interface ContainerStats {
  running: boolean;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
  netIO: string;
  blockIO: string;
}

function parseByteUnits(str: string): number {
  if (!str) return 0;
  const match = str.match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const num = parseFloat(match[1]!);
  const unit = (match[2] || "B").toLowerCase();
  if (unit.startsWith("k") || unit.startsWith("kib")) return Math.round(num * 1024);
  if (unit.startsWith("m") || unit.startsWith("mib")) return Math.round(num * 1024 * 1024);
  if (unit.startsWith("g") || unit.startsWith("gib")) return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num);
}

export function initCgroupRoot(_cgroupRoot: string): void {
  // cgroup v2 is managed per-container via Docker flags
}

export class SandboxManager {
  private static instance: SandboxManager;
  private projectContainers = new Map<string, ProjectContainerInfo>();
  /** In-flight creation sequences keyed by projectId, so concurrent callers share one `docker run`. */
  private creating = new Map<string, Promise<string>>();
  private provisionedNetworks = new Set<string>();
  private statsCache = new Map<string, { stats: ContainerStats; timestamp: number }>();
  private inFlightStats = new Map<string, Promise<ContainerStats>>();
  /**
   * Serializes sandbox *lifecycle* operations (the create-or-reuse decision
   * in ensureProjectSandbox, and teardown in stopProjectSandbox) per
   * projectId, so ownership accounting for the same project never executes
   * concurrently — different projectIds remain fully independent.
   *
   * This exists specifically to prevent a double-release of sandboxGate: an
   * ensureProjectSandbox() call that observes a container as stale (crashed,
   * externally removed) releases that dead entry's owner slot, and a
   * stopProjectSandbox() teardown also releases its captured owner's slot.
   * Without serialization, either pairing (stop racing a stale-triggering
   * ensure, or two concurrent stops) can both fire for the same live
   * container, releasing one owner's quota slot twice. A one-shot "wait if
   * something is already in flight" check does not close this — the other
   * operation can just as easily start *during* an await inside the first
   * one's critical section. Only strict per-project mutual exclusion does.
   */
  private lifecycleTail = new Map<string, Promise<void>>();
  private reaperTimer: NodeJS.Timeout | null = null;
  /**
   * Global admission reservations in flight: projectIds that have passed
   * the `maxSandboxes` check and are being provisioned, but are not yet in
   * `projectContainers` (provisioning is a multi-await Docker round trip —
   * `docker rm`, network inspect/create, `docker run`, `docker port`).
   *
   * `projectContainers.size` alone is NOT the current global load: it only
   * grows once provisioning *succeeds*, so a naive `size >= maxSandboxes`
   * check reads stale capacity for every concurrent creation racing the
   * same await window. Different projectIds are deliberately NOT
   * serialized against each other by `withProjectLock` (see its doc
   * comment), so N distinct new projects' admission checks can genuinely
   * run concurrently. A reservation here is added and checked with no
   * `await` in between (see `createProjectSandbox`), which is what makes
   * it atomic: JS never interleaves two synchronous statements across an
   * event-loop turn, so no concurrently-running check for a *different*
   * project can observe a stale pre-reservation count. Always released
   * exactly once — on success (superseded by the `projectContainers` entry
   * it becomes), or in a `finally` on any failure — so a rejected or
   * failed creation never permanently consumes capacity.
   */
  private reservedProjectIds = new Set<string>();

  /**
   * M74: injected by app.ts so the sandbox lifecycle can consult how many
   * live collaborators a project's room has. Consumption (keeping an occupied
   * project's container warm, releasing an empty one sooner) lands in a later
   * commit; this commit only wires the seam. Null in tests / before wiring.
   */
  private roomOccupancyProvider:
    ((projectId: string) => { liveClients: number; distinctUsers: number }) | null = null;
  private auditDb: Db | null = null;
  /** M111: host free-memory source; injectable so admission is testable. */
  private freeMemProvider: () => number = () => freemem();
  /** M111: one in-flight batched `docker stats` sweep at a time. */
  private batchStatsInFlight: Promise<Map<string, ContainerStats>> | null = null;

  static getInstance(): SandboxManager {
    if (!this.instance) this.instance = new SandboxManager();
    return this.instance;
  }

  /** M92: set the DB handle for audit trail instrumentation. */
  setDb(db: Db): void {
    this.auditDb = db;
  }

  /** M74: register the collaboration-room occupancy source (see app.ts). */
  setRoomOccupancyProvider(
    provider: (projectId: string) => {
      liveClients: number;
      distinctUsers: number;
    },
  ): void {
    this.roomOccupancyProvider = provider;
  }

  /** M74: current collaboration-room occupancy for a project. Safe zeros when
   *  no provider is registered. Read-only. */
  getRoomOccupancy(projectId: string): {
    liveClients: number;
    distinctUsers: number;
  } {
    return (
      this.roomOccupancyProvider?.(projectId) ?? {
        liveClients: 0,
        distinctUsers: 0,
      }
    );
  }

  /** M111 test seam: override the host free-memory reading (null restores). */
  setFreeMemProvider(provider: (() => number) | null): void {
    this.freeMemProvider = provider ?? (() => freemem());
  }

  private runningCount(): number {
    let n = 0;
    for (const info of this.projectContainers.values()) if (!info.stopped) n++;
    return n;
  }

  /** Observability-only gauge: current number of running tracked containers. */
  getActiveSandboxCount(): number {
    return this.runningCount();
  }

  /** M111: host-profile gauges for /metrics. */
  getHostMetrics(profileName: string): {
    freeMemoryBytes: number;
    sandboxesRunning: number;
    sandboxesStopped: number;
    gates: Record<string, number>;
    profile: string;
  } {
    return {
      freeMemoryBytes: this.freeMemProvider(),
      sandboxesRunning: this.runningCount(),
      sandboxesStopped: this.getStoppedSandboxCount(),
      gates: {
        run: runGate.totalActive(),
        global_run: globalRunGate.totalActive(),
        sandbox: sandboxGate.totalActive(),
      },
      profile: profileName,
    };
  }

  /** M111 gauge: containers kept in the stopped (RAM-free) tier. */
  getStoppedSandboxCount(): number {
    return this.projectContainers.size - this.runningCount();
  }

  /**
   * M74 observability: aggregate container-sharing / collaboration-room
   * occupancy across every tracked container. One occupancy-provider call per
   * container — bounded and safe to invoke on each `/observability` request.
   * With no provider registered every project reads as `{0,0}`.
   */
  getRoomOccupancyMetrics(): {
    containers: number;
    containersWithMultipleUsers: number;
    provisionedContainerRoomOccupancy: {
      totalLiveClients: number;
      totalDistinctUsers: number;
    };
  } {
    let containersWithMultipleUsers = 0;
    let totalLiveClients = 0;
    let totalDistinctUsers = 0;
    for (const projectId of this.projectContainers.keys()) {
      let occ: { liveClients: number; distinctUsers: number };
      try {
        occ = this.roomOccupancyProvider?.(projectId) ?? {
          liveClients: 0,
          distinctUsers: 0,
        };
      } catch {
        occ = { liveClients: 0, distinctUsers: 0 };
      }
      if (occ.distinctUsers >= 2) containersWithMultipleUsers++;
      totalLiveClients += occ.liveClients;
      totalDistinctUsers += occ.distinctUsers;
    }
    return {
      containers: this.projectContainers.size,
      containersWithMultipleUsers,
      provisionedContainerRoomOccupancy: {
        totalLiveClients,
        totalDistinctUsers,
      },
    };
  }

  /** Running containers plus in-flight reservations: the true current load
   *  against `maxSandboxes`, unlike `projectContainers.size` alone. Stopped
   *  containers hold no RAM and are not counted (M111). */
  private currentGlobalLoad(): number {
    return this.runningCount() + this.reservedProjectIds.size;
  }

  /** Runs `fn` exclusively for `projectId`: queued behind any other
   *  lifecycle operation already running for the same project, but never
   *  blocked by activity on a different project. */
  private async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.lifecycleTail.get(projectId) ?? Promise.resolve();
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    // Publish our slot in the queue before awaiting `prior`, so any caller
    // arriving synchronously right after us chains behind `next`, not
    // behind `prior` again.
    this.lifecycleTail.set(projectId, next);
    await prior;
    try {
      return await fn();
    } finally {
      releaseNext();
      // Only the last queued operation cleans up, so the map doesn't retain
      // a stale tail entry once every queued operation has finished.
      if (this.lifecycleTail.get(projectId) === next) {
        this.lifecycleTail.delete(projectId);
      }
    }
  }

  async ensureProjectSandbox(
    projectId: string,
    config: AppConfig,
    workspaceDir: string,
    userId: number,
  ): Promise<string> {
    return this.withProjectLock(projectId, () =>
      this.doEnsureProjectSandbox(projectId, config, workspaceDir, userId),
    );
  }

  private async doEnsureProjectSandbox(
    projectId: string,
    config: AppConfig,
    workspaceDir: string,
    userId: number,
  ): Promise<string> {
    let existing = this.projectContainers.get(projectId);
    if (existing?.stopped) {
      // M111: fast path — `docker start` the kept container. Any failure falls
      // back to a clean recreate (the stale container is removed by the
      // name-conflict path in provisionContainer).
      if (await this.resumeStoppedSandbox(projectId, existing, config, userId)) {
        return existing.containerId;
      }
      this.projectContainers.delete(projectId);
      this.statsCache.delete(projectId);
      existing = undefined;
    }
    if (existing) {
      const now = Date.now();
      if (now - existing.lastUsed < 2000) {
        existing.lastUsed = now;
        return existing.containerId;
      }
      try {
        const { stdout } = await execFileAsync("docker", [
          "inspect",
          "-f",
          "{{.State.Running}}",
          existing.containerId,
        ]);
        if (stdout.trim() === "true") {
          existing.lastUsed = now;
          return existing.containerId;
        }
      } catch {}
    }

    // Docker container names are unique: two concurrent callers for the same
    // project would race into `docker run --name ide-sandbox-<id>` and one of
    // them would fail. Share a single in-flight creation instead. The map is
    // keyed by projectId, so different projects never serialize against each
    // other, and the entry is cleared once the attempt settles so a failed
    // creation can be retried by a later caller.
    const inFlight = this.creating.get(projectId);
    if (inFlight) return inFlight;

    const creation = this.createProjectSandbox(
      projectId,
      config,
      workspaceDir,
      existing !== undefined,
      userId,
      existing?.ownerId,
    ).finally(() => {
      this.creating.delete(projectId);
    });
    this.creating.set(projectId, creation);
    return creation;
  }

  private async createProjectSandbox(
    projectId: string,
    config: AppConfig,
    workspaceDir: string,
    hasStaleEntry: boolean,
    userId: number,
    staleOwnerId: number | undefined,
  ): Promise<string> {
    // The previously tracked container for this project (if any) was found
    // not-running above — it died outside our control (crash, manual `docker
    // rm`, host restart without a clean stopProjectSandbox call). Free its
    // owner's per-user slot now. This function body runs at most once per
    // in-flight creation window (deduped via `this.creating`), so this can
    // never double-release even under concurrent callers.
    if (staleOwnerId !== undefined) {
      sandboxGate.release(staleOwnerId);
      // Drop the dead entry now, not just on success below — otherwise a
      // later stopProjectSandbox() call (e.g. this creation subsequently
      // fails) would still find it and release staleOwnerId a second time.
      this.projectContainers.delete(projectId);
    }

    // A stale-entry recreation (see above) is refreshing a slot that was
    // already counted — not a new admission request — so it never
    // reserves again, exactly matching the original `!hasStaleEntry` gate.
    const needsGlobalSlot = !hasStaleEntry;
    // M111: host RAM admission before taking any slot (may stop an LRU idle
    // sandbox; throws 503 server_busy when nothing can be freed).
    await this.ensureMemoryHeadroom(config, projectId);
    if (needsGlobalSlot) {
      if (this.currentGlobalLoad() >= config.maxSandboxes) {
        await this.reapIdleSandboxes(config.sandboxIdleTimeoutMs, config.sandboxRoomEmptyGraceMs);
      }
      if (this.currentGlobalLoad() >= config.maxSandboxes) {
        await this.evictLruIdle(projectId, 1);
      }
      // Atomic check-and-reserve: reading currentGlobalLoad() and adding to
      // reservedProjectIds happen with no `await` between them (see the
      // field's doc comment for why that's what makes this safe against a
      // concurrent creation for a DIFFERENT project).
      if (this.currentGlobalLoad() >= config.maxSandboxes) {
        throw serverBusy(`sandbox limit reached (max ${config.maxSandboxes})`);
      }
      this.assertMemoryReservable(config);
      this.reservedProjectIds.add(projectId);
    }

    // From here on, every exit path must either reach the success
    // `projectContainers.set()` below (which supersedes the reservation) or
    // release both the reservation just taken (if any) and the per-user
    // slot (if acquired) — a failed or rejected creation must never
    // permanently consume quota of either kind.
    try {
      if (!sandboxGate.acquire(userId, config.maxSandboxesPerUser)) {
        throw new Error(`per-user sandbox limit reached (max ${config.maxSandboxesPerUser})`);
      }

      let containerId: string;
      let portMapping: Record<number, number>;
      try {
        const provisioned = await this.provisionContainer(projectId, config, workspaceDir);
        containerId = provisioned.containerId;
        portMapping = provisioned.portMapping;
      } catch (err) {
        sandboxGate.release(userId);
        throw err;
      }

      this.projectContainers.set(projectId, {
        containerId,
        ports: portMapping,
        lastUsed: Date.now(),
        ownerId: userId,
        roomEverOccupied: false,
        roomEmptyAt: null,
        stopped: false,
        stoppedAt: null,
      });
      if (this.auditDb) {
        try {
          recordAuditLog(this.auditDb, {
            userId,
            projectId,
            eventType: "SANDBOX_CREATED",
            details: { containerId, isRecreation: hasStaleEntry },
          });
        } catch {}
      }
      return containerId;
    } finally {
      if (needsGlobalSlot) this.reservedProjectIds.delete(projectId);
    }
  }

  /**
   * M111: `docker start` a soft-stopped sandbox. Returns false (caller then
   * recreates) when the start fails. Throws server_busy when the host has no
   * headroom. Runs under the project lifecycle lock (called from
   * doEnsureProjectSandbox).
   */
  private async resumeStoppedSandbox(
    projectId: string,
    info: ProjectContainerInfo,
    config: AppConfig,
    userId: number,
  ): Promise<boolean> {
    await this.ensureMemoryHeadroom(config, projectId);
    if (this.currentGlobalLoad() >= config.maxSandboxes) {
      await this.reapIdleSandboxes(config.sandboxIdleTimeoutMs, config.sandboxRoomEmptyGraceMs);
    }
    if (this.currentGlobalLoad() >= config.maxSandboxes) {
      await this.evictLruIdle(projectId, 1);
    }
    // Atomic check-and-reserve (no await between), same as createProjectSandbox.
    if (this.currentGlobalLoad() >= config.maxSandboxes) {
      throw serverBusy(`sandbox limit reached (max ${config.maxSandboxes})`);
    }
    this.assertMemoryReservable(config);
    this.reservedProjectIds.add(projectId);
    try {
      const chargeTo = info.ownerId ?? userId;
      if (!sandboxGate.acquire(chargeTo, config.maxSandboxesPerUser)) {
        throw new Error(`per-user sandbox limit reached (max ${config.maxSandboxesPerUser})`);
      }
      try {
        await execFileAsync("docker", ["start", info.containerId]);
      } catch (err) {
        sandboxGate.release(chargeTo);
        log.warn(
          { projectId, err: errorInfo(err).message },
          "docker start failed; recreating sandbox",
        );
        return false;
      }
      info.ownerId = chargeTo;
      info.stopped = false;
      info.stoppedAt = null;
      info.ports = {};
      info.lastUsed = Date.now();
      info.roomEmptyAt = null;
      if (this.auditDb) {
        try {
          recordAuditLog(this.auditDb, {
            userId,
            projectId,
            eventType: "SANDBOX_CREATED",
            details: { containerId: info.containerId, resumed: true },
          });
        } catch {}
      }
      return true;
    } finally {
      this.reservedProjectIds.delete(projectId);
    }
  }

  /**
   * M111: tier-1 idle stop. `docker stop -t 2` frees the container's RAM while
   * keeping the container and its network for a fast `docker start`. Resolves
   * true when the sandbox ends up stopped. Skips (false) when the project has a
   * lifecycle op in flight, activity inside `minIdleMs`, or live clients. The
   * lock is requested synchronously after the in-flight check so it is
   * uncontended (no cross-project lock-order deadlock; see reapIdleSandboxes).
   */
  /** Count of in-flight sandboxRun calls per project (lastUsed is frozen during a run). */
  private activeExecs = new Map<string, number>();
  beginExec(projectId: string): void {
    this.activeExecs.set(projectId, (this.activeExecs.get(projectId) ?? 0) + 1);
  }
  endExec(projectId: string): void {
    const n = (this.activeExecs.get(projectId) ?? 0) - 1;
    if (n > 0) this.activeExecs.set(projectId, n);
    else this.activeExecs.delete(projectId);
    const info = this.projectContainers.get(projectId);
    if (info) info.lastUsed = Date.now();
  }

  private softStopIfIdle(projectId: string, minIdleMs: number, now = Date.now()): Promise<boolean> {
    if (this.lifecycleTail.has(projectId)) return Promise.resolve(false);
    return this.withProjectLock(projectId, async () => {
      const info = this.projectContainers.get(projectId);
      if (!info || info.stopped) return false;
      if ((this.activeExecs.get(projectId) ?? 0) > 0) return false;
      if (now - info.lastUsed < minIdleMs) return false;
      if (this.getRoomOccupancy(projectId).liveClients > 0) return false;
      if (terminalSessions.hasProject(projectId)) return false;
      try {
        if (debugSessions.hasLiveForProject(projectId)) return false;
      } catch {}
      try {
        languageServers.disposeProject(projectId);
      } catch {}
      try {
        await execFileAsync("docker", ["stop", "-t", "2", info.containerId]);
      } catch {
        // Could not stop gracefully — fall back to full teardown so the slot
        // accounting stays truthful.
        await this.performStop(projectId);
        return true;
      }
      info.stopped = true;
      info.stoppedAt = Date.now();
      info.ports = {};
      this.connectedNetworks.delete(projectId);
      this.statsCache.delete(projectId);
      this.inFlightStats.delete(projectId);
      if (info.ownerId !== undefined) sandboxGate.release(info.ownerId);
      if (this.auditDb) {
        try {
          recordAuditLog(this.auditDb, {
            userId: info.ownerId ?? null,
            projectId,
            eventType: "SANDBOX_STOPPED",
            details: { containerId: info.containerId, tier: "soft" },
          });
        } catch {}
      }
      return true;
    });
  }

  /** M111: soft-stop up to `count` least-recently-used idle running sandboxes
   *  (never `exceptProjectId`). Returns how many were stopped. */
  private async evictLruIdle(exceptProjectId: string, count: number): Promise<number> {
    const candidates = [...this.projectContainers.entries()]
      .filter(([id, info]) => id !== exceptProjectId && !info.stopped)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let stopped = 0;
    for (const [id] of candidates) {
      if (stopped >= count) break;
      if (await this.softStopIfIdle(id, EVICT_MIN_IDLE_MS)) stopped++;
    }
    return stopped;
  }

  /**
   * M111: admission control. When host free RAM is below one sandbox plus the
   * reserve, stop LRU idle sandboxes (re-reading free memory after each) and,
   * if that is not enough, refuse with 503 server_busy instead of swapping.
   */
  /** Synchronous re-check just before reserving: free RAM minus RAM already promised to in-flight creations. */
  private assertMemoryReservable(config: AppConfig): void {
    if (config.hostMemReserveBytes <= 0) return;
    const promised = this.reservedProjectIds.size * config.limits.memoryBytes;
    if (this.freeMemProvider() - promised < config.limits.memoryBytes + config.hostMemReserveBytes) {
      throw serverBusy("server_busy");
    }
  }

  private async ensureMemoryHeadroom(config: AppConfig, exceptProjectId: string): Promise<void> {
    if (config.hostMemReserveBytes <= 0) return;
    const need = config.limits.memoryBytes + config.hostMemReserveBytes;
    // Bound evictions by the deficit: sandboxes can free at most their own
    // limit each, so pressure from non-sandbox usage must not flush them all.
    const deficit = need - this.freeMemProvider();
    if (deficit <= 0) return;
    let budget = Math.ceil(deficit / config.limits.memoryBytes);
    while (this.freeMemProvider() < need) {
      if (budget-- <= 0 || (await this.evictLruIdle(exceptProjectId, 1)) === 0) {
        throw serverBusy("server_busy");
      }
    }
  }

  /** Docker provisioning steps only — no gate/map bookkeeping, so callers
   *  can wrap this precisely in a release-on-failure try/catch. */
  private async provisionContainer(
    projectId: string,
    config: AppConfig,
    workspaceDir: string,
  ): Promise<{ containerId: string; portMapping: Record<number, number> }> {
    const [dockerRunning, runnerAvailable] = await Promise.all([
      isDockerRunningAsync(),
      isRunnerImageAvailableAsync(),
      this.ensureProjectNetwork(projectId),
    ]);
    if (!dockerRunning) throw new Error("Docker daemon is not running");
    if (!runnerAvailable) throw new Error("cloudeeeide-runner:latest is not available");

    const containerId = `ide-sandbox-${projectId}`;

    // M108: per-project image from .veyra/runtime.json, restricted to RUNNER_IMAGES.
    const runtime = await resolveRuntimeImage(workspaceDir, config.runnerImages);
    if (runtime.fallbackReason) log.warn({ projectId, reason: runtime.fallbackReason }, "runtime.json ignored; using default runner image");

    const limits = config.limits;
    const previewPorts = [3000, 4173, 5173, 8000, 8080];
    const portArgs = config.containerized
      ? []
      : previewPorts.flatMap((p) => ["-p", `127.0.0.1::${p}`]);

    // Level 4 Sandbox Hardening Flags (Read-only root + tmpfs)
    const hardeningArgs = [
      "--read-only",
      "--tmpfs",
      `/tmp:rw,size=${config.hostProfile.tmpfsTmpMb}m,mode=1777`,
      "--tmpfs",
      `/run:rw,size=${config.hostProfile.tmpfsRunMb}m,mode=1777`,
      "--tmpfs",
      `/home/ide/.cache:rw,size=${config.hostProfile.tmpfsCacheMb}m,uid=1000,gid=1000,mode=0755`,
    ];

    const dockerArgs = [
      "run",
      "-d",
      "--name",
      containerId,
      "--label",
      "cloudeeeide.managed=true",
      "--label",
      `cloudeeeide.project=${projectId}`,
      "--label",
      `cloudeeeide.image=${runtime.image}`,
      "--network",
      `ide-net-${projectId}`,
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--memory",
      `${limits.memoryBytes}b`,
      "--cpus",
      String(limits.cpuQuota / 100_000),
      "--pids-limit",
      String(limits.pidsLimit),
      ...hardeningArgs,
      ...portArgs,
      "-v",
      `${workspaceDir}:/workspace`,
      "-w",
      "/workspace",
      "--user",
      "ide",
      "--pull",
      "never",
      "--entrypoint",
      "sleep",
      runtime.image,
      "infinity",
    ];

    try {
      await execFileAsync("docker", dockerArgs);
    } catch (err) {
      const msg = String(errorInfo(err).message || errorInfo(err).stderr || "");
      if (msg.includes("Conflict") || msg.includes("already in use")) {
        try {
          await execFileAsync("docker", ["rm", "-fv", containerId]);
        } catch {}
        await execFileAsync("docker", dockerArgs);
      } else {
        throw err;
      }
    }

    // Lazy port mapping: preview proxy ports are resolved on-demand in getProxyTarget()
    return { containerId, portMapping: {} };
  }

  private async ensureProjectNetwork(projectId: string): Promise<void> {
    if (!this.provisionedNetworks.has(projectId)) {
      try {
        await execFileAsync("docker", ["network", "create", `ide-net-${projectId}`]);
      } catch {}
      this.provisionedNetworks.add(projectId);
    }
  }

  async stopProjectSandbox(projectId: string): Promise<void> {
    // Queued behind any other lifecycle operation for this project (an
    // in-flight ensureProjectSandbox(), or another stopProjectSandbox()) via
    // the same lock ensureProjectSandbox uses — see withProjectLock's doc
    // comment. This is what makes "capture info, await docker calls, release
    // the owner's slot" safe: nothing else can be mid-way through its own
    // capture-and-release for this projectId while we run.
    return this.withProjectLock(projectId, () => this.performStop(projectId));
  }

  private async performStop(projectId: string): Promise<void> {
    // M79: every container-teardown path funnels through here (delete /
    // restore / import / admin stop / terminateSandbox / idle reaper). Kill
    // this project's terminal sessions — attached and detached — before the
    // container goes, so no `docker exec` PTY is orphaned and every held
    // terminalGate slot is released.
    try {
      terminalSessions.reapProject(projectId);
    } catch {}
    try {
      languageServers.disposeProject(projectId);
    } catch {}
    try {
      debugSessions.disposeProject(projectId);
    } catch {}
    const info = this.projectContainers.get(projectId);
    const cid = info ? info.containerId : `ide-sandbox-${projectId}`;
    try {
      await execFileAsync("docker", ["rm", "-fv", cid]);
    } catch {}
    try {
      await execFileAsync("docker", ["network", "rm", `ide-net-${projectId}`]);
    } catch {}
    // Release exactly once: `this.projectContainers.delete` below removes the
    // entry, so a repeat stopProjectSandbox() call on the same projectId
    // finds no `info` and correctly does nothing here.
    // A soft-stopped entry already released its slot (M111).
    if (info && info.ownerId !== undefined && !info.stopped) {
      sandboxGate.release(info.ownerId);
    }
    const ownerId = info?.ownerId;
    this.projectContainers.delete(projectId);
    this.connectedNetworks.delete(projectId);
    this.provisionedNetworks.delete(projectId);
    this.statsCache.delete(projectId);
    this.inFlightStats.delete(projectId);
    if (this.auditDb) {
      try {
        recordAuditLog(this.auditDb, {
          userId: ownerId ?? null,
          projectId,
          eventType: "SANDBOX_STOPPED",
          details: { containerId: cid },
        });
      } catch {}
    }
  }

  async cleanupAllSandboxes(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "-a",
        "-q",
        "-f",
        "label=cloudeeeide.managed=true",
      ]);
      const ids = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const id of ids) {
        try {
          await execFileAsync("docker", ["rm", "-fv", id]);
        } catch {}
      }

      const { stdout: netOut } = await execFileAsync("docker", [
        "network",
        "ls",
        "-q",
        "-f",
        "name=ide-net-",
      ]);
      const netIds = netOut
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const id of netIds) {
        try {
          await execFileAsync("docker", ["network", "rm", id]);
        } catch {}
      }
    } catch {}
    // M79: graceful shutdown — kill every detached terminal PTY too.
    try {
      terminalSessions.disposeAll();
    } catch {}
    try {
      languageServers.disposeAll("sandbox_cleanup");
    } catch {}
    try {
      debugSessions.disposeAll("sandbox_cleanup");
    } catch {}
    for (const info of this.projectContainers.values()) {
      if (info.ownerId !== undefined && !info.stopped) sandboxGate.release(info.ownerId);
    }
    this.projectContainers.clear();
    this.provisionedNetworks.clear();
    this.statsCache.clear();
    this.inFlightStats.clear();
  }

  getMappedPort(projectId: string, internalPort: number): number | null {
    const info = this.projectContainers.get(projectId);
    return info?.ports[internalPort] ?? null;
  }

  /** True when this project has a live sandbox container this process is
   *  tracking. Cheap, synchronous — no Docker round trip. */
  hasActiveSandbox(projectId: string): boolean {
    const info = this.projectContainers.get(projectId);
    return info !== undefined && !info.stopped;
  }

  private appContainerId: string | undefined;
  private connectedNetworks = new Set<string>();

  private resolveAppContainerId(): string | undefined {
    if (this.appContainerId === undefined) {
      const id = hostname().trim();
      this.appContainerId = id;
    }
    return this.appContainerId || undefined;
  }

  /** Idempotently attach the backend container to a project's sandbox network. */
  async connectAppToProjectNetwork(projectId: string): Promise<void> {
    const appId = this.resolveAppContainerId();
    if (!appId || this.connectedNetworks.has(projectId)) return;
    try {
      await execFileAsync("docker", ["network", "connect", `ide-net-${projectId}`, appId]);
      this.connectedNetworks.add(projectId);
    } catch {
      this.connectedNetworks.add(projectId);
    }
  }

  async getProxyTarget(
    projectId: string,
    internalPort: number,
    containerized: boolean,
  ): Promise<string | null> {
    if (!(ALLOWED_PREVIEW_PORTS as readonly unknown[]).includes(internalPort)) return null;

    const info = this.projectContainers.get(projectId);
    if (!info || info.stopped) return null;

    if (containerized) {
      await this.connectAppToProjectNetwork(projectId);
      return `http://${info.containerId}:${internalPort}`;
    }
    if (info.ports[internalPort] === undefined) {
      const ports = await this.readPortMapping(info.containerId);
      info.ports = ports;
    }
    if (info.ports[internalPort] === undefined) return null;
    return `http://127.0.0.1:${info.ports[internalPort]}`;
  }

  touch(projectId: string): void {
    const info = this.projectContainers.get(projectId);
    if (info && !info.stopped) info.lastUsed = Date.now();
  }

  async getAllActiveSandboxes(): Promise<
    Array<{
      projectId: string;
      containerId: string;
      lastUsed: number;
      ports: Record<number, number>;
    }>
  > {
    const list: Array<{
      projectId: string;
      containerId: string;
      lastUsed: number;
      ports: Record<number, number>;
    }> = [];
    for (const [projectId, info] of this.projectContainers.entries()) {
      if (info.stopped) continue; // M111: stopped sandboxes hold no resources
      list.push({
        projectId,
        containerId: info.containerId,
        lastUsed: info.lastUsed,
        ports: info.ports,
      });
    }
    return list;
  }

  async terminateSandbox(containerId: string): Promise<{ success: boolean; projectId?: string }> {
    if (!/^ide-sandbox-[a-zA-Z0-9_-]+$/.test(containerId)) {
      throw new Error("invalid container id: not a managed sandbox");
    }

    let foundProjectId: string | undefined;
    for (const [pId, info] of this.projectContainers.entries()) {
      if (info.containerId === containerId) {
        foundProjectId = pId;
        break;
      }
    }

    const projectId = foundProjectId || containerId.replace("ide-sandbox-", "");
    await this.stopProjectSandbox(projectId);
    return { success: true, projectId };
  }

  /**
   * Stops containers that are no longer needed.
   *
   * Base rule (unchanged): a container unused for `idleTimeoutMs` is reaped.
   *
   * M74: when a room-occupancy provider is registered
   * (`setRoomOccupancyProvider`), a project whose collaboration room has
   * `liveClients > 0` is kept warm regardless of `lastUsed`, and a room that
   * has emptied becomes eligible after `roomEmptyGraceMs` — sooner than the
   * full idle timeout — provided there has been no terminal/run activity in
   * that window either. A project that has never been observed with an
   * occupied room (terminal-only, or no provider) keeps the base rule only.
   *
   * `now` is injectable for deterministic tests. `roomEmptyGraceMs` defaults
   * to `Infinity`, which disables the grace path entirely (so existing
   * callers/tests behave exactly as before).
   */
  async reapIdleSandboxes(
    idleTimeoutMs: number,
    roomEmptyGraceMs = Infinity,
    now = Date.now(),
    stopAfterMs = Infinity,
  ): Promise<string[]> {
    const reaped: string[] = [];
    for (const projectId of [...this.projectContainers.keys()]) {
      // Skip a project with an in-flight lifecycle operation rather than
      // queuing behind it: this method can itself be called from inside
      // ensureProjectSandbox's own lock-held cap-pressure check (a
      // different projectId), and blocking here on another project's lock
      // while *our* caller holds ours would risk two projects reaping each
      // other at the same instant and deadlocking. A project actively
      // mid-creation/teardown isn't meaningfully "idle" anyway — it'll be
      // picked up by the next reap pass once it settles.
      if (this.lifecycleTail.has(projectId)) continue;
      // Re-read: the entry may have been replaced/removed since the snapshot.
      const info = this.projectContainers.get(projectId);
      if (!info) continue;

      // M74: consult collaboration-room occupancy. A throwing provider must
      // never break reaping — fall back to the base idle rule.
      let occ: { liveClients: number; distinctUsers: number } | undefined;
      try {
        occ = this.roomOccupancyProvider?.(projectId);
      } catch {
        occ = undefined;
      }

      if (occ && occ.liveClients > 0) {
        info.roomEverOccupied = true;
        info.roomEmptyAt = null;
        continue; // keep warm regardless of lastUsed
      }
      if (info.stopped) {
        // Tier 2: a stopped sandbox is removed only after the full idle timeout.
        if (now - info.lastUsed >= idleTimeoutMs) {
          await this.stopProjectSandbox(projectId);
          reaped.push(projectId);
        }
        continue;
      }
      if (occ && info.roomEverOccupied && info.roomEmptyAt === null) {
        info.roomEmptyAt = now; // first observation that the room is now empty
      }

      const idleEligible = now - info.lastUsed >= idleTimeoutMs;
      const graceEligible =
        info.roomEverOccupied &&
        info.roomEmptyAt !== null &&
        now - info.roomEmptyAt >= roomEmptyGraceMs &&
        now - info.lastUsed >= roomEmptyGraceMs;

      // Tier 1 (M111): stop (not remove) once idle past `stopAfterMs`, unless
      // full removal is already due.
      if (!idleEligible && !graceEligible && now - info.lastUsed >= stopAfterMs) {
        await this.softStopIfIdle(projectId, stopAfterMs, now);
        continue;
      }

      if (idleEligible || graceEligible) {
        await this.stopProjectSandbox(projectId);
        if (this.auditDb) {
          try {
            recordAuditLog(this.auditDb, {
              userId: info.ownerId ?? null,
              projectId,
              eventType: "SANDBOX_REAPED",
              details: { containerId: info.containerId, reason: "idle_timeout" },
            });
          } catch {}
        }
        reaped.push(projectId);
      }
    }
    return reaped;
  }

  startReaper(config: AppConfig): void {
    this.stopReaper();
    this.reaperTimer = setInterval(() => {
      this.reapIdleSandboxes(
        config.sandboxIdleTimeoutMs,
        config.sandboxRoomEmptyGraceMs,
        Date.now(),
        config.sandboxStopAfterMs,
      ).catch((err) => {
        log.error("[sandbox] reaper error:", err);
      });
    }, config.sandboxReaperIntervalMs);
    this.reaperTimer.unref();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /** Live real-time resource telemetry sampled from Docker daemon */
  async getContainerStats(projectId: string, maxAgeMs = 1000): Promise<ContainerStats> {
    const tracked = this.projectContainers.get(projectId);
    if (!tracked || tracked.stopped) {
      return {
        running: false,
        cpuPercent: 0,
        memoryUsageBytes: 0,
        memoryLimitBytes: 536870912,
        memoryPercent: 0,
        pids: 0,
        netIO: "0B / 0B",
        blockIO: "0B / 0B",
      };
    }

    const cached = this.statsCache.get(projectId);
    const now = Date.now();
    if (cached && now - cached.timestamp < maxAgeMs) {
      return cached.stats;
    }

    const inFlight = this.inFlightStats.get(projectId);
    if (inFlight) {
      return inFlight;
    }

    const fetchPromise = (async () => {
      const containerId = `ide-sandbox-${projectId}`;
      try {
        const { stdout } = await execFileAsync("docker", [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          containerId,
        ]);
        if (!stdout.trim()) {
          const fallback: ContainerStats = {
            running: false,
            cpuPercent: 0,
            memoryUsageBytes: 0,
            memoryLimitBytes: 536870912,
            memoryPercent: 0,
            pids: 0,
            netIO: "0B / 0B",
            blockIO: "0B / 0B",
          };
          this.statsCache.set(projectId, {
            stats: fallback,
            timestamp: Date.now(),
          });
          return fallback;
        }
        const parsed = JSON.parse(stdout.trim().split("\n")[0]!);
        const cpu = parseFloat((parsed.CPUPerc || "0%").replace("%", "")) || 0;
        const memPerc = parseFloat((parsed.MemPerc || "0%").replace("%", "")) || 0;

        const memUsageStr = parsed.MemUsage || "";
        let memUsageBytes = 0;
        let memLimitBytes = 536870912;
        if (memUsageStr.includes("/")) {
          const [u, l] = memUsageStr.split("/").map((s: string) => s.trim());
          memUsageBytes = parseByteUnits(u);
          memLimitBytes = parseByteUnits(l) || 536870912;
        }
        const pids = parseInt(parsed.PIDs, 10) || 0;
        const stats: ContainerStats = {
          running: true,
          cpuPercent: cpu,
          memoryUsageBytes: memUsageBytes,
          memoryLimitBytes: memLimitBytes,
          memoryPercent: memPerc,
          pids,
          netIO: parsed.NetIO || "0B / 0B",
          blockIO: parsed.BlockIO || "0B / 0B",
        };
        this.statsCache.set(projectId, {
          stats,
          timestamp: Date.now(),
        });
        return stats;
      } catch {
        const fallback: ContainerStats = {
          running: false,
          cpuPercent: 0,
          memoryUsageBytes: 0,
          memoryLimitBytes: 536870912,
          memoryPercent: 0,
          pids: 0,
          netIO: "0B / 0B",
          blockIO: "0B / 0B",
        };
        this.statsCache.set(projectId, {
          stats: fallback,
          timestamp: Date.now(),
        });
        return fallback;
      } finally {
        this.inFlightStats.delete(projectId);
      }
    })();

    this.inFlightStats.set(projectId, fetchPromise);
    return fetchPromise;
  }

  /**
   * M111: one `docker stats --no-stream` call for every running sandbox
   * (instead of one process per sandbox). Populates the per-project stats
   * cache that getContainerStats() reads. Returns the in-flight sweep when one
   * is already running, so a slow daemon never stacks spawns.
   */
  getAllContainerStats(): Promise<Map<string, ContainerStats>> {
    if (this.batchStatsInFlight) return this.batchStatsInFlight;
    const run = (async () => {
      const out = new Map<string, ContainerStats>();
      const ids = [...this.projectContainers.entries()]
        .filter(([, info]) => !info.stopped)
        .map(([projectId, info]) => [projectId, info.containerId] as const);
      if (ids.length === 0) return out;
      let stdout = "";
      try {
        ({ stdout } = await execFileAsync("docker", [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          ...ids.map(([, cid]) => cid),
        ]));
      } catch (err) {
        // A missing/failing container makes docker exit non-zero but the other
        // rows are still on stdout; keep them instead of dropping the tick.
        const partial = (err as { stdout?: unknown }).stdout;
        if (typeof partial !== "string" || !partial.trim()) return out;
        stdout = partial;
      }
      const byName = new Map(ids.map(([projectId, cid]) => [cid, projectId]));
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, string>;
          const projectId = byName.get(parsed.Name ?? parsed.Container ?? "");
          if (!projectId) continue;
          const stats = this.parseStatsRow(parsed);
          out.set(projectId, stats);
          this.statsCache.set(projectId, { stats, timestamp: Date.now() });
        } catch {}
      }
      return out;
    })().finally(() => {
      this.batchStatsInFlight = null;
    });
    this.batchStatsInFlight = run;
    return run;
  }

  private parseStatsRow(parsed: Record<string, string>): ContainerStats {
    const cpu = parseFloat((parsed.CPUPerc || "0%").replace("%", "")) || 0;
    const memPerc = parseFloat((parsed.MemPerc || "0%").replace("%", "")) || 0;
    let memUsageBytes = 0;
    let memLimitBytes = 536870912;
    const memUsageStr = parsed.MemUsage || "";
    if (memUsageStr.includes("/")) {
      const [u, l] = memUsageStr.split("/").map((x: string) => x.trim());
      memUsageBytes = parseByteUnits(u!);
      memLimitBytes = parseByteUnits(l!) || 536870912;
    }
    return {
      running: true,
      cpuPercent: cpu,
      memoryUsageBytes: memUsageBytes,
      memoryLimitBytes: memLimitBytes,
      memoryPercent: memPerc,
      pids: parseInt(parsed.PIDs ?? "", 10) || 0,
      netIO: parsed.NetIO || "0B / 0B",
      blockIO: parsed.BlockIO || "0B / 0B",
    };
  }

  private async readPortMapping(containerId: string): Promise<Record<number, number>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const mapping: Record<number, number> = {};
      try {
        const { stdout } = await execFileAsync("docker", ["port", containerId]);
        for (const line of stdout.split("\n")) {
          const match = line.match(/^(\d+)\/tcp\s+->\s+.*:(\d+)$/);
          if (match) mapping[parseInt(match[1]!, 10)] = parseInt(match[2]!, 10);
        }
        if (Object.keys(mapping).length > 0) return mapping;
      } catch {}
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
    return {};
  }

  private async dockerListing(args: string[]): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await execFileAsync("docker", args);
        return res.stdout;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    return null;
  }

  async reconcile(config: AppConfig, db: Db): Promise<void> {
    if (!isDockerRunning()) return;

    let listing = "";
    const psOut = await this.dockerListing([
      "ps",
      "-a",
      "-f",
      "label=cloudeeeide.managed=true",
      "--format",
      "{{.Names}}\t{{.State}}",
    ]);
    if (psOut === null) return;
    listing = psOut;

    const projectExists = (projectId: string): boolean => {
      const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
      return row !== undefined;
    };

    const ownerOf = (projectId: string): number | undefined => {
      const row = db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(projectId) as
        { owner_id?: number } | undefined;
      return row?.owner_id;
    };

    for (const line of listing.split("\n")) {
      const [name, state] = line.split("\t");
      if (!name || !name.startsWith("ide-sandbox-")) continue;
      const projectId = name.slice("ide-sandbox-".length);

      if (!projectExists(projectId)) {
        await this.stopProjectSandbox(projectId);
        continue;
      }
      const stateNorm = state?.trim().toLowerCase();
      if (stateNorm === "exited" && !this.projectContainers.has(projectId)) {
        // M111: adopt a soft-stopped container so it can be resumed with
        // `docker start`; no gate slot (stopped entries don't count).
        this.projectContainers.set(projectId, {
          containerId: name,
          ports: await this.readPortMapping(name).catch(() => ({}) as any),
          lastUsed: Date.now(),
          ownerId: ownerOf(projectId),
          roomEverOccupied: false,
          roomEmptyAt: null,
          stopped: true,
          stoppedAt: Date.now(),
        });
        continue;
      }
      if (stateNorm === "running") {
        const ports = await this.readPortMapping(name);
        const ownerId = ownerOf(projectId);
        // Only account for a container the first time this process adopts
        // it — reconcile() re-running (e.g. a future periodic health pass)
        // must not re-increment sandboxGate for a container it already
        // knows about. Adopting a container that already exists from a
        // prior process life must still reflect reality in sandboxGate,
        // regardless of the current per-user max: this is accounting for
        // an already-live resource, not a new creation request to admit or
        // reject, so acquire() uses an unbounded ceiling.
        if (ownerId !== undefined && !this.projectContainers.has(projectId)) {
          sandboxGate.acquire(ownerId, Number.POSITIVE_INFINITY);
        }
        this.projectContainers.set(projectId, {
          containerId: name,
          ports,
          lastUsed: Date.now(),
          ownerId,
          roomEverOccupied: false,
          roomEmptyAt: null,
          stopped: false,
          stoppedAt: null,
        });
      }
    }

    const netOut = await this.dockerListing([
      "network",
      "ls",
      "--format",
      "{{.Name}}",
      "-f",
      "name=ide-net-",
    ]);
    if (netOut !== null) {
      for (const netName of netOut.split("\n")) {
        if (!netName.startsWith("ide-net-")) continue;
        const projectId = netName.slice("ide-net-".length);
        if (!projectExists(projectId) && !this.projectContainers.has(projectId)) {
          try {
            await execFileAsync("docker", ["network", "rm", netName]);
          } catch {}
        }
      }
    }
  }
}

export const sandboxManager = SandboxManager.getInstance();

/**
 * Wrap a sandbox child's stdin so a write that loses the race with the child
 * exiting first cannot crash the backend.
 *
 * `docker exec -i` forwards our stdin to the sandboxed process. When that
 * process ends on its own, is SIGKILLed by a `stop`, or simply never reads
 * stdin, the pipe's read end goes away and the next write (or `.end()`) emits
 * an 'error' ('EPIPE' / 'ERR_STREAM_DESTROYED') on the stdin stream. A Node
 * stream with no 'error' listener rethrows it as an uncaughtException that
 * takes down the whole process — the same "per-connection emitter needs its
 * own 'error' listener" failure the /ws/execute malformed-frame fix addressed
 * (see backend/test/ws.test.ts). A stdin keystroke that arrives after the
 * process is already gone is expected here, not fatal: the run has ended and
 * the execution socket's `finish()` will drop the controller a moment later.
 */
export function makeStdinWriter(child: ChildProcessWithoutNullStreams): (data: string) => void {
  child.stdin.on("error", () => {});
  return (data: string) => {
    if (child.stdin.writable) child.stdin.write(data);
  };
}

/**
 * M111: host-wide concurrent-process cap. A run/build/install over the cap is
 * refused with 503 server_busy (ApiError — REST maps it, WS sends a coded
 * error) rather than queued, so a weak host never stacks CPU-bound work.
 */
export async function sandboxRun(
  projectId: string,
  workspaceDir: string,
  opts: SandboxOptions,
): Promise<SandboxResult> {
  if (!globalRunGate.acquire(GLOBAL_RUN_KEY, opts.config.maxGlobalRuns)) {
    throw serverBusy("server_busy");
  }
  sandboxManager.beginExec(projectId);
  try {
    return await sandboxRunInner(projectId, workspaceDir, opts);
  } finally {
    sandboxManager.endExec(projectId);
    globalRunGate.release(GLOBAL_RUN_KEY);
  }
}

async function sandboxRunInner(
  projectId: string,
  workspaceDir: string,
  opts: SandboxOptions,
): Promise<SandboxResult> {
  const start = Date.now();

  if (!(await isDockerRunningAsync())) {
    return {
      stdout: "",
      stderr: "[sandbox] execution failed: Docker daemon is not running.",
      exitCode: null,
      signal: null,
      timedOut: false,
      oom: false,
      durationMs: Date.now() - start,
    };
  }

  let containerId: string;
  try {
    containerId = await sandboxManager.ensureProjectSandbox(
      projectId,
      opts.config,
      workspaceDir,
      opts.userId,
    );
    sandboxManager.touch(projectId);
  } catch (err) {
    if (err instanceof ApiError) throw err; // M111: server_busy -> 503 / coded WS error
    return {
      stdout: "",
      stderr: `[sandbox] failed to start project container: ${errorInfo(err).message}`,
      exitCode: null,
      signal: null,
      timedOut: false,
      oom: false,
      durationMs: Date.now() - start,
    };
  }

  // The client can disconnect at any point while the container is being
  // started (a `docker inspect` round-trip, or a full `docker run` + network
  // setup). `onController` is only handed out below, once the process exists,
  // so a close during that window has nothing to kill. Bail here — the single
  // choke point every compile- and run-phase call passes through — rather than
  // spawning work for a client that is already gone.
  if (opts.isCancelled?.()) {
    return {
      stdout: "",
      stderr: "[sandbox] execution cancelled: client disconnected before the process started",
      exitCode: null,
      signal: null,
      timedOut: false,
      oom: false,
      durationMs: Date.now() - start,
    };
  }

  const execArgs = ["exec", "-i", "-w", "/workspace"];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      execArgs.push("-e", `${k}=${v}`);
    }
  }

  // M47: stage project secrets into the container as a 0600 file (never on
  // the host argv), then have the target process source it. Values are not
  // passed via `docker exec -e`.
  let secretsFile: ContainerSecretsFile | null = null;
  if (opts.secretEnv && Object.keys(opts.secretEnv).length > 0) {
    const content = renderSecretsEnvFile(opts.secretEnv);
    if (content.length > 0) {
      try {
        secretsFile = await writeContainerSecretsFile(containerId, content);
      } catch (err) {
        return {
          stdout: "",
          stderr: `[sandbox] failed to prepare project secrets: ${errorInfo(err).message ?? err}`,
          exitCode: null,
          signal: null,
          timedOut: false,
          oom: false,
          durationMs: Date.now() - start,
        };
      }
    }
  }

  if (secretsFile) {
    // `sh -c '<script>' sh <command> <args...>` — $0 is the label "sh",
    // "$@" is <command> <args...>. The command and its args stay as
    // separate, non-secret argv entries; only the file path (a UUID) is
    // interpolated.
    execArgs.push(containerId, ...secretsExecPrefix(secretsFile.path), opts.command, ...opts.args);
  } else {
    execArgs.push(containerId, opts.command, ...opts.args);
  }

  const cleanupSecrets = async () => {
    if (secretsFile) {
      const f = secretsFile;
      secretsFile = null;
      await f.cleanup();
    }
  };

  const child = spawn("docker", execArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let spawnError: string | null = null;

  child.stdout.on("data", (d: Buffer) => {
    const s = d.toString("utf8");
    stdout += s;
    if (opts.onStdout) opts.onStdout(s);
  });
  child.stderr.on("data", (d: Buffer) => {
    const s = d.toString("utf8");
    stderr += s;
    if (opts.onStderr) opts.onStderr(s);
  });
  child.on("error", (err) => {
    spawnError = err.message;
  });

  const killProcess = () => {
    child.kill("SIGKILL");
  };

  // Guards every subsequent stdin write/end against a post-exit pipe error
  // (an interactive program that returns, a `stop` SIGKILL, or a process
  // that never reads stdin) escalating to a backend-wide uncaughtException.
  const writeStdin = makeStdinWriter(child);

  if (opts.onController) {
    opts.onController({
      writeStdin,
      kill: killProcess,
    });
  }

  if (typeof opts.stdin === "string") {
    writeStdin(opts.stdin);
    child.stdin.end();
  } else if (!opts.onController) {
    child.stdin.end();
  }

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    killProcess();
  }, opts.timeoutMs);

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on("close", (c, s) => resolve([c, s]));
    child.on("error", () => resolve([null, null]));
  });

  clearTimeout(watchdog);
  await cleanupSecrets();

  // M74: the touch at run start freezes lastUsed for the whole run; refresh it
  // on completion so a project a user just watched finish is not treated as
  // idle-since-the-run-began by the reaper.
  sandboxManager.touch(projectId);

  if (spawnError) {
    stderr = `${stderr}\n[sandbox] failed to exec process: ${spawnError}`.trim();
  }

  return {
    stdout,
    stderr,
    exitCode: code,
    signal: signal ?? null,
    timedOut,
    oom: !timedOut && code === 137,
    durationMs: Date.now() - start,
  };
}
