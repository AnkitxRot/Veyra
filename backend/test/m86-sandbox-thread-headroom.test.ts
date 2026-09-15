/**
 * M86 — the sandbox pids limit must leave room for the IDE's own tools.
 *
 * Docker's --pids-limit counts threads. The TypeScript language server stack
 * (typescript-language-server + two tsserver processes + typingsInstaller)
 * holds ~36 threads on its own; `npm test` → `node --test` → one child per
 * test file adds ~10 each. At the old limit of 64, a test run started while
 * the language server was up could not create Node's platform threads and
 * hung in a futex until the task timeout (observed: pids.events "max 1").
 *
 * Measured at 64: the language server stack plus a two-file test run peaked
 * at 58 threads. The invariant pinned here is headroom, not an exact count:
 * after the IDE's own tools and a test run, the sandbox must still fit a
 * terminal session and a typical dev server (vite/esbuild ≈ 25 threads).
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  languageServers,
  resetLanguageServersForTests,
} from "../src/lsp/manager.js";
import type { LspClientSocket } from "../src/lsp/session.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { runWorkflowTask } from "../src/workflow/run.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";

const REQUIRED_HEADROOM_THREADS = 64;

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
if (process.env.CI === "true" && !dockerOk) {
  throw new Error(
    "M86 CI requires Docker and cloudeeeide-runner:latest for the sandbox thread-headroom test",
  );
}

class FakeSock implements LspClientSocket {
  readyState = 1;
  messages: any[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

async function waitFor(pred: () => boolean, ms: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function cgroup(projectId: string, file: string): string {
  return execFileSync(
    "docker",
    ["exec", `ide-sandbox-${projectId}`, "cat", `/sys/fs/cgroup/${file}`],
    { encoding: "utf8" },
  ).trim();
}

describe.skipIf(!dockerOk)("M86 sandbox thread headroom (Docker)", () => {
  afterAll(async () => {
    resetLanguageServersForTests();
    await sandboxManager.cleanupAllSandboxes();
  });

  it("runs a multi-file node test task while the TypeScript language server is up", async () => {
    const cfg = makeTestConfig({ lspStartupTimeoutMs: 30_000, buildTimeoutMs: 30_000 });
    const ws = makeWorkspace(cfg);
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({
        name: "m86-headroom",
        scripts: {
          test: "node --test --test-reporter=tap tests/a.test.js tests/b.test.js",
        },
      }),
    );
    for (const name of ["a", "b"]) {
      writeFileSync(
        join(ws, "tests", `${name}.test.js`),
        [
          "const test = require('node:test');",
          "const assert = require('node:assert');",
          `test('${name} works', () => { assert.strictEqual(1 + 1, 2); });`,
          "",
        ].join("\n"),
      );
    }
    writeFileSync(join(ws, "main.js"), "export const add = (a, b) => a + b;\n");

    const projectId = `m86-pids-${randomUUID()}`;
    const sock = new FakeSock();
    const session = await languageServers.attach({
      projectId,
      language: "typescript",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    expect(session).not.toBeNull();
    await waitFor(
      () =>
        [...sock.messages]
          .reverse()
          .find((m) => m.type === "status")?.state === "ready",
      30_000,
      "typescript language server ready",
    );
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///workspace/main.js",
          languageId: "javascript",
          text: "export const add = (a, b) => a + b;\n",
        },
      },
    });
    // The whole language-server stack (both tsservers + typingsInstaller)
    // is up once the sandbox holds this many threads.
    await waitFor(
      () => Number(cgroup(projectId, "pids.current")) >= 30,
      30_000,
      "language server stack threads",
    );

    const r = await runWorkflowTask({
      cfg,
      projectId,
      workspaceDir: ws,
      userId: 1,
      taskId: "npm:test",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result.timedOut).toBe(false);
    expect(r.value.result.exitCode).toBe(0);
    expect(r.value.tests.map((t) => t.status)).toEqual(["passed", "passed"]);
    // The cgroup never had to refuse a thread or process…
    expect(cgroup(projectId, "pids.events")).toBe("max 0");
    // …and the peak left room for the terminal and the user's own processes.
    const max = Number(cgroup(projectId, "pids.max"));
    const peak = Number(cgroup(projectId, "pids.peak"));
    expect(peak).toBeGreaterThan(30);
    expect(max - peak, `pids.max=${max} pids.peak=${peak}`).toBeGreaterThanOrEqual(
      REQUIRED_HEADROOM_THREADS,
    );
  }, 120_000);
});
