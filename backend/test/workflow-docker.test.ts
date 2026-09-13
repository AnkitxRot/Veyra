import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { runWorkflowTask } from "../src/workflow/run.js";

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
if (process.env.CI === "true" && !dockerOk) {
  throw new Error(
    "M84 CI requires Docker and cloudeeeide-runner:latest for workflow tests",
  );
}

describe.skipIf(!dockerOk)("workflow docker (real npm test/build)", () => {
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

  function seedNodeProject() {
    const cfg = makeTestConfig({ buildTimeoutMs: 45_000 });
    const ws = makeWorkspace(cfg);
    mkdirSync(join(ws, "tests"));
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({
        name: "wf-docker",
        scripts: {
          test: "node --test --test-reporter=tap tests/add.test.js",
          build: "node -e \"require('fs').writeFileSync('out.txt','ok')\"",
          "test:hang": "node -e \"setInterval(()=>{},1000)\"",
        },
      }),
    );
    writeFileSync(
      join(ws, "tests", "add.test.js"),
      [
        "const test = require('node:test');",
        "const assert = require('node:assert');",
        "test('adds', () => { assert.strictEqual(1 + 1, 2); });",
        "test('fails', () => { assert.strictEqual(1 + 1, 3); });",
        "",
      ].join("\n"),
    );
    const projectId = `wf-${randomUUID()}`;
    activeProjectId = projectId;
    return { cfg, ws, projectId };
  }

  it("runs npm test in the sandbox and parses TAP results", async () => {
    const { cfg, ws, projectId } = seedNodeProject();
    const r = await runWorkflowTask({
      cfg,
      projectId,
      workspaceDir: ws,
      userId: 1,
      taskId: "npm:test",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.command).toBe("npm");
    expect(r.value.args).toEqual([
      "run",
      "test",
    ]);
    expect(r.value.result.exitCode).not.toBe(0);
    const names = r.value.tests.map((t) => t.name);
    expect(names.some((n) => /adds/i.test(n))).toBe(true);
    expect(names.some((n) => /fails/i.test(n))).toBe(true);
    expect(r.value.tests.some((t) => t.status === "failed")).toBe(true);
    expect(r.value.tests.some((t) => t.status === "passed")).toBe(true);
  }, 60_000);

  it("runs npm build and reports success", async () => {
    const { cfg, ws, projectId } = seedNodeProject();
    const r = await runWorkflowTask({
      cfg,
      projectId,
      workspaceDir: ws,
      userId: 1,
      taskId: "npm:build",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("build");
    expect(r.value.result.exitCode).toBe(0);
    expect(r.value.tests).toEqual([]);
  }, 60_000);

  it("cancels a hanging test task", async () => {
    const { cfg, ws, projectId } = seedNodeProject();
    let cancelled = false;
    const run = runWorkflowTask({
      cfg,
      projectId,
      workspaceDir: ws,
      userId: 1,
      taskId: "npm:test:hang",
      onController: (ctrl) => {
        setTimeout(() => {
          cancelled = true;
          ctrl.kill();
        }, 800);
      },
    });
    const r = await run;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cancelled).toBe(true);
    expect(r.value.result.exitCode === 0).toBe(false);
  }, 60_000);

  it("refuses a script that is not allowlisted even if asked directly", async () => {
    const { cfg, ws, projectId } = seedNodeProject();
    const r = await runWorkflowTask({
      cfg,
      projectId,
      workspaceDir: ws,
      userId: 1,
      taskId: "npm:start",
    });
    expect(r.ok).toBe(false);
  });
});
