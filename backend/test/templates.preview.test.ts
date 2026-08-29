import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDockerRunning } from '../src/tools.js';
import { sandboxManager } from '../src/execution/sandbox.js';
import { makeTestConfig, startTestApi, type TestApi } from './helpers.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each web starter ships a zero-dependency server + a page; this proves the
// existing preview detection + proxy actually serve that page end to end.
const WEB_STARTERS = [
  { id: 'static-web', port: 8080, entry: 'main.js', needle: 'It works!' },
  { id: 'node-web', port: 3000, entry: 'server.js', needle: 'CloudeeeIDE Web Preview' },
];

describe.skipIf(!isDockerRunning())('web starter templates serve real preview content', () => {
  let cfg: ReturnType<typeof makeTestConfig>;
  let api: TestApi;
  let token: string;
  const createdProjectIds: string[] = [];

  beforeAll(async () => {
    await sandboxManager.cleanupAllSandboxes().catch(() => {});
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    token = (
      await api.request('POST', '/api/auth/register', {
        body: { username: 'webstarter', password: 'secret123' },
      })
    ).data.token;
  }, 60_000);

  afterAll(async () => {
    for (const pid of createdProjectIds) {
      await sandboxManager.stopProjectSandbox(pid).catch(() => {});
    }
    await api?.close();
  }, 60_000);

  for (const starter of WEB_STARTERS) {
    it(`${starter.id}: Run the entry file, preview detects the port and the proxy serves the page`, async () => {
      const created = await api.request('POST', '/api/projects/from-template', {
        token,
        body: { templateId: starter.id, name: `preview ${starter.id}` },
      });
      expect(created.status).toBe(201);
      const pid: string = created.data.project.id;
      createdProjectIds.push(pid);

      const workspaceDir = join(cfg.workspacesDir, pid);
      const containerId = await sandboxManager.ensureProjectSandbox(
        pid,
        cfg,
        workspaceDir,
        1,
      );

      // Start the starter's own server exactly as "Run" would, but detached
      // and self-terminating so the test can't hang.
      await execFileAsync('docker', [
        'exec',
        '-d',
        containerId,
        'sh',
        '-c',
        `cd /workspace && timeout 40 node ${starter.entry}`,
      ]);
      await sleep(3000);

      const detect = await api.request(
        'GET',
        `/api/projects/${pid}/preview/ports`,
        { token },
      );
      expect(detect.status).toBe(200);
      expect(detect.data.sandbox).toBe(true);
      expect(detect.data.ports).toContain(starter.port);

      const proxied = await api.request(
        'GET',
        `/api/projects/${pid}/proxy/${starter.port}/`,
        { token },
      );
      expect(proxied.status).toBe(200);
      expect(proxied.text).toContain(starter.needle);
    }, 120_000);
  }
});
