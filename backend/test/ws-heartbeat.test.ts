/**
 * M3 regression suite (BUG-4): WebSocket payload limits + heartbeat reaper.
 *
 * Layers:
 *  - Fake-timer tests drive the real 30s interval deterministically over REAL
 *     sockets (connected before fake timers are enabled — network I/O is
 *     libuv-driven, not timer-driven, so handshakes/data keep flowing).
 *  - Real-timer integration tests cover the frame-limit close code (1009),
 *     the env-var cadence plumbing, and shutdown teardown ordering.
 *
 * Dead-client simulation without touching internals: pausing the client's
 * underlying TCP socket stops it from RECEIVING server pings, so its
 * auto-pong never fires and the server observes a missed liveness window.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import type { WebSocketServer } from "ws";

import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import {
  setupWebSocketServer,
  getHeartbeatController,
  DEFAULT_WS_MAX_PAYLOAD,
  DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
} from "../src/ws/index.js";
import { activeConnectionCountForUser } from "../src/ws/connectionRegistry.js";
import { performGracefulShutdown } from "../src/index.js";
import { collaborationManager } from "../src/collab/manager.js";

interface Booted {
  cfg: AppConfig;
  db: Db;
  server: Server;
  wss: WebSocketServer;
  base: string;
}

async function bootServer(): Promise<Booted> {
  const cfg = makeTestConfig({ shutdownGraceMs: 2500 });
  const db = openDb(":memory:");
  const app = createApp(cfg, db);
  const server = createServer(app);
  const wss = setupWebSocketServer(server, db, cfg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { cfg, db, server, wss, base: `http://127.0.0.1:${port}` };
}

type TestRequest = (
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown },
) => Promise<{ status: number; data: any }>;

function makeRequest(base: string): TestRequest {
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data: any = {};
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  };
}

async function registerAndCreateProject(booted: Booted) {
  const request = makeRequest(booted.base);
  const username = `m3_${Math.random().toString(36).slice(2, 10)}`;
  const reg = await request("POST", "/api/auth/register", {
    body: { username, password: "secret123" },
  });
  expect(reg.status).toBe(201);
  const proj = await request("POST", "/api/projects", {
    token: reg.data.token,
    body: { name: "heartbeat" },
  });
  expect(proj.status).toBe(201);
  return {
    token: reg.data.token as string,
    userId: reg.data.user.id as number,
    projectId: proj.data.project.id as string,
  };
}

/** Connects to /ws/collab; pre-arms listeners to dodge the SyncStep1 race. */
async function connectCollab(
  base: string,
  projectId: string,
  token: string,
): Promise<WebSocket> {
  const wsUrl = `${base.replace(/^http/, "ws")}/ws/collab?projectId=${encodeURIComponent(projectId)}`;
  const ws = new WebSocket(wsUrl, {
    headers: { Cookie: `session_token=${token}` },
  });
  const step1 = new Promise<void>((resolve) =>
    ws.once("message", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("open timeout")), 4000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  await step1;
  return ws;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits until the predicate holds, polling on real time. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

describe("M3 websocket heartbeat reaper", () => {
  let envBackup: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    if (envBackup === undefined) delete process.env.WS_HEARTBEAT_INTERVAL_MS;
    else process.env.WS_HEARTBEAT_INTERVAL_MS = envBackup;
    envBackup = undefined;
  });

  it("exports the specified defaults", () => {
    expect(DEFAULT_WS_MAX_PAYLOAD).toBe(1024 * 1024);
    expect(DEFAULT_WS_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it("pings live sockets at the configured cadence and keeps responsive clients connected", async () => {
    // Fake timers must be active before the server boots: setupWebSocketServer
    // arms the heartbeat's setInterval synchronously inside bootServer(), so
    // enabling fake timers afterward would leave that interval running on the
    // real clock, immune to vi.advanceTimersByTimeAsync below. Real sockets
    // still work fine under fake timers — libuv I/O isn't timer-driven.
    vi.useFakeTimers();
    const booted = await bootServer();
    try {
      const { token, userId, projectId } =
        await registerAndCreateProject(booted);
      const ws = await connectCollab(booted.base, projectId, token);

      let pingsReceived = 0;
      ws.on("ping", () => {
        pingsReceived += 1;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_WS_HEARTBEAT_INTERVAL_MS);
      expect(pingsReceived).toBeGreaterThanOrEqual(1);

      // Client auto-pongs (spec-compliant ws client), so liveness refreshes:
      // several more sweeps must NOT terminate an honest peer.
      await vi.advanceTimersByTimeAsync(DEFAULT_WS_HEARTBEAT_INTERVAL_MS * 4);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      vi.useRealTimers();
      // Sweep bookkeeping ran against real sockets; registry still holds it.
      expect(activeConnectionCountForUser(userId)).toBeGreaterThanOrEqual(1);

      ws.close();
      await waitFor(() => activeConnectionCountForUser(userId) === 0);
      expect(activeConnectionCountForUser(userId)).toBe(0);
    } finally {
      booted.server.closeIdleConnections?.();
      booted.server.close();
      getHeartbeatController(booted.wss)?.stop();
    }
  });

  it("terminates unresponsive sockets after two sweeps and unregisters them", async () => {
    // See the previous test: fake timers must be active before the server
    // boots so the heartbeat's setInterval is captured as a virtual timer.
    vi.useFakeTimers();
    const booted = await bootServer();
    const touched: string[] = [];
    try {
      const { token, userId, projectId } =
        await registerAndCreateProject(booted);
      touched.push(projectId);
      const ws = await connectCollab(booted.base, projectId, token);

      const closedCode = new Promise<number | undefined>((resolve) => {
        ws.once("close", (code) => resolve(code));
      });

      // Pause the client's TCP stream: pings stop arriving, so its
      // auto-pong never fires — the server must classify it dead.
      (ws as any)._socket.pause();

      // Sweep 1: alive -> pinged, marked unverified.
      await vi.advanceTimersByTimeAsync(DEFAULT_WS_HEARTBEAT_INTERVAL_MS);
      expect(ws.readyState).not.toBe(WebSocket.CLOSED);

      // Sweep 2: still no pong -> terminate.
      await vi.advanceTimersByTimeAsync(DEFAULT_WS_HEARTBEAT_INTERVAL_MS);

      // The server already called terminate() synchronously inside that sweep.
      // Resume the client's paused stream so it can process the resulting
      // FIN/RST and surface 'close' — pause() was only ever meant to stop
      // outbound pongs, not to block the client from observing its own end.
      (ws as any)._socket.resume();

      vi.useRealTimers();
      const code = await Promise.race([
        closedCode,
        wait(2000).then(() => undefined),
      ]);
      expect(code).toBeDefined(); // hard termination surfaced as a close

      // Registry cleanup flows through the socket's own close/error handlers
      // once terminate() lands.
      const gone = await waitFor(
        () => activeConnectionCountForUser(userId) === 0,
        3000,
      );
      expect(gone).toBe(true);
      ws.terminate();
    } finally {
      for (const pid of touched) collaborationManagerDispose(pid);
      booted.server.closeIdleConnections?.();
      booted.server.close();
      getHeartbeatController(booted.wss)?.stop();
    }
  });

  it("sweep ignores sockets that carry no heartbeat metadata (raw/proxy pipes)", async () => {
    const booted = await bootServer();
    try {
      const foreign = {
        readyState: 1,
        ping: vi.fn(),
        terminate: vi.fn(),
      };
      (booted.wss.clients as unknown as Set<unknown>).add(foreign);

      expect(() => getHeartbeatController(booted.wss)!.sweep()).not.toThrow();
      expect(foreign.ping).not.toHaveBeenCalled();
      expect(foreign.terminate).not.toHaveBeenCalled();

      (booted.wss.clients as unknown as Set<unknown>).delete(foreign);
    } finally {
      booted.server.closeIdleConnections?.();
      booted.server.close();
      getHeartbeatController(booted.wss)?.stop();
    }
  });

  it("rejects frames larger than maxPayload with close code 1009 without crashing the process", async () => {
    const booted = await bootServer();
    try {
      const { token, projectId } = await registerAndCreateProject(booted);
      const ws = await connectCollab(booted.base, projectId, token);

      const closed = new Promise<number | undefined>((resolve) => {
        ws.once("close", (code) => resolve(code));
      });

      const oversized = Buffer.alloc(DEFAULT_WS_MAX_PAYLOAD + 1, 0x41);
      ws.send(oversized);

      const code = await Promise.race([
        closed.then((c) => c ?? -1),
        wait(4000).then(() => -2),
      ]);
      expect(code).toBe(1009);

      // The process must be none-the-worse: health stays green.
      const request = makeRequest(booted.base);
      const health = await request("GET", "/api/health");
      expect(health.status).toBe(200);
    } finally {
      booted.server.closeIdleConnections?.();
      booted.server.close();
      getHeartbeatController(booted.wss)?.stop();
    }
  });

  it("honors WS_HEARTBEAT_INTERVAL_MS for the production interval", async () => {
    envBackup = process.env.WS_HEARTBEAT_INTERVAL_MS;
    process.env.WS_HEARTBEAT_INTERVAL_MS = "50"; // read at controller start()
    const booted = await bootServer();
    try {
      const { token, projectId } = await registerAndCreateProject(booted);
      const ws = await connectCollab(booted.base, projectId, token);

      let pingsReceived = 0;
      ws.on("ping", () => {
        pingsReceived += 1;
      });
      await wait(200); // ~4 intervals at 50ms

      expect(pingsReceived).toBeGreaterThanOrEqual(1);
      ws.close();
    } finally {
      booted.server.closeIdleConnections?.();
      booted.server.close();
      getHeartbeatController(booted.wss)?.stop();
    }
  });

  it("performGracefulShutdown stops the heartbeat and tears sockets down cleanly", async () => {
    const booted = await bootServer();
    const touched: string[] = [];
    try {
      const createdA = await registerAndCreateProject(booted);
      const createdB = await registerAndCreateProject(booted);
      touched.push(createdA.projectId, createdB.projectId);

      // Two independent servers must hold independent controllers.
      const otherBoot = await bootServer();
      expect(getHeartbeatController(otherBoot.wss)).toBeDefined();
      expect(getHeartbeatController(otherBoot.wss)).not.toBe(
        getHeartbeatController(booted.wss),
      );

      const ws = await connectCollab(
        booted.base,
        createdA.projectId,
        createdA.token,
      );
      const closedCode = new Promise<number | undefined>((resolve) => {
        ws.once("close", (code) => resolve(code));
      });

      const exitSpy = vi.fn();
      await performGracefulShutdown(
        {
          server: booted.server,
          wss: booted.wss,
          db: booted.db,
          config: booted.cfg,
        },
        { signal: "SIGTERM", exit: exitSpy },
      );

      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);

      const code = await Promise.race([
        closedCode,
        wait(2000).then(() => undefined),
      ]);
      expect(code).toBe(1001); // graceful close from the teardown loop

      // Controller survives as an object but its interval is stopped:
      // manual sweeps stay usable, repeated stops are idempotent.
      const hb = getHeartbeatController(booted.wss);
      expect(hb).toBeDefined();
      expect(() => hb!.sweep()).not.toThrow();
      expect(() => hb!.stop()).not.toThrow();
      expect(() => hb!.start()).not.toThrow();
      hb!.stop();
      ws.terminate();
    } finally {
      for (const pid of touched) collaborationManagerDispose(pid);
      booted.server.closeIdleConnections?.();
      booted.server.close();
      getHeartbeatController(booted.wss)?.stop();
    }
  });
});

// Disposes any room this test touched so idle-disposal timers don't leak
// past the suite (mirrors the M2 cleanup discipline).
function collaborationManagerDispose(projectId: string): void {
  try {
    collaborationManager.getRoom(projectId)?.dispose();
  } catch {}
}
