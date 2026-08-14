import { chmodSync, chownSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, IS_WINDOWS, type AppConfig, type ConfigOverrides } from '../src/config';
import type { Db } from '../src/db';

export function makeTestConfig(overrides: ConfigOverrides = {}): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'cloudide-test-'));
  if (!IS_WINDOWS) {
    // mkdtemp creates 0700 dirs; make the tree traversable by the sandbox user
    chmodSync(dataDir, 0o755);
  }
  return resolveConfig({
    dataDir,
    dbPath: ':memory:',
    cgroupRoot: '/sys/fs/cgroup/cloudide-test',
    ...overrides,
  });
}

export function makeWorkspace(cfg: AppConfig): string {
  const dir = join(cfg.workspacesDir, `ws-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  if (!IS_WINDOWS) {
    try {
      chownSync(dir, cfg.runUser.uid, cfg.runUser.gid);
      chmodSync(dir, 0o770);
    } catch {
      // best-effort
    }
  }
  return dir;
}

export interface TestApi {
  base: string;
  db: Db;
  request: (method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<{
    status: number;
    data: any;
    text: string;
  }>;
  close: () => Promise<void>;
}

export async function startTestApi(cfg: AppConfig, existingDb?: Db): Promise<TestApi> {
  const { createApp } = await import('../src/app.js');
  const { createServer } = await import('node:http');
  const { openDb } = await import('../src/db.js');
  const db = existingDb ?? openDb(cfg.dbPath);
  const app = createApp(cfg, db);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    db,
    request: async (method, path, opts = {}) => {
      const headers: Record<string, string> = {};
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let data: any = {};
      try { data = JSON.parse(text); } catch {}
      return { status: res.status, data, text };
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
