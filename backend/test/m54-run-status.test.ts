import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
  type RunStatusEntry,
} from "../src/collab/manager.js";
import {
  sanitizeRunFile,
  sanitizeRunLanguage,
  deriveRunState,
  handleExecutionConnection,
} from "../src/ws/execution.js";
import type { RunResult } from "../src/execution/pipeline.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mocked pipeline so the integration block below runs without Docker. Tests
// set `mockRun.result` / `mockRun.impl` per case.
const mockRun: { result: any; impl?: () => Promise<any> } = { result: null };
vi.mock("../src/execution/pipeline.js", async (orig) => {
  const actual = (await orig()) as any;
  return {
    ...actual,
    runProject: vi.fn(async () =>
      mockRun.impl ? mockRun.impl() : mockRun.result,
    ),
  };
});
vi.mock("../src/projects/service.js", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, workspacePath: vi.fn(async () => tmpForWs) };
});
let tmpForWs = "/tmp";

const MESSAGE_CUSTOM = 3;

/** A ws mock that records every frame sent to it (decoded run_status payloads). */
function makeCapturingWs() {
  const sent: any[] = [];
  const ws = {
    readyState: 1,
    send: (data: Uint8Array) => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(dec);
        if (type === MESSAGE_CUSTOM) {
          sent.push(JSON.parse(decoding.readVarString(dec)));
        }
      } catch {
        /* non-custom frame — ignored for this test */
      }
    },
    close: () => {},
  } as any;
  return {
    ws,
    sent,
    runStatusFrames: () => sent.filter((m) => m.type === "run_status"),
  };
}

function entry(over: Partial<RunStatusEntry> = {}): RunStatusEntry {
  return {
    executionId: "exec-" + Math.random().toString(36).slice(2),
    userId: 1,
    username: "alice",
    state: "running",
    file: "src/main.py",
    language: "python",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    ...over,
  };
}

describe("M54 — collaborative run awareness (server-authoritative)", () => {
  let db: any;
  let cfg: any;
  let tmp: string;
  const rooms: CollaborationRoom[] = [];

  const makeRoom = (projectId: string) => {
    const r = new CollaborationRoom(projectId, cfg, db, () => {});
    rooms.push(r);
    return r;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m54-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    collaborationManager.init(cfg, db);
  });

  afterEach(() => {
    for (const r of rooms.splice(0)) {
      try {
        r.dispose();
      } catch {}
    }
    vi.useRealTimers();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // --- pure helpers --------------------------------------------------------

  it("sanitizeRunFile accepts workspace-relative, rejects absolute/traversal/oversize/non-string", () => {
    expect(sanitizeRunFile("src/main.py")).toBe("src/main.py");
    expect(sanitizeRunFile("a\\b.py")).toBe("a/b.py");
    expect(sanitizeRunFile("/etc/passwd")).toBeNull();
    expect(sanitizeRunFile("C:/x")).toBeNull();
    expect(sanitizeRunFile("../../x")).toBeNull();
    expect(sanitizeRunFile("a/../b")).toBeNull();
    expect(sanitizeRunFile("")).toBeNull();
    expect(sanitizeRunFile("x".repeat(300))).toBeNull();
    expect(sanitizeRunFile(42 as any)).toBeNull();
    expect(sanitizeRunFile(undefined)).toBeNull();
  });

  it("sanitizeRunLanguage bounds the identifier", () => {
    expect(sanitizeRunLanguage("python")).toBe("python");
    expect(sanitizeRunLanguage("c++")).toBe("c++");
    expect(sanitizeRunLanguage("c#")).toBe("c#");
    expect(sanitizeRunLanguage("a b")).toBeNull();
    expect(sanitizeRunLanguage("x".repeat(40))).toBeNull();
    expect(sanitizeRunLanguage("$(x)")).toBeNull();
    expect(sanitizeRunLanguage(1 as any)).toBeNull();
  });

  it("deriveRunState maps every outcome to the right collaborator-visible state", () => {
    const ok: RunResult = {
      type: "success",
      language: "python",
      mainFile: "m.py",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      oom: false,
      durationMs: 1,
    };
    const d = (o: any) => deriveRunState(o);
    expect(
      d({ threw: false, disconnected: false, stopRequested: true, result: ok }),
    ).toBe("stopped");
    expect(
      d({ threw: false, disconnected: true, stopRequested: false, result: ok }),
    ).toBe("stopped");
    expect(d({ threw: true, disconnected: false, stopRequested: false })).toBe(
      "failed",
    );
    expect(
      d({
        threw: false,
        disconnected: false,
        stopRequested: false,
        result: { ...ok, timedOut: true, exitCode: null },
      }),
    ).toBe("failed");
    expect(
      d({
        threw: false,
        disconnected: false,
        stopRequested: false,
        result: { ...ok, oom: true, exitCode: null },
      }),
    ).toBe("failed");
    expect(
      d({
        threw: false,
        disconnected: false,
        stopRequested: false,
        result: { ...ok, type: "compile_error" },
      }),
    ).toBe("failed");
    expect(
      d({
        threw: false,
        disconnected: false,
        stopRequested: false,
        result: ok,
      }),
    ).toBe("success");
    expect(
      d({
        threw: false,
        disconnected: false,
        stopRequested: false,
        result: { ...ok, exitCode: 1 },
      }),
    ).toBe("failed");
    expect(
      d({
        threw: false,
        disconnected: false,
        stopRequested: false,
        result: { ...ok, exitCode: null },
      }),
    ).toBe("stopped");
  });

  // --- registry / broadcast ---------------------------------------------

  it("broadcasts a running status to every connected client", async () => {
    const room = makeRoom("p1");
    const a = makeCapturingWs();
    const b = makeCapturingWs();
    await room.addClient(a.ws, { userId: 1, username: "alice", role: "owner" });
    await room.addClient(b.ws, { userId: 2, username: "bob", role: "editor" });

    const e = entry();
    room.handleRunStatus(e);

    for (const c of [a, b]) {
      const f = c.runStatusFrames();
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({
        type: "run_status",
        state: "running",
        executionId: e.executionId,
        userId: 1,
        file: "src/main.py",
        language: "python",
      });
    }
  });

  it("manager.notifyRunStatus is a no-op when no room exists", () => {
    expect(() =>
      collaborationManager.notifyRunStatus("no-such-project", entry()),
    ).not.toThrow();
  });

  it("project isolation: a run status for project A never reaches project B's clients", async () => {
    const roomA = collaborationManager.getOrCreateRoom("A");
    const roomB = collaborationManager.getOrCreateRoom("B");
    rooms.push(roomA, roomB);
    const a = makeCapturingWs();
    const b = makeCapturingWs();
    await roomA.addClient(a.ws, { userId: 1, username: "a", role: "owner" });
    await roomB.addClient(b.ws, { userId: 2, username: "b", role: "owner" });

    collaborationManager.notifyRunStatus("A", entry({ userId: 1 }));

    expect(a.runStatusFrames()).toHaveLength(1);
    expect(b.runStatusFrames()).toHaveLength(0);
  });

  it("terminal state lingers, then a 'cleared' frame drops it", async () => {
    vi.useFakeTimers();
    const room = makeRoom("p1");
    const a = makeCapturingWs();
    await room.addClient(a.ws, { userId: 1, username: "alice", role: "owner" });

    const e = entry();
    room.handleRunStatus(e);
    room.handleRunStatus({
      ...e,
      state: "success",
      endedAt: Date.now(),
      exitCode: 0,
    });

    expect(a.runStatusFrames().at(-1)).toMatchObject({
      state: "success",
      exitCode: 0,
    });
    expect((room as any).runStatus.has(e.executionId)).toBe(true);

    vi.advanceTimersByTime(10_000);

    expect(a.runStatusFrames().at(-1)).toMatchObject({
      state: "cleared",
      executionId: e.executionId,
    });
    expect((room as any).runStatus.has(e.executionId)).toBe(false);
  });

  it("a client joining mid-run receives a snapshot of the active entry immediately", async () => {
    const room = makeRoom("p1");
    const first = makeCapturingWs();
    await room.addClient(first.ws, {
      userId: 1,
      username: "alice",
      role: "owner",
    });
    const e = entry();
    room.handleRunStatus(e);

    const joiner = makeCapturingWs();
    await room.addClient(joiner.ws, {
      userId: 2,
      username: "bob",
      role: "editor",
    });

    const snap = joiner.runStatusFrames();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      executionId: e.executionId,
      state: "running",
    });
  });

  it("two concurrent runs stay independent", async () => {
    vi.useFakeTimers();
    const room = makeRoom("p1");
    const a = makeCapturingWs();
    await room.addClient(a.ws, { userId: 1, username: "alice", role: "owner" });

    const e1 = entry({ userId: 1, username: "alice" });
    const e2 = entry({ userId: 2, username: "bob" });
    room.handleRunStatus(e1);
    room.handleRunStatus(e2);
    expect((room as any).runStatus.size).toBe(2);

    room.handleRunStatus({
      ...e1,
      state: "success",
      endedAt: Date.now(),
      exitCode: 0,
    });
    vi.advanceTimersByTime(10_000);

    expect((room as any).runStatus.has(e1.executionId)).toBe(false);
    expect((room as any).runStatus.has(e2.executionId)).toBe(true);
  });

  it("dispose() clears the registry, linger timers and the sweep interval", async () => {
    vi.useFakeTimers();
    const room = new CollaborationRoom("p-disp", cfg, db, () => {});
    const a = makeCapturingWs();
    await room.addClient(a.ws, { userId: 1, username: "alice", role: "owner" });
    room.handleRunStatus(entry());
    room.handleRunStatus(
      entry({ state: "success", endedAt: Date.now(), exitCode: 0 }),
    );
    expect((room as any).runStatus.size).toBe(2);

    room.dispose();

    expect((room as any).runStatus.size).toBe(0);
    expect((room as any).runStatusLingerTimers.size).toBe(0);
    expect((room as any).runStatusSweepTimer).toBeNull();
  });

  it("orphan sweep drops a stuck running entry after the hard age cap and self-cancels", async () => {
    vi.useFakeTimers();
    const room = makeRoom("p1");
    const a = makeCapturingWs();
    await room.addClient(a.ws, { userId: 1, username: "alice", role: "owner" });

    room.handleRunStatus(entry({ startedAt: Date.now() - 40 * 60 * 1000 }));
    expect((room as any).runStatusSweepTimer).not.toBeNull();

    vi.advanceTimersByTime(60_000);

    expect((room as any).runStatus.size).toBe(0);
    expect(a.runStatusFrames().at(-1)).toMatchObject({ state: "cleared" });
    expect((room as any).runStatusSweepTimer).toBeNull();
  });

  // --- spoof resistance -------------------------------------------------

  it("a client-authored run_status message is ignored — no fabricated entry, no broadcast", () => {
    const room = makeRoom("p1");
    const attacker = makeCapturingWs();
    const victim = makeCapturingWs();
    room.addClient(attacker.ws, {
      userId: 5,
      username: "mallory",
      role: "editor",
    });
    room.addClient(victim.ws, {
      userId: 6,
      username: "victim",
      role: "editor",
    });

    const enc = (obj: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_CUSTOM);
      encoding.writeVarString(e, JSON.stringify(obj));
      return encoding.toUint8Array(e);
    };

    room.handleMessage(
      attacker.ws,
      enc({
        type: "run_status",
        executionId: "fake",
        userId: 999,
        username: "admin",
        state: "running",
        file: "x.py",
        language: "python",
        startedAt: Date.now(),
      }),
    );

    expect((room as any).runStatus.size).toBe(0);
    expect(victim.runStatusFrames()).toHaveLength(0);
  });

  // --- no persistence --------------------------------------------------

  it("run-status transitions write nothing to SQLite", async () => {
    const room = makeRoom("p1");
    const a = makeCapturingWs();
    await room.addClient(a.ws, { userId: 1, username: "alice", role: "owner" });

    const count = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as any).n;
    const before = count();

    room.handleRunStatus(entry());
    room.handleRunStatus(
      entry({ state: "failed", endedAt: Date.now(), exitCode: 1 }),
    );

    expect(count()).toBe(before);
  });
});

// --- integration: the real execution socket drives the room ----------------
// Mocked pipeline (no Docker), mirroring execution-history.test.ts's harness.
describe("M54 — execution socket → collaboration room integration", () => {
  const PID = "proj-m54-int";

  function makeFakeWs() {
    const listeners = new Map<string, Array<(...a: any[]) => void>>();
    return {
      OPEN: 1,
      CLOSED: 3,
      readyState: 1,
      sent: [] as string[],
      send(d: string) {
        this.sent.push(d);
      },
      close() {
        this.readyState = 3;
      },
      on(ev: string, fn: (...a: any[]) => void) {
        (listeners.get(ev) ?? listeners.set(ev, []).get(ev)!).push(fn);
        return this;
      },
      emit(ev: string, ...a: any[]) {
        for (const fn of listeners.get(ev) ?? []) fn(...a);
      },
    };
  }
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };

  let db: any;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m54i-"));
    tmpForWs = tmp;
    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO projects (id, owner_id, name, language) VALUES (?, 1, 'P', 'python')",
    ).run(PID);
    const cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    collaborationManager.init(cfg, db);
    mockRun.result = null;
    mockRun.impl = undefined;
  });

  afterEach(() => {
    collaborationManager.getRoom(PID)?.dispose();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  async function drive(result: any, opts: { stop?: boolean } = {}) {
    mockRun.result = result;
    const room = collaborationManager.getOrCreateRoom(PID);
    const client = makeCapturingWs();
    await room.addClient(client.ws, {
      userId: 2,
      username: "bob",
      role: "editor",
    });

    const ws = makeFakeWs();
    await handleExecutionConnection(
      ws as any,
      PID,
      1,
      "alice",
      { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp } as any,
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
    if (opts.stop) {
      await new Promise((r) => setTimeout(r, 0));
      ws.emit("message", Buffer.from(JSON.stringify({ type: "stop" })));
    }
    await flush();
    return { frames: client.runStatusFrames(), ws };
  }

  const RESULT = {
    type: "success",
    language: "python",
    mainFile: "main.py",
    stdout: "SUPER_SECRET_M54_TEST=hunter2\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    oom: false,
    durationMs: 5,
  };

  it("a real successful run broadcasts running then success with the server executionId + startedAt", async () => {
    const t0 = Date.now();
    const { frames } = await drive(RESULT);
    expect(frames.map((f) => f.state)).toEqual(["running", "success"]);
    expect(frames[0].executionId).toBe(frames[1].executionId);
    expect(typeof frames[0].executionId).toBe("string");
    expect(frames[0].startedAt).toBeGreaterThanOrEqual(t0);
    expect(frames[1]).toMatchObject({
      file: "main.py",
      language: "python",
      exitCode: 0,
    });
  });

  it("a nonzero exit → terminal state failed", async () => {
    const { frames } = await drive({ ...RESULT, exitCode: 2 });
    expect(frames.at(-1)).toMatchObject({ state: "failed", exitCode: 2 });
  });

  it("SECRET REGRESSION: no run_status frame carries stdout/env/secret/command text", async () => {
    const { frames } = await drive(RESULT);
    for (const f of frames) {
      const s = JSON.stringify(f);
      expect(s).not.toContain("hunter2");
      expect(s).not.toContain("SUPER_SECRET");
      expect(s).not.toContain("stdout");
      expect(s).not.toContain("stderr");
      expect(s).not.toMatch(/print|python main\.py|=hunter/);
      expect(Object.keys(f).sort()).toEqual(
        [
          "endedAt",
          "executionId",
          "exitCode",
          "file",
          "language",
          "startedAt",
          "state",
          "type",
          "userId",
          "username",
        ].sort(),
      );
    }
  });

  it("an explicit stop → terminal state stopped", async () => {
    const { frames } = await drive(
      { ...RESULT, exitCode: null, signal: "SIGKILL" },
      { stop: true },
    );
    expect(frames.at(-1)).toMatchObject({ state: "stopped" });
  });
});
