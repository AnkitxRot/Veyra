import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestConfig, startTestApi, type TestApi } from './helpers.js';
import { hashPassword } from '../src/auth/passwords.js';
import { ensureAdminUser } from '../src/db.js';

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;
let userToken: string;
let _normalUserId: number;
let adminToken: string;
let adminUserId: number;
let sampleProjectId: string;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);

  // 1. Create normal user
  const userRes = await api.request('POST', '/api/auth/register', {
    body: { username: 'normaluser', password: 'password123' },
  });
  userToken = userRes.data.token;
  _normalUserId = userRes.data.user.id;

  // Create project under normal user
  const projRes = await api.request('POST', '/api/projects', {
    token: userToken,
    body: { name: 'Normal Project', language: 'python' },
  });
  sampleProjectId = projRes.data.project.id;

  // 2. Create admin user
  const adminHash = await hashPassword('AdminPass@123');
  ensureAdminUser(api.db, 'adminuser', adminHash);

  // Login as admin
  const adminRes = await api.request('POST', '/api/auth/admin-login', {
    body: { username: 'adminuser', password: 'AdminPass@123' },
  });
  adminToken = adminRes.data.token;
  adminUserId = adminRes.data.user.id;
});

afterAll(async () => {
  await api?.close();
});

describe('Admin Authentication & RBAC Access Control', () => {
  it('rejects unauthenticated requests to /api/admin/overview with 401', async () => {
    const res = await api.request('GET', '/api/admin/overview');
    expect(res.status).toBe(401);
  });

  it('rejects normal user requests to /api/admin/overview with 403 Forbidden', async () => {
    const res = await api.request('GET', '/api/admin/overview', { token: userToken });
    expect(res.status).toBe(403);
    expect(res.data.error.message).toMatch(/admin privileges required/i);
  });

  it('rejects normal user login via /api/auth/admin-login with 403 Forbidden', async () => {
    const res = await api.request('POST', '/api/auth/admin-login', {
      body: { username: 'normaluser', password: 'password123' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects invalid password on admin login with 401', async () => {
    const res = await api.request('POST', '/api/auth/admin-login', {
      body: { username: 'adminuser', password: 'WrongPassword' },
    });
    expect(res.status).toBe(401);
  });

  it('authenticates admin user and returns role: admin', async () => {
    const res = await api.request('POST', '/api/auth/admin-login', {
      body: { username: 'adminuser', password: 'AdminPass@123' },
    });
    expect(res.status).toBe(200);
    expect(res.data.user.role).toBe('admin');
    expect(res.data.token).toBeDefined();
  });
});

describe('Admin API Endpoints & Control Plane Capabilities', () => {
  it('GET /api/admin/overview returns platform health, counters and aggregate telemetry', async () => {
    const res = await api.request('GET', '/api/admin/overview', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.system).toBeDefined();
    expect(res.data.system.status).toBe('healthy');
    expect(res.data.counters).toBeDefined();
    expect(res.data.counters.totalUsers).toBeGreaterThanOrEqual(2);
    expect(res.data.aggregateTelemetry).toBeDefined();
    expect(typeof res.data.aggregateTelemetry.cpuPercent).toBe('number');
  });

  it('GET /api/admin/telemetry returns structured container metrics', async () => {
    const res = await api.request('GET', '/api/admin/telemetry', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.summary).toBeDefined();
    expect(Array.isArray(res.data.sandboxes)).toBe(true);
  });

  it('GET /api/admin/sandboxes returns active sandboxes list', async () => {
    const res = await api.request('GET', '/api/admin/sandboxes', { token: adminToken });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.sandboxes)).toBe(true);
  });

  it('GET /api/admin/executions returns executions and metrics', async () => {
    api.db.prepare(`
      INSERT INTO runs (id, project_id, user_id, language, file_path, status, exit_code, duration_ms)
      VALUES ('admin-run-1', ?, 1, 'python', 'main.py', 'success', 0, 15)
    `).run(sampleProjectId);

    const res = await api.request('GET', '/api/admin/executions', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.metrics).toBeDefined();
    expect(res.data.metrics.totalRuns).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.data.runs)).toBe(true);
  });

  it('GET /api/admin/users returns user directory without exposing password hashes', async () => {
    const res = await api.request('GET', '/api/admin/users', { token: adminToken });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.users)).toBe(true);
    for (const u of res.data.users) {
      expect(u.password_hash).toBeUndefined();
      expect(u.username).toBeDefined();
      expect(u.role).toBeDefined();
    }
  });

  it('GET /api/admin/projects returns all projects across tenants', async () => {
    const res = await api.request('GET', '/api/admin/projects', { token: adminToken });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.projects)).toBe(true);
    expect(res.data.projects.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/admin/audit returns searchable audit trail', async () => {
    const res = await api.request('GET', '/api/admin/audit', { token: adminToken });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.logs)).toBe(true);
    expect(res.data.total).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/admin/sandboxes/:containerId/terminate rejects unmanaged containers', async () => {
    const res = await api.request('POST', '/api/admin/sandboxes/malicious-container-name/terminate', { token: adminToken });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/must be a managed sandbox identifier/i);
  });

  it('POST /api/admin/sandboxes/:containerId/terminate successfully terminates managed sandbox & audits action', async () => {
    const res = await api.request('POST', `/api/admin/sandboxes/ide-sandbox-${sampleProjectId}/terminate`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);

    const auditRes = await api.request('GET', '/api/admin/audit?event_type=SANDBOX_TERMINATED_BY_ADMIN', { token: adminToken });
    expect(auditRes.status).toBe(200);
    expect(auditRes.data.logs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/admin/health returns detailed diagnostics', async () => {
    const res = await api.request('GET', '/api/admin/health', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.database.live).toBe(true);
    expect(res.data.sandboxManager).toBeDefined();
  });
});

describe('Admin User Management (Inspect, Edit, Password Reset, Delete)', () => {
  let disposableUserId: number;
  let disposableToken: string;

  beforeAll(async () => {
    const reg = await api.request('POST', '/api/auth/register', {
      body: { username: 'testsubject', password: 'password123' },
    });
    disposableUserId = reg.data.user.id;
    disposableToken = reg.data.token;

    // Create a project under testsubject
    await api.request('POST', '/api/projects', {
      token: disposableToken,
      body: { name: 'Subject Project', language: 'python' },
    });
  });

  it('GET /api/admin/users/:id returns user details and associated resources', async () => {
    const res = await api.request('GET', `/api/admin/users/${disposableUserId}`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.user.username).toBe('testsubject');
    expect(res.data.user.password_hash).toBeUndefined();
    expect(res.data.counts.projectCount).toBe(1);
    expect(res.data.projects.length).toBe(1);
  });

  it('PATCH /api/admin/users/:id edits username and role', async () => {
    const res = await api.request('PATCH', `/api/admin/users/${disposableUserId}`, {
      token: adminToken,
      body: { username: 'renamedsubject', role: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(res.data.user.username).toBe('renamedsubject');
    expect(res.data.user.role).toBe('admin');

    // Demote back to user
    const demoteRes = await api.request('PATCH', `/api/admin/users/${disposableUserId}`, {
      token: adminToken,
      body: { role: 'user' },
    });
    expect(demoteRes.status).toBe(200);
    expect(demoteRes.data.user.role).toBe('user');
  });

  it('PATCH /api/admin/users/:id prevents demoting the last remaining admin', async () => {
    // Attempt to demote adminuser (who is currently the only admin)
    const res = await api.request('PATCH', `/api/admin/users/${adminUserId}`, {
      token: adminToken,
      body: { role: 'user' },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/at least one administrator/i);
  });

  it('POST /api/admin/users/:id/reset-password resets password and invalidates sessions', async () => {
    // Verify disposableToken works before reset
    const beforeRes = await api.request('GET', '/api/projects', { token: disposableToken });
    expect(beforeRes.status).toBe(200);

    // Reset password
    const resetRes = await api.request('POST', `/api/admin/users/${disposableUserId}/reset-password`, {
      token: adminToken,
      body: { newPassword: 'NewSecretPassword123' },
    });
    expect(resetRes.status).toBe(200);

    // Verify old token is now invalidated (401)
    const afterRes = await api.request('GET', '/api/projects', { token: disposableToken });
    expect(afterRes.status).toBe(401);

    // Verify user can login with new password
    const loginRes = await api.request('POST', '/api/auth/login', {
      body: { username: 'renamedsubject', password: 'NewSecretPassword123' },
    });
    expect(loginRes.status).toBe(200);
    disposableToken = loginRes.data.token;
  });

  it('DELETE /api/admin/users/:id prevents self-deletion', async () => {
    const res = await api.request('DELETE', `/api/admin/users/${adminUserId}`, { token: adminToken });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/own active administrator/i);
  });

  it('DELETE /api/admin/users/:id performs cascade cleanup and audits deletion', async () => {
    const res = await api.request('DELETE', `/api/admin/users/${disposableUserId}`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);

    // Verify user no longer exists
    const checkUser = await api.request('GET', `/api/admin/users/${disposableUserId}`, { token: adminToken });
    expect(checkUser.status).toBe(404);

    // Verify old session token is completely gone
    const checkSession = await api.request('GET', '/api/projects', { token: disposableToken });
    expect(checkSession.status).toBe(401);

    // Verify audit log has recorded USER_DELETED_BY_ADMIN
    const auditRes = await api.request('GET', '/api/admin/audit?event_type=USER_DELETED_BY_ADMIN', { token: adminToken });
    expect(auditRes.status).toBe(200);
    expect(auditRes.data.logs.length).toBeGreaterThanOrEqual(1);
  });
});
