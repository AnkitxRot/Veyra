import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";

/**
 * M88 — terminal reattach after browser reload.
 *
 * Verifies that the backend correctly handles the `resume=1` flag and
 * non-zero `lastSeq` sent by the M88 frontend after a reload. The server
 * must refuse to silently spawn a replacement PTY when the client expects
 * a reattach.
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
      const evts = listeners.get("close") ?? [];
      for (const fn of evts) fn();
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

describe("M88 — terminal reload persistence", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("node-pty");
    vi.doUnmock("../src/execution/sandbox.js");
    vi.doUnmock("../src/projects/service.js");
    vi.doUnmock("../src/projectsecrets/store.js");
    vi.resetModules();
  });

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
    vi.doMock("../src/projectsecrets/store.js", () => ({
      resolveSecretsForInjection: vi.fn(async () => ({})),
    }));
    const mod = await import("../src/ws/terminal.js");
    const reg = await import("../src/execution/terminalSessions.js");
    return { ...mod, ...reg, spawn };
  }

  it("resume=1 with no existing session sends 'ended' instead of spawning", async () => {
    const { handleTerminalConnection, shouldRefuseSilentSpawn, parseTerminalResumeFlag, terminalSessions } =
      await load();

    // Unit-test the helpers
    expect(shouldRefuseSilentSpawn(0, true)).toBe(true);
    expect(shouldRefuseSilentSpawn(0, false)).toBe(false);
    expect(shouldRefuseSilentSpawn(5, false)).toBe(true);
    expect(shouldRefuseSilentSpawn(5, true)).toBe(true);
    expect(parseTerminalResumeFlag("1")).toBe(true);
    expect(parseTerminalResumeFlag("true")).toBe(true);
    expect(parseTerminalResumeFlag("0")).toBe(false);
    expect(parseTerminalResumeFlag(undefined)).toBe(false);

    // Integration: resume=1 with no session → ended, no PTY spawned
    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "proj-1", makeTestConfig(), 1, undefined, "reloaded-id", 0, true);
    expect(ws.sent).toEqual([{ type: "ended", reason: "grace_expired" }]);
    expect(ws.closed).toBe(true);
    expect(terminalSessions.size()).toBe(0);
  });

  it("non-zero lastSeq with no existing session sends 'ended' instead of spawning", async () => {
    const { handleTerminalConnection, terminalSessions } = await load();
    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "proj-1", makeTestConfig(), 1, undefined, "old-id", 42, false);
    expect(ws.sent).toEqual([{ type: "ended", reason: "grace_expired" }]);
    expect(ws.closed).toBe(true);
    expect(terminalSessions.size()).toBe(0);
  });

  it("resume=1 with an existing session reattaches successfully", async () => {
    const { handleTerminalConnection, terminalSessions } = await load();
    const cfg = makeTestConfig();

    // Create a session first
    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "proj-1", cfg, 1, undefined, "persist-id", 0, false);
    expect(terminalSessions.has(1, "proj-1", "persist-id")).toBe(true);
    expect(ws1.closed).toBe(false);

    // Detach by closing the socket
    ws1.close();

    // Reconnect with resume=1 and lastSeq=5
    const ws2 = makeFakeWs();
    await handleTerminalConnection(ws2 as any, "proj-1", cfg, 1, undefined, "persist-id", 5, true);
    expect(ws2.closed).toBe(false);
    expect(ws2.sent).toEqual([]);
    expect(terminalSessions.has(1, "proj-1", "persist-id")).toBe(true);
  });

  it("resume=1 with a different user does NOT attach to the first user's session", async () => {
    const { handleTerminalConnection, terminalSessions } = await load();
    const cfg = makeTestConfig();

    // User 1 creates a session
    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "proj-1", cfg, 1, undefined, "shared-id", 0, false);
    expect(terminalSessions.has(1, "proj-1", "shared-id")).toBe(true);

    // User 2 tries to resume with the same terminalId — session keys include
    // userId, so terminalSessions.has(2, ...) returns false. With resume=1,
    // the server must refuse to silently spawn a fresh shell for user 2.
    const ws2 = makeFakeWs();
    await handleTerminalConnection(ws2 as any, "proj-1", cfg, 2, undefined, "shared-id", 0, true);
    expect(ws2.sent).toEqual([{ type: "ended", reason: "grace_expired" }]);
    expect(ws2.closed).toBe(true);
    // User 2 got no new session
    expect(terminalSessions.has(2, "proj-1", "shared-id")).toBe(false);
    // User 1's session is still there, untouched
    expect(terminalSessions.has(1, "proj-1", "shared-id")).toBe(true);
  });

  it("zero lastSeq without resume still spawns a fresh session when none exists", async () => {
    const { handleTerminalConnection, terminalSessions } = await load();
    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "proj-1", makeTestConfig(), 1, undefined, "new-id", 0, false);
    // Should have spawned a PTY (verified by no "ended" message)
    expect(ws.sent).toEqual([]);
    expect(terminalSessions.has(1, "proj-1", "new-id")).toBe(true);
  });

  it("an ended session cannot be reattached even with resume=1", async () => {
    const { handleTerminalConnection, terminalSessions } = await load();
    const cfg = makeTestConfig({ terminalDetachGraceMs: 200 });

    // Create a session
    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "proj-1", cfg, 1, undefined, "dead-id", 0, false);
    expect(terminalSessions.has(1, "proj-1", "dead-id")).toBe(true);

    // Close the socket — session enters detached state, grace=200ms
    ws1.emit("close");
    await new Promise((r) => setTimeout(r, 500)); // let grace expire + reap

    // resume=1 after end → session is gone, send "ended" reason
    const ws2 = makeFakeWs();
    await handleTerminalConnection(ws2 as any, "proj-1", cfg, 1, undefined, "dead-id", 0, true);
    expect(ws2.sent[0]).toEqual({ type: "ended", reason: "grace_expired" });
    expect(terminalSessions.has(1, "proj-1", "dead-id")).toBe(false);
  });
});
