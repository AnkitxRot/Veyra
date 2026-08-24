import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import {
  isDockerRunning,
  isDockerRunningAsync,
  isRunnerImageAvailableAsync,
} from "../tools.js";
import { ALLOWED_PREVIEW_PORTS } from "./previewPorts.js";
import { RunGate } from "./runGate.js";

const execFileAsync = promisify(execFile);

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
  const num = parseFloat(match[1]);
  const unit = (match[2] || "B").toLowerCase();
  if (unit.startsWith("k") || unit.startsWith("kib"))
    return Math.round(num * 1024);
  if (unit.startsWith("m") || unit.startsWith("mib"))
    return Math.round(num * 1024 * 1024);
  if (unit.startsWith("g") || unit.startsWith("gib"))
    return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num);
}

export function initCgroupRoot(_cgroupRoot: string): void {
  // cgroup v2 is managed per-container via Docker flags
}

export class SandboxManager {
  private static instance: SandboxManager;
  private projectContainers = new Map<
    string,
    {
      containerId: string;
      ports: Record<number, number>;
      lastUsed: number;
      /** Owner charged against `sandboxGate` for this live container.
       *  Undefined only for entries adopted by `reconcile()` when the
       *  owning project's row could not be resolved. */
      ownerId: number | undefined;
    }
  >();
  /** In-flight creation sequences keyed by projectId, so concurrent callers share one `docker run`. */
  private creating = new Map<string, Promise<string>>();
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

  static getInstance(): SandboxManager {
    if (!this.instance) this.instance = new SandboxManager();
    return this.instance;
  }

  /** Observability-only gauge: current number of tracked live containers. */
  getActiveSandboxCount(): number {
    return this.projectContainers.size;
  }

  /** Runs `fn` exclusively for `projectId`: queued behind any other
   *  lifecycle operation already running for the same project, but never
   *  blocked by activity on a different project. */
  private async withProjectLock<T>(
    projectId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
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
    const existing = this.projectContainers.get(projectId);
    if (existing) {
      try {
        const { stdout } = await execFileAsync("docker", [
          "inspect",
          "-f",
          "{{.State.Running}}",
          existing.containerId,
        ]);
        if (stdout.trim() === "true") {
          existing.lastUsed = Date.now();
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

    if (!hasStaleEntry && this.projectContainers.size >= config.maxSandboxes) {
      await this.reapIdleSandboxes(config.sandboxIdleTimeoutMs);
      if (this.projectContainers.size >= config.maxSandboxes) {
        throw new Error(`sandbox limit reached (max ${config.maxSandboxes})`);
      }
    }

    if (!sandboxGate.acquire(userId, config.maxSandboxesPerUser)) {
      throw new Error(
        `per-user sandbox limit reached (max ${config.maxSandboxesPerUser})`,
      );
    }

    // From here on, every exit path must either reach the success
    // `projectContainers.set()` below or release the per-user slot just
    // acquired — a failed creation must never permanently consume quota.
    let containerId: string;
    let portMapping: Record<number, number>;
    try {
      const provisioned = await this.provisionContainer(
        projectId,
        config,
        workspaceDir,
      );
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
    });
    return containerId;
  }

  /** Docker provisioning steps only — no gate/map bookkeeping, so callers
   *  can wrap this precisely in a release-on-failure try/catch. */
  private async provisionContainer(
    projectId: string,
    config: AppConfig,
    workspaceDir: string,
  ): Promise<{ containerId: string; portMapping: Record<number, number> }> {
    if (!(await isDockerRunningAsync()))
      throw new Error("Docker daemon is not running");
    if (!(await isRunnerImageAvailableAsync()))
      throw new Error("cloudeeeide-runner:latest is not available");

    const containerId = `ide-sandbox-${projectId}`;

    try {
      await execFileAsync("docker", ["rm", "-f", containerId]);
    } catch {}

    try {
      await execFileAsync("docker", [
        "network",
        "inspect",
        `ide-net-${projectId}`,
      ]);
    } catch {
      await execFileAsync("docker", [
        "network",
        "create",
        `ide-net-${projectId}`,
      ]);
    }

    const limits = config.limits;
    const previewPorts = [3000, 4173, 5173, 8000, 8080];
    const portArgs = config.containerized
      ? []
      : previewPorts.flatMap((p) => ["-p", `127.0.0.1::${p}`]);

    // Level 4 Sandbox Hardening Flags (Read-only root + tmpfs)
    const hardeningArgs = [
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=64m,mode=1777",
      "--tmpfs",
      "/run:rw,size=16m,mode=1777",
      "--tmpfs",
      "/home/ide/.cache:rw,size=64m,uid=1000,gid=1000,mode=0755",
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
      "cloudeeeide-runner:latest",
      "sleep",
      "infinity",
    ];

    await execFileAsync("docker", dockerArgs);

    const portMapping: Record<number, number> = {};
    if (!config.containerized) {
      const { stdout } = await execFileAsync("docker", ["port", containerId]);
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\/tcp\s+->\s+.*:(\d+)$/);
        if (match) {
          portMapping[parseInt(match[1], 10)] = parseInt(match[2], 10);
        }
      }
    }

    return { containerId, portMapping };
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
    const info = this.projectContainers.get(projectId);
    const cid = info ? info.containerId : `ide-sandbox-${projectId}`;
    try {
      await execFileAsync("docker", ["rm", "-f", cid]);
    } catch {}
    try {
      await execFileAsync("docker", ["network", "rm", `ide-net-${projectId}`]);
    } catch {}
    // Release exactly once: `this.projectContainers.delete` below removes the
    // entry, so a repeat stopProjectSandbox() call on the same projectId
    // finds no `info` and correctly does nothing here.
    if (info && info.ownerId !== undefined) {
      sandboxGate.release(info.ownerId);
    }
    this.projectContainers.delete(projectId);
    this.connectedNetworks.delete(projectId);
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
          await execFileAsync("docker", ["rm", "-f", id]);
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
    for (const info of this.projectContainers.values()) {
      if (info.ownerId !== undefined) sandboxGate.release(info.ownerId);
    }
    this.projectContainers.clear();
  }

  getMappedPort(projectId: string, internalPort: number): number | null {
    const info = this.projectContainers.get(projectId);
    return info?.ports[internalPort] ?? null;
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
      await execFileAsync("docker", [
        "network",
        "connect",
        `ide-net-${projectId}`,
        appId,
      ]);
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
    if (!ALLOWED_PREVIEW_PORTS.includes(internalPort as any)) return null;

    const info = this.projectContainers.get(projectId);
    if (!info) return null;

    if (containerized) {
      await this.connectAppToProjectNetwork(projectId);
      return `http://${info.containerId}:${internalPort}`;
    }
    if (info.ports[internalPort] === undefined) return null;
    return `http://127.0.0.1:${info.ports[internalPort]}`;
  }

  touch(projectId: string): void {
    const info = this.projectContainers.get(projectId);
    if (info) info.lastUsed = Date.now();
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
      list.push({
        projectId,
        containerId: info.containerId,
        lastUsed: info.lastUsed,
        ports: info.ports,
      });
    }
    return list;
  }

  async terminateSandbox(
    containerId: string,
  ): Promise<{ success: boolean; projectId?: string }> {
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

  /** Stops containers that have not been used within the idle timeout. */
  async reapIdleSandboxes(idleTimeoutMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [projectId, info] of [...this.projectContainers.entries()]) {
      if (now - info.lastUsed >= idleTimeoutMs) {
        // Skip a project with an in-flight lifecycle operation rather than
        // queuing behind it: this method can itself be called from inside
        // ensureProjectSandbox's own lock-held cap-pressure check (a
        // different projectId), and blocking here on another project's lock
        // while *our* caller holds ours would risk two projects reaping each
        // other at the same instant and deadlocking. A project actively
        // mid-creation/teardown isn't meaningfully "idle" anyway — it'll be
        // picked up by the next reap pass once it settles.
        if (this.lifecycleTail.has(projectId)) continue;
        await this.stopProjectSandbox(projectId);
        reaped.push(projectId);
      }
    }
    return reaped;
  }

  startReaper(config: AppConfig): void {
    this.stopReaper();
    this.reaperTimer = setInterval(() => {
      this.reapIdleSandboxes(config.sandboxIdleTimeoutMs).catch((err) => {
        console.error("[sandbox] reaper error:", err);
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
  async getContainerStats(projectId: string): Promise<ContainerStats> {
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
      const parsed = JSON.parse(stdout.trim().split("\n")[0]);
      const cpu = parseFloat((parsed.CPUPerc || "0%").replace("%", "")) || 0;
      const memPerc =
        parseFloat((parsed.MemPerc || "0%").replace("%", "")) || 0;

      const memUsageStr = parsed.MemUsage || "";
      let memUsageBytes = 0;
      let memLimitBytes = 536870912;
      if (memUsageStr.includes("/")) {
        const [u, l] = memUsageStr.split("/").map((s: string) => s.trim());
        memUsageBytes = parseByteUnits(u);
        memLimitBytes = parseByteUnits(l) || 536870912;
      }
      const pids = parseInt(parsed.PIDs, 10) || 0;
      return {
        running: true,
        cpuPercent: cpu,
        memoryUsageBytes: memUsageBytes,
        memoryLimitBytes: memLimitBytes,
        memoryPercent: memPerc,
        pids,
        netIO: parsed.NetIO || "0B / 0B",
        blockIO: parsed.BlockIO || "0B / 0B",
      };
    } catch {
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
  }

  private async readPortMapping(
    containerId: string,
  ): Promise<Record<number, number>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const mapping: Record<number, number> = {};
      try {
        const { stdout } = await execFileAsync("docker", ["port", containerId]);
        for (const line of stdout.split("\n")) {
          const match = line.match(/^(\d+)\/tcp\s+->\s+.*:(\d+)$/);
          if (match) mapping[parseInt(match[1], 10)] = parseInt(match[2], 10);
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
      const row = db
        .prepare("SELECT id FROM projects WHERE id = ?")
        .get(projectId);
      return row !== undefined;
    };

    const ownerOf = (projectId: string): number | undefined => {
      const row = db
        .prepare("SELECT owner_id FROM projects WHERE id = ?")
        .get(projectId) as { owner_id?: number } | undefined;
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
      if (state?.trim().toLowerCase() === "running") {
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
        if (
          !projectExists(projectId) &&
          !this.projectContainers.has(projectId)
        ) {
          try {
            await execFileAsync("docker", ["network", "rm", netName]);
          } catch {}
        }
      }
    }
  }
}

export const sandboxManager = SandboxManager.getInstance();

export async function sandboxRun(
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
  } catch (err: any) {
    return {
      stdout: "",
      stderr: `[sandbox] failed to start project container: ${err.message}`,
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
      stderr:
        "[sandbox] execution cancelled: client disconnected before the process started",
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
  execArgs.push(containerId, opts.command, ...opts.args);

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

  if (opts.onController) {
    opts.onController({
      writeStdin: (data) => child.stdin.write(data),
      kill: killProcess,
    });
  }

  if (typeof opts.stdin === "string") {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  } else if (!opts.onController) {
    child.stdin.end();
  }

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    killProcess();
  }, opts.timeoutMs);

  const [code, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >((resolve) => {
    child.on("close", (c, s) => resolve([c, s]));
    child.on("error", () => resolve([null, null]));
  });

  clearTimeout(watchdog);

  if (spawnError) {
    stderr =
      `${stderr}\n[sandbox] failed to exec process: ${spawnError}`.trim();
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
