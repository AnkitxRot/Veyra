import { describe, it, expect, afterAll } from 'vitest';
import { makeTestConfig, startTestApi } from './helpers.js';
import { openDb } from '../src/db.js';
import { issueSession, deleteExpiredSessions } from '../src/auth/middleware.js';
import { runGate } from '../src/execution/runGate.js';
import type { ConfigOverrides } from '../src/config';

const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const close of closers) await close();
});

async function boot(overrides: ConfigOverrides = {}) {
  const cfg = makeTestConfig(overrides);
  const api = await startTestApi(cfg);
  closers.push(() => api.close());
  return { cfg, api };
}

describe('auth rate limiting', () => {
  it('returns 429 after the configured number of attempts', async () => {
    const { api } = await boot({ authRateLimit: { max: 3, windowMs: 60_000 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await api.request('POST', '/api/auth/login', {
        body: { username: 'nobody', password: 'wrongpass1' },
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
  });

  it('applies the limit to register as well', async () => {
    const { api } = await boot({ authRateLimit: { max: 1, windowMs: 60_000 } });
    const first = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_rl', password: 'secret123' },
    });
    expect(first.status).toBe(201);
    const second = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_rl2', password: 'secret123' },
    });
    expect(second.status).toBe(429);
    expect(second.data.error.code).toBe('rate_limited');
  });
});

describe('password policy', () => {
  it('rejects passwords below the default minimum of 8', async () => {
    const { api } = await boot();
    const r = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_pw', password: 'short12' },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('invalid_password');
  });

  it('honors a custom minimum length', async () => {
    const { api } = await boot({ minPasswordLength: 12 });
    const weak = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_pw2', password: 'elevenchars' },
    });
    expect(weak.status).toBe(400);
    const ok = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_pw2', password: 'twelvechars!' },
    });
    expect(ok.status).toBe(201);
  });
});

describe('project quota', () => {
  it('blocks project creation past the per-user quota', async () => {
    const { api } = await boot({ projectQuota: 2 });
    const reg = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_quota', password: 'secret123' },
    });
    const token = reg.data.token;
    const p1 = await api.request('POST', '/api/projects', { token, body: { name: 'a' } });
    const p2 = await api.request('POST', '/api/projects', { token, body: { name: 'b' } });
    expect(p1.status).toBeLessThan(300);
    expect(p2.status).toBeLessThan(300);
    const p3 = await api.request('POST', '/api/projects', { token, body: { name: 'c' } });
    expect(p3.status).toBe(403);
    expect(p3.data.error.code).toBe('quota_exceeded');
  });
});

describe('session garbage collection', () => {
  it('deletes expired sessions and keeps valid ones', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('gcuser', 'x');
    issueSession(db, 1, -1000); // already expired
    issueSession(db, 1, 60_000); // valid
    const removed = deleteExpiredSessions(db);
    expect(removed).toBe(1);
    const row = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('rejects an expired session token at the API', async () => {
    const { api } = await boot();
    const reg = await api.request('POST', '/api/auth/register', {
      body: { username: 'user_gc', password: 'secret123' },
    });
    const expired = issueSession(api.db, reg.data.user.id, -1000);
    const me = await api.request('GET', '/api/auth/me', { token: expired });
    expect(me.status).toBe(401);
  });
});

describe('concurrent execution gate', () => {
  it('enforces the per-user limit and releases slots', () => {
    const userId = 900001;
    expect(runGate.acquire(userId, 1)).toBe(true);
    expect(runGate.acquire(userId, 1)).toBe(false);
    expect(runGate.activeCount(userId)).toBe(1);
    runGate.release(userId);
    expect(runGate.activeCount(userId)).toBe(0);
    expect(runGate.acquire(userId, 1)).toBe(true);
    runGate.release(userId);
  });

  it('tracks users independently', () => {
    const a = 900002;
    const b = 900003;
    expect(runGate.acquire(a, 1)).toBe(true);
    expect(runGate.acquire(b, 1)).toBe(true);
    expect(runGate.acquire(a, 1)).toBe(false);
    runGate.release(a);
    runGate.release(b);
  });

  it('never counts below zero', () => {
    const userId = 900004;
    runGate.release(userId);
    expect(runGate.activeCount(userId)).toBe(0);
    expect(runGate.acquire(userId, 1)).toBe(true);
    runGate.release(userId);
  });
});

describe('db indexes', () => {
  it('creates ownership and session indexes', () => {
    const db = openDb(':memory:');
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('idx_projects_owner');
    expect(names).toContain('idx_sessions_user');
    expect(names).toContain('idx_sessions_expires');
  });
});
