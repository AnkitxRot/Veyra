import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestApi, makeTestConfig, type TestApi } from './helpers.js';
import { isDockerRunning, isRunnerImageAvailable } from '../src/tools.js';
import { sandboxManager } from '../src/execution/sandbox.js';

describe('Python dependency installation and execution inside Docker runner', () => {
  let api: TestApi;
  let token: string;
  const hasDocker = isDockerRunning() && isRunnerImageAvailable();

  beforeAll(async () => {
    const cfg = makeTestConfig();
    api = await startTestApi(cfg);
    const res = await api.request('POST', '/api/auth/register', {
      body: { username: 'py_deps_user', password: 'password123' },
    });
    token = res.data.token;
  });

  afterAll(async () => {
    if (hasDocker) {
      await sandboxManager.cleanupAllSandboxes();
    }
    await api.close();
  });

  it.skipIf(!hasDocker)(
    'installs a real Python package via requirements.txt and executes code importing it',
    async () => {
      // 1. Create project
      const projRes = await api.request('POST', '/api/projects', {
        token,
        body: { name: 'python-pkg-test', language: 'python' },
      });
      expect(projRes.status).toBe(201);
      const projectId = projRes.data.project.id;

      // 2. Write requirements.txt with lightweight package `six`
      await api.request('POST', `/api/projects/${projectId}/file`, {
        token,
        body: { path: 'requirements.txt', content: 'six==1.17.0\n' },
      });

      // 3. Trigger /install endpoint
      const installRes = await api.request('POST', `/api/projects/${projectId}/install`, {
        token,
        body: {},
      });
      expect(installRes.status).toBe(200);
      expect(installRes.text).toContain('Process exited with code 0');

      // 4. Write main.py that imports the package
      const pyCode = `import six\nprint(f"SIX_LOADED:{six.PY3}")\n`;
      await api.request('POST', `/api/projects/${projectId}/file`, {
        token,
        body: { path: 'main.py', content: pyCode },
      });

      // 5. Run project via /run endpoint
      const runRes = await api.request('POST', `/api/projects/${projectId}/run`, {
        token,
        body: {},
      });
      expect(runRes.status).toBe(200);
      expect(runRes.data.type).toBe('success');
      expect(runRes.data.stdout).toContain('SIX_LOADED:True');
      expect(runRes.data.exitCode).toBe(0);
    },
    60000
  );
});
