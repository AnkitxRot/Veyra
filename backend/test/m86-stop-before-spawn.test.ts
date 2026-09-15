import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";

/**
 * M86 — Stop pressed right after Run/Test starts must stop it.
 *
 * `/ws/execute` only cancelled a not-yet-spawned process when the socket
 * disconnected. A `stop` that arrived while the start was still preparing
 * (sandbox startup, workflow resolution, the read-your-writes barrier) set
 * `stopRequested` but nothing checked it, so the process spawned anyway and a
 * hanging test ran until its timeout (CI: "stops a hanging task").
 */

function makeFakeWs() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    close() {},
    on(event: string, fn: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return this;
    },
    emit(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
}

const PROJECT_ID = "proj-stop";
const USER_ID = 1;

async function tick() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("M86 /ws/execute honors a stop that arrives before the process exists", () => {
  let db: Db;

  beforeEach(() => {
    vi.resetModules();
    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES (?, 'stopper', 'x')",
    ).run(USER_ID);
    db.prepare(
      "INSERT INTO projects (id, owner_id, name, language) VALUES (?, ?, 'Stop', 'python')",
    ).run(PROJECT_ID, USER_ID);
  });

  afterEach(() => {
    vi.doUnmock("../src/execution/pipeline.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
    db.close();
  });

  async function boot() {
    let captured: any = null;
    let releaseSpawn!: () => void;
    const spawnPoint = new Promise<void>((r) => (releaseSpawn = r));
    const kill = vi.fn();
    const runProject = vi.fn(async (_cfg: unknown, _pid: string, _cwd: string, opts: any) => {
      captured = opts;
      // Sandbox startup in progress: the process does not exist yet.
      await spawnPoint;
      if (opts.isCancelled?.()) {
        return { type: "success", exitCode: null, signal: null, timedOut: false, oom: false, durationMs: 1, stdout: "", stderr: "cancelled" };
      }
      opts.onController?.({ kill, writeStdin: vi.fn() });
      return { type: "success", exitCode: 0, signal: null, timedOut: false, oom: false, durationMs: 1, stdout: "", stderr: "" };
    });
    vi.doMock("../src/execution/pipeline.js", () => ({ runProject }));
    vi.doMock("../src/projects/service.js", async (orig) => ({
      ...((await orig()) as object),
      workspacePath: async () => "/tmp/does-not-matter",
    }));
    const { handleExecutionConnection } = await import("../src/ws/execution.js");
    const ws = makeFakeWs();
    await handleExecutionConnection(ws as any, PROJECT_ID, USER_ID, "stopper", makeTestConfig(), db);
    return { ws, runProject, kill, releaseSpawn, opts: () => captured };
  }

  it("a stop before spawn cancels the run instead of letting it start", async () => {
    const { ws, runProject, kill, releaseSpawn, opts } = await boot();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "start", language: "python", activeFile: "main.py" })));
    await tick();
    expect(runProject).toHaveBeenCalledTimes(1);
    expect(opts().isCancelled()).toBe(false);

    ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
    expect(opts().isCancelled()).toBe(true);

    releaseSpawn();
    await tick();
    expect(kill).not.toHaveBeenCalled();
  });

  it("a controller handed out after a stop is killed immediately", async () => {
    const { ws, kill, opts } = await boot();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "start", language: "python", activeFile: "main.py" })));
    await tick();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
    // The process appeared after the pre-spawn check but before any kill.
    opts().onController({ kill, writeStdin: vi.fn() });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
