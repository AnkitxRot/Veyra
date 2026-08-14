import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProject } from '../src/execution/pipeline.js';
import { DEFAULT_LIMITS, IS_WINDOWS } from '../src/config.js';
import { isDockerRunning } from '../src/tools.js';
import { sandboxManager } from '../src/execution/sandbox.js';
import { makeTestConfig, makeWorkspace } from './helpers.js';

const cfg = makeTestConfig();

describe.skipIf(!isDockerRunning())('sandbox', () => {
  afterAll(async () => {
    await sandboxManager.cleanupAllSandboxes();
  });

  it('terminates an infinite loop via the wall-clock timeout', async () => {
    const cfg = makeTestConfig({
      runTimeoutMs: 3000,
      limits: { ...DEFAULT_LIMITS, cpuSeconds: 120 },
    });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.py'), 'while True:\n    pass\n');
    const start = Date.now();
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15000);
    expect(r.type).toBe('success');
  });

  // uid check only makes sense on Linux with prlimit/setpriv
  it.skipIf(IS_WINDOWS)('does not run user code as root', async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.py'), 'import os\nprint(os.getuid())\n');
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe('success');
    const uid = Number(r.stdout.trim());
    expect(uid).not.toBe(0);
    expect(uid).toBe(cfg.runUser.uid);
  });

  // cgroup cleanup only on Linux
  it.skipIf(IS_WINDOWS)('cleans up cgroup directories after a run', async () => {
    const { readdirSync } = await import('node:fs');
    const cfg = makeTestConfig({ cgroupRoot: '/sys/fs/cgroup/cloudide-test-cleanup' });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, 'main.py'), 'print("cleanup check")\n');
    await runProject(cfg, `test-${randomUUID()}`, ws, {});
    const uuid = /^[0-9a-f-]{36}$/;
    const leftoverRunDirs = readdirSync(cfg.cgroupRoot).filter((d) => uuid.test(d));
    expect(leftoverRunDirs).toHaveLength(0);
  });
});
