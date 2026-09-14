import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";

/**
 * M79 — terminal session isolation & the reattach trust boundary.
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

describe("M79 — terminal reattach isolation", () => {
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
    const mod = await import("../src/ws/terminal.js");
    const reg = await import("../src/execution/terminalSessions.js");
    return { ...mod, ...reg, spawn };
  }

  it("B20/B27: user B connecting with user A's terminalId gets a fresh session, not A's", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig();

    const wsA = makeFakeWs();
    await handleTerminalConnection(
      wsA as any,
      "proj-1",
      cfg,
      1,
      undefined,
      "secret-terminal-id",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(terminalSessions.has(1, "proj-1", "secret-terminal-id")).toBe(true);

    // Attacker B knows A's terminalId + projectId (say from a shared link).
    const wsB = makeFakeWs();
    await handleTerminalConnection(
      wsB as any,
      "proj-1",
      cfg,
      2,
      undefined,
      "secret-terminal-id",
    );

    // B did NOT attach to A's session — a brand-new PTY was spawned for B,
    // keyed under B's own userId.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(terminalSessions.has(2, "proj-1", "secret-terminal-id")).toBe(true);
    // A's session is untouched and still A's.
    expect(terminalSessions.describe(1, "proj-1", "secret-terminal-id")?.state)
      .toBe("attached");
    expect(wsB.sent.some((m) => m.type === "ended")).toBe(false);
  });

  it("B21: same terminalId across projects never crosses", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig();
    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "proj-A", cfg, 1, undefined, "tid");
    const ws2 = makeFakeWs();
    await handleTerminalConnection(ws2 as any, "proj-B", cfg, 1, undefined, "tid");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(terminalSessions.has(1, "proj-A", "tid")).toBe(true);
    expect(terminalSessions.has(1, "proj-B", "tid")).toBe(true);
  });

  it("the wire never carries the container id or a pty pid", async () => {
    const { handleTerminalConnection } = await load();
    const cfg = makeTestConfig();
    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "proj-1", cfg, 1, undefined, "t");
    ws.emit("close");
    const blob = JSON.stringify(ws.sent);
    expect(blob).not.toContain("ide-sandbox");
    expect(blob).not.toContain("containerId");
    expect(blob).not.toContain("pid");
  });

  it("a reconnect after grace expiry gets `ended` (not a silent fresh shell) when the client was mid-stream", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig({ terminalDetachGraceMs: 1000 });
    vi.useFakeTimers();

    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "p", cfg, 1, undefined, "tid");
    ws1.emit("close");
    vi.advanceTimersByTime(1001); // grace expiry → session reaped
    expect(terminalSessions.has(1, "p", "tid")).toBe(false);

    // The client was streaming this session, so it reconnects with a non-zero
    // lastSeq. The server has no such session — it must report `ended` and
    // close, NOT spawn a fresh shell under the same UI.
    const ws2 = makeFakeWs();
    await handleTerminalConnection(ws2 as any, "p", cfg, 1, undefined, "tid", 42);
    expect(spawn).toHaveBeenCalledTimes(1); // no new spawn
    expect(ws2.closed).toBe(true);
    const ended = ws2.sent.find((m: any) => m.type === "ended");
    expect(ended?.reason).toBe("grace_expired");

    vi.useRealTimers();
  });

  it("a genuine first-time connect (lastSeq 0) for an unknown terminalId still spawns fresh", async () => {
    const { handleTerminalConnection, spawn } = await load();
    const cfg = makeTestConfig();
    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "p", cfg, 1, undefined, "brand-new");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ws.sent.some((m: any) => m.type === "ended")).toBe(false);
  });

  it("M86: shouldRefuseSilentSpawn is lastSeq>0 or resume", async () => {
    const { shouldRefuseSilentSpawn } = await load();
    expect(shouldRefuseSilentSpawn(0, false)).toBe(false);
    expect(shouldRefuseSilentSpawn(1, false)).toBe(true);
    expect(shouldRefuseSilentSpawn(0, true)).toBe(true);
    expect(shouldRefuseSilentSpawn(NaN, false)).toBe(false);
  });

  it("M86: lastSeq 0 + resume=1 after grace expiry ends instead of spawning", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig({ terminalDetachGraceMs: 1000 });
    vi.useFakeTimers();

    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "p", cfg, 1, undefined, "tid");
    ws1.emit("close");
    vi.advanceTimersByTime(1001);
    expect(terminalSessions.has(1, "p", "tid")).toBe(false);

    const ws2 = makeFakeWs();
    await handleTerminalConnection(
      ws2 as any,
      "p",
      cfg,
      1,
      undefined,
      "tid",
      0,
      true,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ws2.closed).toBe(true);
    const ended = ws2.sent.find((m: any) => m.type === "ended");
    expect(ended?.reason).toBe("grace_expired");

    vi.useRealTimers();
  });

  it("M86: lastSeq 0 + resume=1 reattaches a live detached session (no second spawn)", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig();
    const ws1 = makeFakeWs();
    await handleTerminalConnection(ws1 as any, "p", cfg, 1, undefined, "tid");
    ws1.emit("close");
    expect(terminalSessions.describe(1, "p", "tid")?.state).toBe("detached");

    const ws2 = makeFakeWs();
    await handleTerminalConnection(
      ws2 as any,
      "p",
      cfg,
      1,
      undefined,
      "tid",
      0,
      true,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(terminalSessions.describe(1, "p", "tid")?.state).toBe("attached");
    expect(ws2.sent.some((m: any) => m.type === "ended")).toBe(false);
  });

  it("M86: user B + resume=1 with A's terminalId cannot attach to A's PTY", async () => {
    const { handleTerminalConnection, terminalSessions, spawn } = await load();
    const cfg = makeTestConfig();
    const wsA = makeFakeWs();
    await handleTerminalConnection(
      wsA as any,
      "proj-1",
      cfg,
      1,
      undefined,
      "secret-terminal-id",
    );

    const wsB = makeFakeWs();
    await handleTerminalConnection(
      wsB as any,
      "proj-1",
      cfg,
      2,
      undefined,
      "secret-terminal-id",
      0,
      true,
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(terminalSessions.has(2, "proj-1", "secret-terminal-id")).toBe(false);
    expect(terminalSessions.describe(1, "proj-1", "secret-terminal-id")?.state)
      .toBe("attached");
    expect(wsB.sent.some((m: any) => m.type === "ended")).toBe(true);
    expect(wsB.closed).toBe(true);
  });

  it("B26: the secrets cleanup runs exactly once, on the final reap", async () => {
    const cleanup = vi.fn(async () => {});
    vi.doMock("node-pty", () => ({
      spawn: vi.fn(() => ({
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      })),
    }));
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
      resolveSecretsForInjection: () => ({ API_KEY: "shhh" }),
    }));
    vi.doMock("../src/projectsecrets/inject.js", () => ({
      renderSecretsEnvFile: () => "API_KEY=shhh\n",
      writeContainerSecretsFile: async () => ({
        path: "/run/secrets/x",
        cleanup,
      }),
    }));

    const { handleTerminalConnection } = await import("../src/ws/terminal.js");
    const { terminalSessions } = await import(
      "../src/execution/terminalSessions.js"
    );
    const cfg = makeTestConfig({ terminalDetachGraceMs: 500 });
    vi.useFakeTimers();

    const ws = makeFakeWs();
    await handleTerminalConnection(
      ws as any,
      "p",
      cfg,
      1,
      {} as any,
      "tid",
    );
    ws.emit("close");
    expect(cleanup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(501);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(terminalSessions.has(1, "p", "tid")).toBe(false);
    vi.useRealTimers();
  });
});
