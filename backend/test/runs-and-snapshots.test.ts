import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestConfig, startTestApi, type TestApi } from './helpers.js';

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;
let token: string;
let projectId: string;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);

  const authRes = await api.request('POST', '/api/auth/register', {
    body: { username: 'testruns', password: 'password123' },
  });
  token = authRes.data.token;

  const projRes = await api.request('POST', '/api/projects', {
    token,
    body: { name: 'Test Runs Project', language: 'python' },
  });
  projectId = projRes.data.project.id;
});

afterAll(async () => {
  await api?.close();
});

describe('Job History, Telemetry Stats & Snapshots API', () => {
  it('GET /api/projects/:id/stats returns structured container metrics', async () => {
    const res = await api.request('GET', `/api/projects/${projectId}/stats`, { token });
    expect(res.status).toBe(200);
    expect(res.data.stats).toBeDefined();
    expect(typeof res.data.stats.cpuPercent).toBe('number');
    expect(typeof res.data.stats.memoryUsageBytes).toBe('number');
    expect(typeof res.data.stats.memoryLimitBytes).toBe('number');
    expect(typeof res.data.stats.pids).toBe('number');
  });

  it('GET /api/projects/:id/runs returns recorded execution history', async () => {
    // Record sample run in database
    api.db.prepare(`
      INSERT INTO runs (id, project_id, user_id, language, file_path, status, exit_code, duration_ms)
      VALUES ('run-sample-1', ?, 1, 'python', 'main.py', 'success', 0, 42)
    `).run(projectId);

    const res = await api.request('GET', `/api/projects/${projectId}/runs`, { token });
    expect(res.status).toBe(200);
    expect(res.data.runs).toHaveLength(1);
    expect(res.data.runs[0].id).toBe('run-sample-1');
    expect(res.data.runs[0].duration_ms).toBe(42);
    expect(res.data.total).toBe(1);
  });

  it('handles workspace snapshot creation, listing, restore, and deletion', async () => {
    // 1. Create a sample file
    await api.request('POST', `/api/projects/${projectId}/file`, {
      token,
      body: { path: 'test.py', content: 'print("v1")' },
    });

    // 2. Create snapshot
    const snapRes = await api.request('POST', `/api/projects/${projectId}/snapshots`, {
      token,
      body: { name: 'Initial V1' },
    });
    expect(snapRes.status).toBe(201);
    const snapshotId = snapRes.data.snapshot.id;
    expect(snapshotId).toBeDefined();
    expect(snapRes.data.snapshot.name).toBe('Initial V1');

    // 3. List snapshots
    const listRes = await api.request('GET', `/api/projects/${projectId}/snapshots`, { token });
    expect(listRes.status).toBe(200);
    expect(listRes.data.snapshots).toHaveLength(1);

    // 4. Modify workspace file
    await api.request('POST', `/api/projects/${projectId}/file`, {
      token,
      body: { path: 'test.py', content: 'print("v2 - modified")' },
    });

    // 5. Restore snapshot
    const restoreRes = await api.request('POST', `/api/projects/${projectId}/snapshots/${snapshotId}/restore`, { token });
    expect(restoreRes.status).toBe(200);

    // 6. Verify restored file content
    const fileRes = await api.request('GET', `/api/projects/${projectId}/file?path=test.py`, { token });
    expect(fileRes.status).toBe(200);
    expect(fileRes.data.content).toBe('print("v1")');

    // 7. Delete snapshot
    const delRes = await api.request('DELETE', `/api/projects/${projectId}/snapshots/${snapshotId}`, { token });
    expect(delRes.status).toBe(200);

    const afterDelete = await api.request('GET', `/api/projects/${projectId}/snapshots`, { token });
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.data.snapshots).toHaveLength(0);
  });
});
