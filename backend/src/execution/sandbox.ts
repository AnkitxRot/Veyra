import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import { IS_WINDOWS } from '../config.js';
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

export function initCgroupRoot(cgroupRoot: string): void {
  // cgroup v2 is managed per-container via Docker flags; the root mount
  // is expected to exist on the host (created by setup.sh or the init system).
}

export class SandboxManager {
  private static instance: SandboxManager;
  private projectContainers = new Map<string, { containerId: string, ports: Record<number, number>, lastUsed: number }>();
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
    const portArgs = previewPorts.flatMap(p => ['-p', `127.0.0.1::${p}`]);
    
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
      ...portArgs,
      '-v', `${workspaceDir}:/workspace`,
      '-w', '/workspace',
      '--user', 'ide',
      'cloudeeeide-runner:latest',
      'sleep', 'infinity'
    ];
    
    await execFileAsync('docker', dockerArgs);
    
    const portMapping: Record<number, number> = {};
    const { stdout } = await execFileAsync('docker', ['port', containerId]);
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\d+)\/tcp\s+->\s+.*:(\d+)$/);
      if (match) {
         portMapping[parseInt(match[1], 10)] = parseInt(match[2], 10);
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

  touch(projectId: string): void {
    const info = this.projectContainers.get(projectId);
    if (info) info.lastUsed = Date.now();
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

  private async readPortMapping(containerId: string): Promise<Record<number, number>> {
    // Retry once: right after container start the daemon can transiently
    // return no bindings or fail the CLI call under load.
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

  /**
   * Startup reconciliation against the Docker daemon:
   * - containers whose project no longer exists are removed (with their network)
   * - running containers of existing projects are re-registered so preview
   *   port mappings survive a backend restart
   */
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

    // Networks of deleted projects
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

  // Use docker exec instead of docker run so it runs inside the persistent container
  const execArgs = ['exec', '-i'];
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
    // Verified on Docker 29.x: SIGKILLing the docker exec client tears down
    // the exec session and terminates the in-container process.
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
    stderr = `${stderr}\\n[sandbox] failed to exec process: ${spawnError}`.trim();
  }

  return {
    stdout, stderr,
    exitCode: code, signal: signal ?? null,
    timedOut, oom: code === 137,
    durationMs: Date.now() - start,
  };
}
