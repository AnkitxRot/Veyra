import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { isDockerRunning } from '../src/tools.js';
import { makeTestConfig, makeWorkspace } from './helpers.js';
import { openDb, type Db } from '../src/db.js';
import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { setupWebSocketServer } from '../src/ws/index.js';
import { SandboxManager, sandboxManager } from '../src/execution/sandbox.js';

const execFileAsync = promisify(execFile);

async function containerExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function networkExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['network', 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilRunning(name: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', name]);
      if (stdout.trim() === 'true') return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`container ${name} did not become running`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!isDockerRunning())('sandbox lifecycle', () => {
  afterAll(async () => {
    await sandboxManager.cleanupAllSandboxes();
  });

  it('reaps idle containers but keeps active ones', async () => {
    const cfg = makeTestConfig();
    const mgr = new SandboxManager();
    const projectId = `reap-${randomUUID()}`;
    const workspace = makeWorkspace(cfg);

    await mgr.ensureProjectSandbox(projectId, cfg, workspace);
    expect(await containerExists(`ide-sandbox-${projectId}`)).toBe(true);

    // recently used -> survives a normal idle timeout
    expect(await mgr.reapIdleSandboxes(60_000)).toEqual([]);
    expect(await containerExists(`ide-sandbox-${projectId}`)).toBe(true);

    // touch refreshes lastUsed
    mgr.touch(projectId);
    await sleep(20);
    expect(await mgr.reapIdleSandboxes(60_000)).toEqual([]);

    // idle beyond the timeout -> container and network removed
    await sleep(20);
    const reaped = await mgr.reapIdleSandboxes(10);
    expect(reaped).toContain(projectId);
    expect(await containerExists(`ide-sandbox-${projectId}`)).toBe(false);
    expect(await networkExists(`ide-net-${projectId}`)).toBe(false);
  }, 120_000);

  it('rebuilds port mappings on startup and removes orphaned containers', async () => {
    const cfg = makeTestConfig();
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('owner', 'x');
    const projectId = `rec-${randomUUID()}`;
    db.prepare('INSERT INTO projects (id, owner_id, name) VALUES (?, 1, ?)').run(projectId, 'demo');
    const workspace = makeWorkspace(cfg);

    const managerA = new SandboxManager();
    await managerA.ensureProjectSandbox(projectId, cfg, workspace);
    await waitUntilRunning(`ide-sandbox-${projectId}`);
    const originalPort = managerA.getMappedPort(projectId, 3000);
    expect(originalPort).not.toBeNull();

    // simulate a backend restart: a fresh manager knows nothing yet
    const managerB = new SandboxManager();
    expect(managerB.getMappedPort(projectId, 3000)).toBeNull();
    await managerB.reconcile(cfg, db);
    expect(managerB.getMappedPort(projectId, 3000)).toBe(originalPort);

    // deleted project -> next reconcile removes the container and network
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    const managerC = new SandboxManager();
    await managerC.reconcile(cfg, db);
    expect(await containerExists(`ide-sandbox-${projectId}`)).toBe(false);
    expect(await networkExists(`ide-net-${projectId}`)).toBe(false);
  }, 120_000);
});

describe.skipIf(!isDockerRunning())('ws auth and execution limits', () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    cfg = makeTestConfig({ maxConcurrentRuns: 1 });
    db = openDb(':memory:');
    const app = createApp(cfg, db);
    server = createServer(app);
    setupWebSocketServer(server, db, cfg);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;

    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wslifecycle', password: 'secret123' }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    token = reg.token;

    const proj = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'ws-demo' }),
    }).then((r) => r.json() as Promise<{ project: { id: string } }>);
    projectId = proj.project.id;

    await fetch(`${base}/api/projects/${projectId}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: 'main.py', content: 'import time\ntime.sleep(3)\nprint("done")\n' }),
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sandboxManager.cleanupAllSandboxes();
  });

  function wsPort(): number {
    return (server.address() as { port: number }).port;
  }

  function connectWs(path: string, cookie?: string): Promise<WebSocket> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${wsPort()}${path}`,
      cookie ? { headers: { Cookie: cookie } } : undefined,
    );
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('rejects upgrades that rely on ?token= in the URL', async () => {
    await expect(connectWs(`/ws/execute?projectId=${projectId}&token=${token}`)).rejects.toThrow();
  });

  it('rejects upgrades without any credentials', async () => {
    await expect(connectWs(`/ws/execute?projectId=${projectId}`)).rejects.toThrow();
  });

  it('accepts cookie-authenticated connections', async () => {
    const ws = await connectWs(`/ws/execute?projectId=${projectId}`, `session_token=${token}`);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('enforces the per-user concurrent execution limit over ws', async () => {
    const cookie = `session_token=${token}`;
    const ws1 = await connectWs(`/ws/execute?projectId=${projectId}`, cookie);
    const ws2 = await connectWs(`/ws/execute?projectId=${projectId}`, cookie);

    const messages: any[] = [];
    ws1.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws1.send(JSON.stringify({ type: 'start', language: 'python', activeFile: 'main.py' }));

    // wait until the first run has acquired its slot and started
    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0);
    }, { timeout: 30_000 });

    const rejection = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no error message received')), 10_000);
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws2.send(JSON.stringify({ type: 'start', language: 'python', activeFile: 'main.py' }));
    });
    expect(rejection.data).toMatch(/[Cc]oncurrent execution limit/);

    // first run finishes and frees the slot
    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'exit')).toBe(true);
    }, { timeout: 60_000 });

    ws1.close();
    ws2.close();
  }, 120_000);
});
