import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProject } from '../src/execution/pipeline.js';
import { isDockerRunning } from '../src/tools.js';
import { sandboxManager } from '../src/execution/sandbox.js';
import { makeTestConfig, makeWorkspace } from './helpers.js';
import { STARTER_TEMPLATES } from '../src/projects/templates.js';

const cfg = makeTestConfig();

// Starters whose entry point runs to completion on its own (the two web
// starters run a server forever — they are covered by templates.preview.test.ts).
const RUN_TO_COMPLETION = ['python', 'node', 'typescript', 'c', 'cpp-systems', 'java'];

describe.skipIf(!isDockerRunning())('starter templates execute through the real pipeline', () => {
  let activeProjectId: string | undefined;

  afterEach(async () => {
    if (activeProjectId) {
      await sandboxManager.stopProjectSandbox(activeProjectId);
      activeProjectId = undefined;
    }
  });

  afterAll(async () => {
    await sandboxManager.cleanupAllSandboxes();
  });

  for (const id of RUN_TO_COMPLETION) {
    it(`${id}: compiles/runs and exits 0`, async () => {
      const tpl = STARTER_TEMPLATES.find((t) => t.id === id)!;
      expect(tpl).toBeTruthy();

      const ws = makeWorkspace(cfg);
      for (const f of tpl.files) writeFileSync(join(ws, f.path), f.content);

      const projectId = `test-${randomUUID()}`;
      activeProjectId = projectId;

      const r = await runProject(cfg, projectId, ws, {
        userId: 1,
        language: tpl.language,
      });

      expect(r.type, `${id} outcome (${r.stderr})`).toBe('success');
      expect(r.exitCode, `${id} exit code`).toBe(0);
      expect(r.mainFile).toBe(tpl.entryFile);
      expect(r.stdout.trim().length, `${id} produced stdout`).toBeGreaterThan(0);
    }, 120_000);
  }
});
