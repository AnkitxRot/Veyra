import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestConfig, startTestApi, type TestApi } from './helpers.js';

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);
});

afterAll(async () => {
  await api?.close();
});

describe('Zero-Setup Demo Mode API', () => {
  it('POST /api/auth/demo provisions a disposable guest user with pre-seeded files', async () => {
    const res = await api.request('POST', '/api/auth/demo');
    expect(res.status).toBe(201);
    expect(res.data.user).toBeDefined();
    expect(res.data.user.username).toMatch(/^evaluator_/);
    expect(res.data.user.isDemo).toBe(true);
    expect(res.data.project).toBeDefined();
    expect(res.data.project.name).toBe('CloudShowcase');

    const token = res.data.token;
    expect(token).toBeDefined();

    // Verify pre-seeded files in showcase workspace
    const treeRes = await api.request('GET', `/api/projects/${res.data.project.id}/tree`, { token });
    expect(treeRes.status).toBe(200);

    const fileNames = treeRes.data.tree.map((n: any) => n.name);
    expect(fileNames).toContain('1_welcome.py');
    expect(fileNames).toContain('2_benchmark.c');
    expect(fileNames).toContain('3_web_server.js');
    expect(fileNames).toContain('4_security_probe.py');
  });

  it('verifies /api/auth/me reports demo status for guest accounts', async () => {
    const demoRes = await api.request('POST', '/api/auth/demo');
    const token = demoRes.data.token;

    const meRes = await api.request('GET', '/api/auth/me', { token });
    expect(meRes.status).toBe(200);
    expect(meRes.data.user.isDemo).toBe(true);
    expect(meRes.data.user.username).toMatch(/^evaluator_/);
  });
});
