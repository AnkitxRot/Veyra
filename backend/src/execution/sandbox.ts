import { spawn, exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import { IS_WINDOWS } from '../config.js';
import { isDockerRunning, isRunnerImageAvailable } from '../tools.js';

const execAsync = promisify(exec);

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
  private projectContainers = new Map<string, { containerId: string, ports: Record<number, number> }>();
  
  static getInstance(): SandboxManager {
    if (!this.instance) this.instance = new SandboxManager();
    return this.instance;
  }
  
  async ensureProjectSandbox(projectId: string, config: AppConfig, workspaceDir: string): Promise<string> {
    const existing = this.projectContainers.get(projectId);
    if (existing) {
       try {
         const { stdout } = await execAsync(`docker inspect -f "{{.State.Running}}" ${existing.containerId}`);
         if (stdout.trim() === 'true') return existing.containerId;
       } catch {}
    }
    
    if (!isDockerRunning()) throw new Error('Docker daemon is not running');
    if (!isRunnerImageAvailable()) throw new Error('cloudeeeide-runner:latest is not available');
    
    const containerId = `ide-sandbox-${projectId}`;
    
    try { await execAsync(`docker rm -f ${containerId}`); } catch {}
    
    try { 
      await execAsync(`docker network inspect ide-net-${projectId}`); 
    } catch {
      await execAsync(`docker network create ide-net-${projectId}`);
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
    
    await execAsync(`docker ${dockerArgs.join(' ')}`);
    
    const portMapping: Record<number, number> = {};
    const { stdout } = await execAsync(`docker port ${containerId}`);
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\d+)\/tcp\s+->\s+.*:(\d+)$/);
      if (match) {
         portMapping[parseInt(match[1], 10)] = parseInt(match[2], 10);
      }
    }
    
    this.projectContainers.set(projectId, { containerId, ports: portMapping });
    return containerId;
  }
  
  async stopProjectSandbox(projectId: string): Promise<void> {
    const info = this.projectContainers.get(projectId);
    const cid = info ? info.containerId : `ide-sandbox-${projectId}`;
    try { await execAsync(`docker rm -f ${cid}`); } catch {}
    try { await execAsync(`docker network rm ide-net-${projectId}`); } catch {}
    this.projectContainers.delete(projectId);
  }
  
  async cleanupAllSandboxes(): Promise<void> {
    try {
      const { stdout } = await execAsync('docker ps -a -q -f "label=cloudeeeide.managed=true"');
      const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      for (const id of ids) {
         try { await execAsync(`docker rm -f ${id}`); } catch {}
      }
      
      const { stdout: netOut } = await execAsync('docker network ls -q -f "name=ide-net-"');
      const netIds = netOut.split('\n').map(s => s.trim()).filter(Boolean);
      for (const id of netIds) {
         try { await execAsync(`docker network rm ${id}`); } catch {}
      }
    } catch {}
    this.projectContainers.clear();
  }
  
  getMappedPort(projectId: string, internalPort: number): number | null {
     const info = this.projectContainers.get(projectId);
     return info?.ports[internalPort] ?? null;
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
    // Soft kill first if possible, but docker exec is hard to kill cleanly without killing the container.
    // However, child.kill() usually works to terminate the docker exec client process, which *might* stop the container process.
    // If we need to forcefully stop the inner process, we can't easily do it without finding the PID inside the container.
    // We'll rely on child.kill() for now.
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
