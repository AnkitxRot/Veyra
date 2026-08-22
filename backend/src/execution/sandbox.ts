import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { isDockerRunning, isRunnerImageAvailable } from '../tools.js';

const execFileAsync = promisify(execFile);

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
  timeoutMs: number;
  kind: 'run' | 'build';
  config: AppConfig;
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
  const unit = (match[2] || 'B').toLowerCase();
  if (unit.startsWith('k') || unit.startsWith('kib')) return Math.round(num * 1024);
  if (unit.startsWith('m') || unit.startsWith('mib')) return Math.round(num * 1024 * 1024);
  if (unit.startsWith('g') || unit.startsWith('gib')) return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num);
}

export function initCgroupRoot(_cgroupRoot: string): void {
  // cgroup v2 is managed per-container via Docker flags
}

export class SandboxManager {
  private static instance: SandboxManager;
  private projectContainers = new Map<string, { containerId: string; ports: Record<number, number>; lastUsed: number }>();
  private reaperTimer: NodeJS.Timeout | null = null;
  
  static getInstance(): SandboxManager {
    if (!this.instance) this.instance = new SandboxManager();
    return this.instance;
  }
  
  async ensureProjectSandbox(projectId: string, config: AppConfig, workspaceDir: string): Promise<string> {
    const existing = this.projectContainers.get(projectId);
    if (existing) {
       try {
         const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', existing.containerId]);
         if (stdout.trim() === 'true') {
           existing.lastUsed = Date.now();
           return existing.containerId;
         }
       } catch {}
    }

    if (!existing && this.projectContainers.size >= config.maxSandboxes) {
      await this.reapIdleSandboxes(config.sandboxIdleTimeoutMs);
      if (this.projectContainers.size >= config.maxSandboxes) {
        throw new Error(`sandbox limit reached (max ${config.maxSandboxes})`);
      }
    }

    if (!isDockerRunning()) throw new Error('Docker daemon is not running');
    if (!isRunnerImageAvailable()) throw new Error('cloudeeeide-runner:latest is not available');
    
    const containerId = `ide-sandbox-${projectId}`;
    
    try { await execFileAsync('docker', ['rm', '-f', containerId]); } catch {}
    
    try { 
      await execFileAsync('docker', ['network', 'inspect', `ide-net-${projectId}`]);
    } catch {
      await execFileAsync('docker', ['network', 'create', `ide-net-${projectId}`]);
    }
    
    const limits = config.limits;
    const previewPorts = [3000, 4173, 5173, 8000, 8080];
    const portArgs = config.containerized
      ? []
      : previewPorts.flatMap((p) => ['-p', `127.0.0.1::${p}`]);
    
    // Level 4 Sandbox Hardening Flags (Read-only root + tmpfs)
    const hardeningArgs = [
      '--read-only',
      '--tmpfs', '/tmp:rw,size=64m,mode=1777',
      '--tmpfs', '/run:rw,size=16m,mode=1777',
      '--tmpfs', '/home/ide/.cache:rw,size=64m,uid=1000,gid=1000,mode=0755',
    ];

    const dockerArgs = [
      'run', '-d',
      '--name', containerId,
      '--label', 'cloudeeeide.managed=true',
      '--label', `cloudeeeide.project=${projectId}`,
      '--network', `ide-net-${projectId}`,
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--memory', `${limits.memoryBytes}b`,
      '--cpus', String(limits.cpuQuota / 100_000),
      '--pids-limit', String(limits.pidsLimit),
      ...hardeningArgs,
      ...portArgs,
      '-v', `${workspaceDir}:/workspace`,
      '-w', '/workspace',
      '--user', 'ide',
      'cloudeeeide-runner:latest',
      'sleep', 'infinity'
    ];
    
    await execFileAsync('docker', dockerArgs);
    
    const portMapping: Record<number, number> = {};
    if (!config.containerized) {
      const { stdout } = await execFileAsync('docker', ['port', containerId]);
      for (const line of stdout.split('\n')) {
        const match = line.match(/^(\d+)\/tcp\s+->\s+.*:(\d+)$/);
        if (match) {
           portMapping[parseInt(match[1], 10)] = parseInt(match[2], 10);
        }
      }
    }
    
    this.projectContainers.set(projectId, { containerId, ports: portMapping, lastUsed: Date.now() });
    return containerId;
  }
  
  async stopProjectSandbox(projectId: string): Promise<void> {
    const info = this.projectContainers.get(projectId);
    const cid = info ? info.containerId : `ide-sandbox-${projectId}`;
    try { await execFileAsync('docker', ['rm', '-f', cid]); } catch {}
    try { await execFileAsync('docker', ['network', 'rm', `ide-net-${projectId}`]); } catch {}
    this.projectContainers.delete(projectId);
    this.connectedNetworks.delete(projectId);
  }
  
  async cleanupAllSandboxes(): Promise<void> {
    try {
      const { stdout } = await execFileAsync('docker', ['ps', '-a', '-q', '-f', 'label=cloudeeeide.managed=true']);
      const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      for (const id of ids) {
         try { await execFileAsync('docker', ['rm', '-f', id]); } catch {}
      }
      
      const { stdout: netOut } = await execFileAsync('docker', ['network', 'ls', '-q', '-f', 'name=ide-net-']);
      const netIds = netOut.split('\n').map(s => s.trim()).filter(Boolean);
      for (const id of netIds) {
         try { await execFileAsync('docker', ['network', 'rm', id]); } catch {}
      }
    } catch {}
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
      await execFileAsync('docker', ['network', 'connect', `ide-net-${projectId}`, appId]);
      this.connectedNetworks.add(projectId);
    } catch {
      this.connectedNetworks.add(projectId);
    }
  }

  async getProxyTarget(projectId: string, internalPort: number, containerized: boolean): Promise<string | null> {
    const allowedPorts = [3000, 4173, 5173, 8000, 8080];
    if (!allowedPorts.includes(internalPort)) return null;

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

  async getAllActiveSandboxes(): Promise<Array<{
    projectId: string;
    containerId: string;
    lastUsed: number;
    ports: Record<number, number>;
  }>> {
    const list: Array<{ projectId: string; containerId: string; lastUsed: number; ports: Record<number, number> }> = [];
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

  async terminateSandbox(containerId: string): Promise<{ success: boolean; projectId?: string }> {
    if (!/^ide-sandbox-[a-zA-Z0-9_-]+$/.test(containerId)) {
      throw new Error('invalid container id: not a managed sandbox');
    }

    let foundProjectId: string | undefined;
    for (const [pId, info] of this.projectContainers.entries()) {
      if (info.containerId === containerId) {
        foundProjectId = pId;
        break;
      }
    }

    const projectId = foundProjectId || containerId.replace('ide-sandbox-', '');
    await this.stopProjectSandbox(projectId);
    return { success: true, projectId };
  }

  /** Stops containers that have not been used within the idle timeout. */
  async reapIdleSandboxes(idleTimeoutMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [projectId, info] of [...this.projectContainers.entries()]) {
      if (now - info.lastUsed >= idleTimeoutMs) {
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
        console.error('[sandbox] reaper error:', err);
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
      const { stdout } = await execFileAsync('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
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
          netIO: '0B / 0B',
          blockIO: '0B / 0B',
        };
      }
      const parsed = JSON.parse(stdout.trim().split('\n')[0]);
      const cpu = parseFloat((parsed.CPUPerc || '0%').replace('%', '')) || 0;
      const memPerc = parseFloat((parsed.MemPerc || '0%').replace('%', '')) || 0;

      const memUsageStr = parsed.MemUsage || '';
      let memUsageBytes = 0;
      let memLimitBytes = 536870912;
      if (memUsageStr.includes('/')) {
        const [u, l] = memUsageStr.split('/').map((s: string) => s.trim());
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
        netIO: parsed.NetIO || '0B / 0B',
        blockIO: parsed.BlockIO || '0B / 0B',
      };
    } catch {
      return {
        running: false,
        cpuPercent: 0,
        memoryUsageBytes: 0,
        memoryLimitBytes: 536870912,
        memoryPercent: 0,
        pids: 0,
        netIO: '0B / 0B',
        blockIO: '0B / 0B',
      };
    }
  }

  private async readPortMapping(containerId: string): Promise<Record<number, number>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const mapping: Record<number, number> = {};
      try {
        const { stdout } = await execFileAsync('docker', ['port', containerId]);
        for (const line of stdout.split('\n')) {
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
        const res = await execFileAsync('docker', args);
        return res.stdout;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    return null;
  }

  async reconcile(config: AppConfig, db: Db): Promise<void> {
    if (!isDockerRunning()) return;

    let listing = '';
    const psOut = await this.dockerListing([
      'ps', '-a', '-f', 'label=cloudeeeide.managed=true', '--format', '{{.Names}}\t{{.State}}',
    ]);
    if (psOut === null) return;
    listing = psOut;

    const projectExists = (projectId: string): boolean => {
      const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      return row !== undefined;
    };

    for (const line of listing.split('\n')) {
      const [name, state] = line.split('\t');
      if (!name || !name.startsWith('ide-sandbox-')) continue;
      const projectId = name.slice('ide-sandbox-'.length);

      if (!projectExists(projectId)) {
        await this.stopProjectSandbox(projectId);
        continue;
      }
      if (state?.trim().toLowerCase() === 'running') {
        const ports = await this.readPortMapping(name);
        this.projectContainers.set(projectId, { containerId: name, ports, lastUsed: Date.now() });
      }
    }

    const netOut = await this.dockerListing(['network', 'ls', '--format', '{{.Name}}', '-f', 'name=ide-net-']);
    if (netOut !== null) {
      for (const netName of netOut.split('\n')) {
        if (!netName.startsWith('ide-net-')) continue;
        const projectId = netName.slice('ide-net-'.length);
        if (!projectExists(projectId) && !this.projectContainers.has(projectId)) {
          try { await execFileAsync('docker', ['network', 'rm', netName]); } catch {}
        }
      }
    }
  }
}

export const sandboxManager = SandboxManager.getInstance();

export async function sandboxRun(projectId: string, workspaceDir: string, opts: SandboxOptions): Promise<SandboxResult> {
  const start = Date.now();

  if (!isDockerRunning()) {
    return {
      stdout: '',
      stderr: '[sandbox] execution failed: Docker daemon is not running.',
      exitCode: null, signal: null, timedOut: false, oom: false, durationMs: Date.now() - start,
    };
  }

  let containerId: string;
  try {
    containerId = await sandboxManager.ensureProjectSandbox(projectId, opts.config, workspaceDir);
    sandboxManager.touch(projectId);
  } catch (err: any) {
    return {
      stdout: '',
      stderr: `[sandbox] failed to start project container: ${err.message}`,
      exitCode: null, signal: null, timedOut: false, oom: false, durationMs: Date.now() - start,
    };
  }

  const execArgs = ['exec', '-i', '-w', '/workspace'];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      execArgs.push('-e', `${k}=${v}`);
    }
  }
  execArgs.push(containerId, opts.command, ...opts.args);

  const child = spawn('docker', execArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let spawnError: string | null = null;

  child.stdout.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stdout += s;
    if (opts.onStdout) opts.onStdout(s);
  });
  child.stderr.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stderr += s;
    if (opts.onStderr) opts.onStderr(s);
  });
  child.on('error', (err) => { spawnError = err.message; });

  const killProcess = () => {
    child.kill('SIGKILL');
  };

  if (opts.onController) {
    opts.onController({
      writeStdin: (data) => child.stdin.write(data),
      kill: killProcess
    });
  }

  if (typeof opts.stdin === 'string') {
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

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('close', (c, s) => resolve([c, s]));
    child.on('error', () => resolve([null, null]));
  });
  
  clearTimeout(watchdog);

  if (spawnError) {
    stderr = `${stderr}\n[sandbox] failed to exec process: ${spawnError}`.trim();
  }

  return {
    stdout, stderr,
    exitCode: code, signal: signal ?? null,
    timedOut, oom: !timedOut && code === 137,
    durationMs: Date.now() - start,
  };
}
