import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";

/**
 * Minimal stand-in for the parts of `ws`'s WebSocket that
 * handleExecutionConnection touches (same shape as the harness in
 * terminal.test.ts): readyState/OPEN/CLOSED, send, close and on().
 */
function makeFakeWs() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    sent: [] as string[],
    closed: false,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
    on(event: string, fn: (...args: any[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(fn);
      listeners.set(event, existing);
      return this;
    },
    emit(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
}

/** Lets the handler's async message listener run to completion. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const PROJECT_ID = "proj-history";
const USER_ID = 1;

function seedDb(): Db {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO users (id, username, password_hash) VALUES (?, 'historyuser', 'x')`,
  ).run(USER_ID);
  db.prepare(
    `INSERT INTO projects (id, owner_id, name, language) VALUES (?, ?, 'History', 'python')`,
  ).run(PROJECT_ID, USER_ID);
  return db;
}

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "success",
    language: "python",
    mainFile: "main.py",
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    oom: false,
    durationMs: 5,
    ...overrides,
  };
}

/**
 * Boots handleExecutionConnection against a mocked pipeline + real in-memory
 * DB. `runProject` resolves with `result` only once `release()` is called, so
 * tests can interleave a disconnect with an in-flight run.
 */
async function startRun(db: Db, result: Record<string, unknown>) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const runProject = vi.fn(async () => {
    await gate;
    return result;
  });
  vi.doMock("../src/execution/pipeline.js", () => ({ runProject }));
  vi.doMock("../src/projects/service.js", () => ({
    workspacePath: async () => "/tmp/does-not-matter",
  }));

  const { handleExecutionConnection } = await import("../src/ws/execution.js");
  const ws = makeFakeWs();
  await handleExecutionConnection(
    ws as any,
    PROJECT_ID,
    USER_ID,
    "test-user",
    makeTestConfig(),
    db,
  );

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        language: "python",
        activeFile: "main.py",
      }),
    ),
  );
  await flush();

  return { ws, release };
}

function lastRunRow(db: Db) {
  return db
    .prepare(
      `SELECT status, exit_code, signal FROM runs ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as
    | { status: string; exit_code: number | null; signal: string | null }
    | undefined;
}

describe("run history records how an execution actually ended", () => {
  let db: Db;

  beforeEach(() => {
    vi.resetModules();
    db = seedDb();
  });

  afterEach(() => {
    vi.doUnmock("../src/execution/pipeline.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
    db.close();
  });

  it("records a SIGKILL'd run (manual Stop) as killed with a null exit code", async () => {
    // Regression guard: pipeline's run phase always returns `type: 'success'`,
    // and a SIGKILL'd child reports `exitCode: null`. Persisting
    // `exitCode ?? 0` would file a run the user explicitly stopped as a clean
    // `success`/`0`, indistinguishable from a genuine completion.
    const { release } = await startRun(
      db,
      baseResult({ exitCode: null, signal: "SIGKILL" }),
    );
    release();
    await flush();

    const row = lastRunRow(db);
    expect(row).toBeDefined();
    expect(row!.status).toBe("killed");
    expect(row!.exit_code).toBeNull();
    expect(row!.signal).toBe("SIGKILL");
  });

  it("records a watchdog-timed-out run as timeout with a null exit code", async () => {
    const { release } = await startRun(
      db,
      baseResult({ exitCode: null, signal: "SIGKILL", timedOut: true }),
    );
    release();
    await flush();

    const row = lastRunRow(db);
    expect(row!.status).toBe("timeout");
    expect(row!.exit_code).toBeNull();
  });

  it("records a run cancelled by client disconnect as cancelled", async () => {
    const { ws, release } = await startRun(
      db,
      baseResult({ exitCode: null, signal: null }),
    );

    // Client goes away while the run is still in flight.
    ws.readyState = ws.CLOSED;
    ws.emit("close");
    await flush();

    release();
    await flush();

    const row = lastRunRow(db);
    expect(row!.status).toBe("cancelled");
    expect(row!.exit_code).toBeNull();
  });

  it("still records a normal clean run as success with exit code 0", async () => {
    const { ws, release } = await startRun(db, baseResult({ exitCode: 0 }));
    release();
    await flush();

    const row = lastRunRow(db);
    expect(row!.status).toBe("success");
    expect(row!.exit_code).toBe(0);
    expect(ws.sent.some((m) => JSON.parse(m).type === "exit")).toBe(true);
  });

  it("leaves non-success outcomes untouched", async () => {
    const { release } = await startRun(
      db,
      baseResult({
        type: "compile_error",
        exitCode: null,
        stderr: "boom",
      }),
    );
    release();
    await flush();

    const row = lastRunRow(db);
    expect(row!.status).toBe("compile_error");
    expect(row!.exit_code).toBe(1);
  });
});
