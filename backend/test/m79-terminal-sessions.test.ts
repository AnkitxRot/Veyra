import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TerminalSessionRegistry,
  TerminalRingBuffer,
  TERMINAL_RING_MAX_BYTES,
} from "../src/execution/terminalSessions.js";

/**
 * M79 — TerminalSessionRegistry unit contract (no Docker, no real PTY).
 */

function fakePty() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: () => void = () => {};
  return {
    onData: (cb: (d: string) => void) => {
      dataCb = cb;
    },
    onExit: (cb: () => void) => {
      exitCb = cb;
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _emit: (d: string) => dataCb(d),
    _exit: () => exitCb(),
  };
}

function fakeWs() {
  return {
    readyState: 1,
    sent: [] as Array<{ type: string; seq?: number; data?: string; reason?: string }>,
    closed: false,
    send(s: string) {
      this.sent.push(JSON.parse(s));
    },
    close() {
      this.closed = true;
      this.readyState = 3;
    },
  };
}

const U = 7;
const P = "proj-a";
const T = "term-1";
const GRACE = 5000;

describe("M79 — TerminalRingBuffer", () => {
  it("B13/B15: bounded at 256 KB, evicts oldest, preserves order", () => {
    const ring = new TerminalRingBuffer(1024);
    for (let i = 0; i < 40; i++) ring.push(i + 1, "x".repeat(100)); // 4000 bytes
    expect(ring.byteLength).toBeLessThanOrEqual(1024);
    const { data } = ring.since(0);
    // ordering: the retained tail is contiguous and ends with the newest chunk
    expect(data.endsWith("x".repeat(100))).toBe(true);
  });

  it("B14: emits a truncation marker only when unseen data was evicted", () => {
    const ring = new TerminalRingBuffer(300);
    ring.push(1, "a".repeat(200));
    ring.push(2, "b".repeat(200)); // evicts chunk 1
    // client already saw through seq 1 → no marker (its missing data is only 2+)
    expect(ring.since(1).truncated).toBe(false);
    // client only saw seq 0 → chunk 1 is gone → marker
    const r0 = ring.since(0);
    expect(r0.truncated).toBe(true);
    expect(r0.data).toContain("truncated");
  });

  it("B2: since(lastSeq) returns only seq > lastSeq, in order", () => {
    const ring = new TerminalRingBuffer();
    ring.push(1, "one");
    ring.push(2, "two");
    ring.push(3, "three");
    expect(ring.since(1).data).toBe("twothree");
    expect(ring.since(3).data).toBe("");
  });

  it("default ring ceiling is 256 KB", () => {
    expect(TERMINAL_RING_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("M79 — TerminalSessionRegistry", () => {
  let reg: TerminalSessionRegistry;
  let released: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    reg = new TerminalSessionRegistry();
    released = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function create(
    userId = U,
    projectId = P,
    terminalId = T,
    pty = fakePty(),
  ) {
    reg.create({
      userId,
      projectId,
      terminalId,
      pty,
      containerId: "ide-sandbox-" + projectId,
      graceMs: GRACE,
      onEnd: () => released.push(userId),
    });
    return pty;
  }

  it("B1: create → detach → reattach within grace keeps the same PTY", () => {
    const pty = create();
    reg.detach(U, P, T);
    vi.advanceTimersByTime(GRACE - 1);
    const ws = fakeWs();
    const res = reg.attach(U, P, T, ws, 0);
    expect(res.ok).toBe(true);
    reg.writeInput(U, P, T, "ls\n");
    expect(pty.write).toHaveBeenCalledWith("ls\n");
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("B2/B3: reattach replays only seq > lastSeq, in order", () => {
    const pty = create();
    const ws1 = fakeWs();
    reg.attach(U, P, T, ws1, 0);
    pty._emit("first\r\n"); // seq 1
    pty._emit("second\r\n"); // seq 2
    pty._emit("third\r\n"); // seq 3
    reg.detach(U, P, T);
    pty._emit("while-gone\r\n"); // seq 4 — buffered only

    const ws2 = fakeWs();
    reg.attach(U, P, T, ws2, 2);
    const replay = ws2.sent.find((m) => m.type === "data");
    expect(replay?.data).toBe("third\r\nwhile-gone\r\n");
    expect(replay?.seq).toBe(4);
  });

  it("B4/B12: detach → grace expiry kills the PTY and releases the gate slot", () => {
    const pty = create();
    reg.detach(U, P, T);
    expect(pty.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(GRACE + 1);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(released).toEqual([U]);
    expect(reg.has(U, P, T)).toBe(false);
    expect(reg.countForUser(U)).toBe(0);
  });

  it("B5 (RACE #1): a grace timer that fires after a reattach does NOT kill the session", () => {
    const pty = create();
    reg.detach(U, P, T);
    vi.advanceTimersByTime(GRACE - 10);
    const ws = fakeWs();
    reg.attach(U, P, T, ws, 0); // bumps generation, clears timer
    // even if a stale timer callback slips through, generation guards it
    vi.advanceTimersByTime(1000);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(reg.has(U, P, T)).toBe(true);
  });

  it("B6 (RACE #2): reattach after the PTY has exited fails honestly, no bogus connected", () => {
    const pty = create();
    reg.detach(U, P, T);
    pty._exit(); // process died while detached
    expect(reg.has(U, P, T)).toBe(false);
    const ws = fakeWs();
    const res = reg.attach(U, P, T, ws, 0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("process_exited");
  });

  it("B7: reapProject kills attached + detached sessions for that project only", () => {
    const p1 = create(U, "proj-x", "t1");
    const p2 = create(U, "proj-x", "t2");
    const p3 = create(U, "proj-y", "t3");
    reg.detach(U, "proj-x", "t2");
    reg.reapProject("proj-x");
    expect(p1.kill).toHaveBeenCalled();
    expect(p2.kill).toHaveBeenCalled();
    expect(p3.kill).not.toHaveBeenCalled();
    expect(reg.has(U, "proj-y", "t3")).toBe(true);
  });

  it("B9: reapUserProject reaps only that user's sessions in that project", () => {
    const a = create(1, "proj-z", "ta");
    const b = create(2, "proj-z", "tb");
    reg.reapUserProject(1, "proj-z");
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).not.toHaveBeenCalled();
  });

  it("B10/B11: detached sessions count; reattach does not double-count", () => {
    create(U, P, "one");
    create(U, P, "two");
    expect(reg.countForUser(U)).toBe(2);
    reg.detach(U, P, "two");
    expect(reg.countForUser(U)).toBe(2); // detached still counts
    reg.attach(U, P, "two", fakeWs(), 0);
    expect(reg.countForUser(U)).toBe(2); // reattach, not a new slot
  });

  it("B16: an exited PTY yields `ended` and reattach never spawns a fresh shell", () => {
    const pty = create();
    const ws1 = fakeWs();
    reg.attach(U, P, T, ws1, 0);
    pty._exit();
    expect(ws1.sent.some((m) => m.type === "ended" && m.reason === "process_exited")).toBe(true);
    // a new connection for the same key: registry says not-present, caller
    // must create a NEW session (new terminalId) explicitly.
    expect(reg.has(U, P, T)).toBe(false);
    expect(reg.attach(U, P, T, fakeWs(), 0).ok).toBe(false);
  });

  it("B17/B18: only one live socket; a second attach displaces the first", () => {
    const pty = create();
    const ws1 = fakeWs();
    reg.attach(U, P, T, ws1, 0);
    const ws2 = fakeWs();
    reg.attach(U, P, T, ws2, 0);
    expect(ws1.closed).toBe(true);
    // output goes to ws2 only, exactly once
    pty._emit("hello");
    expect(ws2.sent.filter((m) => m.type === "data" && m.data === "hello")).toHaveLength(1);
    expect(ws1.sent.filter((m) => m.data === "hello")).toHaveLength(0);
  });

  it("B19: concurrent detach then attach (same tick) leaves one live session", () => {
    const pty = create();
    reg.attach(U, P, T, fakeWs(), 0);
    reg.detach(U, P, T);
    const ws = fakeWs();
    const res = reg.attach(U, P, T, ws, 0);
    expect(res.ok).toBe(true);
    vi.advanceTimersByTime(GRACE * 2);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(reg.has(U, P, T)).toBe(true);
  });

  it("B20: a different user cannot attach to another user's session", () => {
    create(1, P, T);
    const res = reg.attach(2, P, T, fakeWs(), 0);
    expect(res.ok).toBe(false);
    expect(reg.has(1, P, T)).toBe(true);
  });

  it("B21: a different project cannot attach to another project's session", () => {
    create(U, "proj-1", T);
    const res = reg.attach(U, "proj-2", T, fakeWs(), 0);
    expect(res.ok).toBe(false);
  });

  it("B22: an unknown terminalId simply misses — no cross-session hit", () => {
    create(U, P, "known");
    expect(reg.has(U, P, "guessed")).toBe(false);
    expect(reg.attach(U, P, "guessed", fakeWs(), 0).ok).toBe(false);
  });

  it("B23: disposeAll kills every PTY and releases every slot", () => {
    const a = create(1, "pa", "ta");
    const b = create(2, "pb", "tb");
    reg.detach(2, "pb", "tb");
    reg.disposeAll();
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).toHaveBeenCalled();
    expect(reg.size()).toBe(0);
    expect(released.sort()).toEqual([1, 2]);
  });

  it("B24: server data frames carry a monotonic seq", () => {
    const pty = create();
    const ws = fakeWs();
    reg.attach(U, P, T, ws, 0);
    pty._emit("a");
    pty._emit("b");
    pty._emit("c");
    const seqs = ws.sent.filter((m) => m.type === "data").map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("B25: reap sends a typed `ended` frame with a bounded reason", () => {
    const pty = create();
    const ws = fakeWs();
    reg.attach(U, P, T, ws, 0);
    reg.reapProject(P);
    const ended = ws.sent.find((m) => m.type === "ended");
    expect(ended?.reason).toBe("container_stopped");
    expect(ws.closed).toBe(true);
    void pty;
  });

  it("B26: secretsCleanup runs exactly once, on the final reap", () => {
    const cleanup = vi.fn();
    reg.create({
      userId: U,
      projectId: P,
      terminalId: T,
      pty: fakePty(),
      containerId: "c",
      graceMs: GRACE,
      secretsCleanup: cleanup,
      onEnd: () => {},
    });
    reg.detach(U, P, T);
    expect(cleanup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(GRACE + 1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("create() refuses a duplicate live session for the same key", () => {
    create();
    expect(() => create()).toThrow(/already exists/);
  });

  it("reap is idempotent", () => {
    const pty = create();
    reg.reapProject(P);
    reg.reapProject(P);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(released).toEqual([U]);
  });

  it("describe() never exposes the PTY or containerId", () => {
    create();
    const d = reg.describe(U, P, T);
    expect(d).toEqual({
      state: "attached",
      seq: 0,
      ringBytes: 0,
      attached: false,
    });
    expect(JSON.stringify(d)).not.toContain("ide-sandbox");
  });
});
