import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";

/**
 * A minimal stand-in for the parts of `ws`'s WebSocket that
 * handleTerminalConnection actually touches: readyState/OPEN/CLOSED,
 * send, close and on().
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
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

describe("handleTerminalConnection disconnect-during-sandbox-startup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node-pty");
    vi.doUnmock("../src/execution/sandbox.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
  });

  it("does not spawn a pty when the client disconnects while ensureProjectSandbox is pending", async () => {
    // Regression guard: `ws.on('close', () => ptyProcess.kill())` is only
    // registered *after* pty.spawn(), which itself only runs after two awaits.
    // If the socket closes while those awaits are pending, the close event has
    // already been dispatched and this function's late listener never sees it —
    // so a real `docker exec -it <container> bash` would be spawned for a dead
    // connection and never killed. No Docker needed to prove this: mock the
    // sandbox + pty layers and assert spawn is never reached.
    const spawn = vi.fn((..._args: any[]) => {
      throw new Error("pty.spawn must not be called for a closed socket");
    });
    vi.doMock("node-pty", () => ({ spawn }));

    let releaseSandbox: (containerId: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      releaseSandbox = resolve;
    });
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxManager: {
        ensureProjectSandbox: vi.fn(() => pending),
      },
    }));
    vi.doMock("../src/projects/service.js", () => ({
      workspacePath: async () => "/tmp/does-not-matter",
    }));

    const { handleTerminalConnection } = await import("../src/ws/terminal.js");
    const cfg = makeTestConfig();
    const ws = makeFakeWs();

    const done = handleTerminalConnection(ws as any, "proj-1", cfg, 1);

    // Client goes away mid-startup. The real `ws` would dispatch 'close' now,
    // before handleTerminalConnection has registered any listener for it.
    ws.readyState = ws.CLOSED;
    ws.emit("close");
    expect(ws.listenerCount("close")).toBe(0);

    // Sandbox finally comes up — for a connection that no longer exists.
    releaseSandbox("container-abc");
    await done;

    expect(spawn).not.toHaveBeenCalled();
  });

  it("still spawns a pty when the socket is open after the sandbox is ready", async () => {
    const ptyProcess = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const spawn = vi.fn((..._args: any[]) => ptyProcess);
    vi.doMock("node-pty", () => ({ spawn }));
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxManager: {
        ensureProjectSandbox: vi.fn(async () => "container-abc"),
      },
    }));
    vi.doMock("../src/projects/service.js", () => ({
      workspacePath: async () => "/tmp/does-not-matter",
    }));

    const { handleTerminalConnection } = await import("../src/ws/terminal.js");
    const cfg = makeTestConfig();
    const ws = makeFakeWs();

    await handleTerminalConnection(ws as any, "proj-1", cfg, 1);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe("docker");
    // and the close handler that kills it is wired up
    ws.emit("close");
    expect(ptyProcess.kill).toHaveBeenCalled();
  });
});

describe("handleTerminalConnection keeps the sandbox idle timer alive", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node-pty");
    vi.doUnmock("../src/execution/sandbox.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
  });

  /**
   * Same harness as above, but the fake pty captures its onData callback so the
   * test can drive terminal output.
   */
  async function connect(projectId: string, userId = 1) {
    let emitData: (data: string) => void = () => {};
    const ptyProcess = {
      onData: vi.fn((fn: (data: string) => void) => {
        emitData = fn;
      }),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.doMock("node-pty", () => ({ spawn: vi.fn(() => ptyProcess) }));
    const touch = vi.fn();
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxManager: {
        ensureProjectSandbox: vi.fn(async () => "container-abc"),
        touch,
      },
    }));
    vi.doMock("../src/projects/service.js", () => ({
      workspacePath: async () => "/tmp/does-not-matter",
    }));

    const { handleTerminalConnection } = await import("../src/ws/terminal.js");
    const ws = makeFakeWs();
    await handleTerminalConnection(
      ws as any,
      projectId,
      makeTestConfig(),
      userId,
    );
    return { ws, touch, emitData: (data: string) => emitData(data) };
  }

  it("touches the sandbox on inbound client messages", async () => {
    // Regression guard: the sandbox reaper `docker rm -f`s any container whose
    // lastUsed is older than sandboxIdleTimeoutMs. ensureProjectSandbox only
    // refreshes it once, at connect time, so an interactive session longer than
    // the idle timeout would be killed mid-command unless terminal traffic
    // refreshes the timer too.
    const { ws, touch } = await connect("proj-touch");
    expect(touch).not.toHaveBeenCalled();

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "data", data: "ls\n" })),
    );
    expect(touch).toHaveBeenCalledWith("proj-touch");
    expect(touch).toHaveBeenCalledTimes(1);

    // Each further message counts — not a one-shot.
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "resize", cols: 100, rows: 40 })),
    );
    expect(touch).toHaveBeenCalledTimes(2);

    // Even malformed traffic proves the connection is alive and in use.
    ws.emit("message", Buffer.from("not json"));
    expect(touch).toHaveBeenCalledTimes(3);
  });

  it("touches the sandbox on pty output", async () => {
    // Output-only activity (a long build, a REPL printing results) must also
    // keep the container alive, even while the user types nothing.
    const { touch, emitData } = await connect("proj-out");
    expect(touch).not.toHaveBeenCalled();

    emitData("hello\r\n");
    expect(touch).toHaveBeenCalledWith("proj-out");
    expect(touch).toHaveBeenCalledTimes(1);

    emitData("world\r\n");
    expect(touch).toHaveBeenCalledTimes(2);
  });
});

describe("terminalGate — per-user concurrent terminal cap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node-pty");
    vi.doUnmock("../src/execution/sandbox.js");
    vi.doUnmock("../src/projects/service.js");
    vi.resetModules();
  });

  /** Mocks sandbox+pty (no Docker needed) and loads a fresh terminal module
   *  (and therefore a fresh, isolated terminalGate) per test. */
  async function setup() {
    const ensureProjectSandbox = vi.fn(async () => "container-abc");
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxManager: { ensureProjectSandbox, touch: vi.fn() },
    }));
    vi.doMock("../src/projects/service.js", () => ({
      workspacePath: async () => "/tmp/does-not-matter",
    }));
    const spawn = vi.fn(() => ({
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }));
    vi.doMock("node-pty", () => ({ spawn }));

    const { handleTerminalConnection, terminalGate } =
      await import("../src/ws/terminal.js");
    return {
      handleTerminalConnection,
      terminalGate,
      ensureProjectSandbox,
      spawn,
    };
  }

  it("rejects the connection past the per-user cap without spawning a pty or touching the sandbox", async () => {
    const { handleTerminalConnection, ensureProjectSandbox, spawn } =
      await setup();
    const cfg = makeTestConfig({ maxTerminalsPerUser: 2 });

    await handleTerminalConnection(makeFakeWs() as any, "proj-a", cfg, 1);
    await handleTerminalConnection(makeFakeWs() as any, "proj-b", cfg, 1);
    expect(spawn).toHaveBeenCalledTimes(2);

    const rejected = makeFakeWs();
    await handleTerminalConnection(rejected as any, "proj-c", cfg, 1);

    expect(rejected.closed).toBe(true);
    expect(
      rejected.sent.some((s) => s.includes("too many concurrent terminals")),
    ).toBe(true);
    // The rejection must happen before any sandbox/docker work is attempted.
    expect(ensureProjectSandbox).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("tracks different users' terminal counts separately", async () => {
    const { handleTerminalConnection, spawn } = await setup();
    const cfg = makeTestConfig({ maxTerminalsPerUser: 1 });

    await handleTerminalConnection(makeFakeWs() as any, "proj-a", cfg, 1);
    // A second user is unaffected by the first user's cap being full.
    await handleTerminalConnection(makeFakeWs() as any, "proj-b", cfg, 2);
    expect(spawn).toHaveBeenCalledTimes(2);

    const rejected = makeFakeWs();
    await handleTerminalConnection(rejected as any, "proj-c", cfg, 1);
    expect(rejected.closed).toBe(true);
  });

  it("releases the permit on close, admitting a new connection afterward", async () => {
    const { handleTerminalConnection, terminalGate } = await setup();
    const cfg = makeTestConfig({ maxTerminalsPerUser: 1 });

    const first = makeFakeWs();
    await handleTerminalConnection(first as any, "proj-a", cfg, 1);
    expect(terminalGate.activeCount(1)).toBe(1);

    first.emit("close");
    expect(terminalGate.activeCount(1)).toBe(0);

    const second = makeFakeWs();
    await handleTerminalConnection(second as any, "proj-b", cfg, 1);
    expect(second.closed).toBe(false);
    expect(terminalGate.activeCount(1)).toBe(1);
  });

  it("releases the permit on an abrupt socket error even if close never fires", async () => {
    const { handleTerminalConnection, terminalGate } = await setup();
    const cfg = makeTestConfig({ maxTerminalsPerUser: 1 });

    const first = makeFakeWs();
    await handleTerminalConnection(first as any, "proj-a", cfg, 1);
    expect(terminalGate.activeCount(1)).toBe(1);

    first.emit("error", new Error("ECONNRESET"));
    expect(terminalGate.activeCount(1)).toBe(0);
  });

  it("releases the permit when sandbox creation fails, without ever spawning a pty", async () => {
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxManager: {
        ensureProjectSandbox: vi.fn(async () => {
          throw new Error("sandbox boom");
        }),
        touch: vi.fn(),
      },
    }));
    vi.doMock("../src/projects/service.js", () => ({
      workspacePath: async () => "/tmp/does-not-matter",
    }));
    const spawn = vi.fn();
    vi.doMock("node-pty", () => ({ spawn }));

    const { handleTerminalConnection, terminalGate } =
      await import("../src/ws/terminal.js");
    const cfg = makeTestConfig({ maxTerminalsPerUser: 1 });

    const ws = makeFakeWs();
    await handleTerminalConnection(ws as any, "proj-a", cfg, 1);

    expect(spawn).not.toHaveBeenCalled();
    expect(ws.closed).toBe(true);
    // The per-user slot acquired before the sandbox attempt must not have
    // been left consumed by a failed connection.
    expect(terminalGate.activeCount(1)).toBe(0);
  });
});
