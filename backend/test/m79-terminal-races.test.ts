import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";

/**
 * M79 — terminal lifecycle races found in the post-M79 hardening pass.
 *
 *  - RACE D: a socket displaced by a newer attach must not, when its own
 *    (late) `close` finally lands, detach the session the newer socket owns.
 */

function makeFakeWs() {
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  return {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    sent: [] as any[],
    closed: false,
    send(d: string) {
      this.sent.push(JSON.parse(d));
    },
    close() {
      this.closed = true;
      this.readyState = 3;
    },
    on(ev: string, fn: (...a: any[]) => void) {
      const arr = listeners.get(ev) ?? [];
      arr.push(fn);
      listeners.set(ev, arr);
      return this;
    },
    emit(ev: string, ...a: any[]) {
      for (const fn of [...(listeners.get(ev) ?? [])]) fn(...a);
    },
  };
}

async function load() {
  const spawn = vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }));
  vi.doMock("node-pty", () => ({ spawn }));
  vi.doMock("../src/execution/sandbox.js", () => ({
    sandboxManager: {
      ensureProjectSandbox: vi.fn(async () => "ide-sandbox-p"),
      touch: vi.fn(),
    },
  }));
  vi.doMock("../src/projects/service.js", () => ({
    workspacePath: async () => "/tmp/x",
  }));
  const mod = await import("../src/ws/terminal.js");
  const reg = await import("../src/execution/terminalSessions.js");
  return { ...mod, ...reg, spawn };
}

describe("M79 — terminal lifecycle races", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("node-pty");
    vi.doUnmock("../src/execution/sandbox.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
    vi.useRealTimers();
  });

  it("RACE D: a displaced socket's late close does not detach the reattached session", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig({ terminalDetachGraceMs: 1000 });
    vi.useFakeTimers();

    // Fresh session, live on wsA.
    const wsA = makeFakeWs();
    await handleTerminalConnection(wsA as any, "p", cfg, 1, undefined, "tid");
    expect(terminalSessions.describe(1, "p", "tid")?.attached).toBe(true);

    // The client reconnects on wsB while wsA is still half-open (the server has
    // not yet seen wsA's close). wsB reattaches and displaces wsA.
    const wsB = makeFakeWs();
    await handleTerminalConnection(wsB as any, "p", cfg, 1, undefined, "tid", 0);
    expect(wsA.closed).toBe(true);
    expect(terminalSessions.describe(1, "p", "tid")?.attached).toBe(true);

    // wsA's close finally lands — its wireSocketToSession 'close' handler runs.
    wsA.emit("close");

    // The session must remain attached to wsB — not be detached or reaped.
    expect(terminalSessions.describe(1, "p", "tid")?.state).toBe("attached");
    expect(terminalSessions.describe(1, "p", "tid")?.attached).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(terminalSessions.has(1, "p", "tid")).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("a genuine socket drop still detaches and arms the grace timer", async () => {
    const { handleTerminalConnection, terminalSessions } = await load();
    const cfg = makeTestConfig({ terminalDetachGraceMs: 1000 });
    vi.useFakeTimers();

    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "p", cfg, 1, undefined, "tid");
    ws.emit("close");
    expect(terminalSessions.describe(1, "p", "tid")?.state).toBe("detached");
    vi.advanceTimersByTime(1001);
    expect(terminalSessions.has(1, "p", "tid")).toBe(false);
  });
});
