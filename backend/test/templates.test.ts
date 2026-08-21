import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestConfig, startTestApi, type TestApi } from './helpers.js';

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;
let token: string;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);

  const authRes = await api.request('POST', '/api/auth/register', {
    body: { username: 'tpltester', password: 'password123' },
  });
  token = authRes.data.token;
});

afterAll(async () => {
  await api?.close();
});

describe('Project Starter Templates API', () => {
  it('GET /api/projects/templates/catalog returns available starters', async () => {
    const res = await api.request('GET', '/api/projects/templates/catalog', { token });
    expect(res.status).toBe(200);
    expect(res.data.templates).toBeDefined();

    const ids = res.data.templates.map((t: any) => t.id);
    expect(ids).toContain('python-data');
    expect(ids).toContain('cpp-systems');
    expect(ids).toContain('node-web');
  });

  it('POST /api/projects/from-template creates a pre-populated workspace', async () => {
    const res = await api.request('POST', '/api/projects/from-template', {
      token,
      body: { templateId: 'python-data', name: 'My Python Project' },
    });

    expect(res.status).toBe(201);
    expect(res.data.project).toBeDefined();
    expect(res.data.project.name).toBe('My Python Project');

    const treeRes = await api.request('GET', `/api/projects/${res.data.project.id}/tree`, { token });
    expect(treeRes.status).toBe(200);

    const names = treeRes.data.tree.map((n: any) => n.name);
    expect(names).toContain('main.py');
    expect(names).toContain('README.md');
  });
});
