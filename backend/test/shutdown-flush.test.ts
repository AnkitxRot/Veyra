/**
 * M2 regression suite (BUG-2: data loss on process termination).
 *
 * Covers two layers:
 *  1. Integration — a REAL server (HTTP + WS upgrade handler) with a REAL
 *     /ws/collab client pushing a genuine y-sync UPDATE frame; then the
 *     extracted performGracefulShutdown() runs. Assertions prove debounced
 *     room content reached disk BEFORE the database closed and that the
 *     process signalled exit(0).
 *  2. Unit — flushAllRooms() hardening: failure isolation between rooms
 *     (Promise.allSettled semantics) and overlapping-call dedupe.
 *
 * The poisoned-room technique (instance-level method override) simulates
 * failing/hanging disks without mocking node:fs globally.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import type { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { performGracefulShutdown } from "../src/index.js";
import { collaborationManager } from "../src/collab/manager.js";
import { createProject } from "../src/projects/service.js";

const MESSAGE_SYNC = 0;

/** Structural view used for instance-level poisoning of room internals. */
type CollaborationRoomShape = {
  flushToDisk: () => Promise<void>;
};

/** Mirrors the production client envelope: varUint(MESSAGE_SYNC) + writeUpdate. */
function buildSyncUpdateFrame(clientDoc: Y.Doc, mutate: () => void): Uint8Array {
  let update: Uint8Array | null = null;
  const capture = (u: Uint8Array) => {
    update = u;
  };
  clientDoc.on("update", capture);
  try {
    mutate();
  } finally {
    clientDoc.off("update", capture);
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update!);
  return encoding.toUint8Array(encoder);
}

interface Booted {
  cfg: AppConfig;
  db: Db;
  server: Server;
  wss: WebSocketServer;
  base: string;
}

async function bootServer(
  overrides: Partial<{ shutdownGraceMs: number }> = {},
): Promise<Booted> {
  const cfg = makeTestConfig({
    // Keep the force-exit window comfortably above the flush budget used in
    // the hanging-flush test while staying fast for CI.
    shutdownGraceMs: 2500,
    ...overrides,
  });
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

/** Opens an authenticated /ws/collab socket and waits for the server's SyncStep1. */
async function connectCollab(
  base: string,
  projectId: string,
  token: string,
): Promise<WebSocket> {
  const wsUrl = `${base.replace(/^http/, "ws")}/ws/collab?projectId=${encodeURIComponent(projectId)}`;
  const ws = new WebSocket(wsUrl, {
    headers: { Cookie: `session_token=${token}` },
  });

  // The server sends SyncStep1 immediately after the upgrade completes —
  // potentially in the same tick the client emits 'open'. Attach listeners
  // BEFORE awaiting anything, or that first frame is lost forever.
  const step1 = new Promise<void>((resolve) => ws.once("message", () => resolve()));
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("collab WS open timeout")),
      4000,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  await opened;
  await Promise.race([
    step1,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("collab SyncStep1 timeout")), 4000),
    ),
  ]);
  return ws;
}

/** Pushes a real remote edit into the room through the actual protocol path. */
function sendRemoteEdit(ws: WebSocket, filePath: string, text: string): void {
  const clientDoc = new Y.Doc();
  const frame = buildSyncUpdateFrame(clientDoc, () => {
    clientDoc.getText(filePath).insert(0, text);
  });
  ws.send(frame);
}

async function registerAndCreateProject(booted: Booted, name: string) {
  const request = makeRequest(booted.base);
  const reg = await request("POST", "/api/auth/register", {
    body: { username: `m2_${Math.random().toString(36).slice(2, 10)}`, password: "secret123" },
  });
  expect(reg.status).toBe(201);
  const proj = await request("POST", "/api/projects", {
    token: reg.data.token,
    body: { name },
  });
  expect(proj.status).toBe(201);
  return { token: reg.data.token as string, projectId: proj.data.project.id as string };
}

describe("M2 graceful shutdown persists collaboration rooms (BUG-2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes a dirty collaborative room to disk before closing the database and exiting 0", async () => {
    const booted = await bootServer();
    const touchedProjectIds: string[] = [];
    let exitSpy = vi.fn();
    try {
      const { token, projectId } = await registerAndCreateProject(booted, "flush-e2e");
      touchedProjectIds.push(projectId);

      const ws = await connectCollab(booted.base, projectId, token);
      const expectedText = 'print("M2 survived the shutdown")\n';
      sendRemoteEdit(ws, "m2-shutdown.txt", expectedText);

      // Give the server event loop a beat to apply the update and mark dirty.
      await new Promise((r) => setTimeout(r, 200));
      ws.close();

      exitSpy = vi.fn();
      await performGracefulShutdown(
        { server: booted.server, wss: booted.wss, db: booted.db, config: booted.cfg },
        { signal: "SIGTERM", exit: exitSpy },
      );

      // The room's unflushed edit must now be on disk.
      const persisted = await fs.readFile(
        join(booted.cfg.workspacesDir, projectId, "m2-shutdown.txt"),
        "utf8",
      );
      expect(persisted).toBe(expectedText);

      // Exit contract.
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);

      // Ordering proof: the database was closed AFTER the flush (a prepared
      // statement against a closed DatabaseSync throws).
      expect(() => booted.db.prepare("SELECT 1").get()).toThrow();
    } finally {
      for (const pid of touchedProjectIds) {
        collaborationManager.getRoom(pid)?.dispose();
      }
      booted.server.closeIdleConnections?.();
      booted.server.close();
    }
  });

  it("isolates a failing room so other rooms still persist on shutdown", async () => {
    const booted = await bootServer();
    const touchedProjectIds: string[] = [];
    try {
      const p1 = await registerAndCreateProject(booted, "poison");
      const p2 = await registerAndCreateProject(booted, "healthy");
      touchedProjectIds.push(p1.projectId, p2.projectId);

      const ws1 = await connectCollab(booted.base, p1.projectId, p1.token);
      const ws2 = await connectCollab(booted.base, p2.projectId, p2.token);
      sendRemoteEdit(ws1, "doomed.txt", "this room fails to flush\n");
      sendRemoteEdit(ws2, "survivor.txt", "this room must survive\n");
      await new Promise((r) => setTimeout(r, 200));

      // Poison room 1 at the room level; flushAllRooms() must contain the
      // failure and still flush room 2 (allSettled semantics).
      const poisonedRoom = collaborationManager.getRoom(p1.projectId);
      expect(poisonedRoom).toBeDefined();
      (poisonedRoom as unknown as CollaborationRoomShape).flushToDisk =
        async () => {
          throw new Error("poisoned flush");
        };
      ws1.close();
      ws2.close();

      const exitSpy = vi.fn();
      await performGracefulShutdown(
        { server: booted.server, wss: booted.wss, db: booted.db, config: booted.cfg },
        { signal: "SIGINT", exit: exitSpy },
      );

      const survivor = await fs.readFile(
        join(booted.cfg.workspacesDir, p2.projectId, "survivor.txt"),
        "utf8",
      );
      expect(survivor).toBe("this room must survive\n");
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(() => booted.db.prepare("SELECT 1").get()).toThrow();
    } finally {
      for (const pid of touchedProjectIds) {
        collaborationManager.getRoom(pid)?.dispose();
      }
      booted.server.closeIdleConnections?.();
      booted.server.close();
    }
  });

  it("bounds a hanging room flush with the timeout guard and still closes the database", async () => {
    const booted = await bootServer({ shutdownGraceMs: 2500 });
    const touchedProjectIds: string[] = [];
    try {
      const slow = await registerAndCreateProject(booted, "hung-room");
      const fast = await registerAndCreateProject(booted, "fast-room");
      touchedProjectIds.push(slow.projectId, fast.projectId);

      const wsSlow = await connectCollab(booted.base, slow.projectId, slow.token);
      const wsFast = await connectCollab(booted.base, fast.projectId, fast.token);
      sendRemoteEdit(wsSlow, "hangs.txt", "never lands\n");
      sendRemoteEdit(wsFast, "lands.txt", "lands despite the hung sibling\n");
      await new Promise((r) => setTimeout(r, 200));

      const hungRoom = collaborationManager.getRoom(slow.projectId);
      expect(hungRoom).toBeDefined();
      (hungRoom as unknown as CollaborationRoomShape).flushToDisk = () =>
        new Promise<void>(() => {
          /* never settles */
        });
      wsSlow.close();
      wsFast.close();

      const exitSpy = vi.fn();
      const startedAt = Date.now();
      await performGracefulShutdown(
        { server: booted.server, wss: booted.wss, db: booted.db, config: booted.cfg },
        { signal: "SIGTERM", exit: exitSpy },
      );
      const elapsed = Date.now() - startedAt;

      // Flush budget = min(5000, grace-1000) = 1500ms; allow generous slack
      // for CI jitter while proving we did NOT wait for the grace period.
      expect(elapsed).toBeLessThan(4000);

      // The healthy room persisted inside the budget window.
      const landed = await fs.readFile(
        join(booted.cfg.workspacesDir, fast.projectId, "lands.txt"),
        "utf8",
      );
      expect(landed).toBe("lands despite the hung sibling\n");

      // Shutdown completed: database closed, exit signalled — even though one
      // room's flush is still wedged forever.
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(() => booted.db.prepare("SELECT 1").get()).toThrow();
    } finally {
      for (const pid of touchedProjectIds) {
        collaborationManager.getRoom(pid)?.dispose();
      }
      booted.server.closeIdleConnections?.();
      booted.server.close();
    }
  });

  it("shutdown completes even with zero active rooms", async () => {
    const booted = await bootServer();
    const touchedProjectIds: string[] = [];
    try {
      const created = await registerAndCreateProject(booted, "no-rooms");
      touchedProjectIds.push(created.projectId);
      const exitSpy = vi.fn();
      await performGracefulShutdown(
        { server: booted.server, wss: booted.wss, db: booted.db, config: booted.cfg },
        { signal: "SIGTERM", exit: exitSpy },
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(() => booted.db.prepare("SELECT 1").get()).toThrow();
    } finally {
      for (const pid of touchedProjectIds) {
        collaborationManager.getRoom(pid)?.dispose();
      }
      booted.server.closeIdleConnections?.();
      booted.server.close();
    }
  });
});

describe("M2 flushAllRooms() hardening (unit)", () => {
  /** :memory: DB with a real user row so projects satisfy their FK. */
  function makeUnitEnv(): { cfg: AppConfig; db: Db; ownerId: number } {
    const cfg = makeTestConfig();
    const db = openDb(":memory:");
    // Rooms capture the MANAGER's cfg/db at getOrCreateRoom() time, so every
    // unit env must re-init the singleton before creating rooms.
    collaborationManager.init(cfg, db);
    const info = db
      .prepare("INSERT INTO users (username, password_hash) VALUES ('m2unit', 'x')")
      .run();
    return { cfg, db, ownerId: Number(info.lastInsertRowid) };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is failure-isolated across rooms: one rejected flush does not abort siblings", async () => {
    const pA = randomUUID();
    const pB = randomUUID();
    // Rooms need only projectIds; both flushes are overridden below.
    const roomA = collaborationManager.getOrCreateRoom(pA);
    const roomB = collaborationManager.getOrCreateRoom(pB);
    (roomA as unknown as CollaborationRoomShape).flushToDisk = async () => {
      throw new Error("boom");
    };

    let roomBTouched = false;
    (roomB as unknown as CollaborationRoomShape).flushToDisk = async () => {
      roomBTouched = true;
    };

    // Must RESOLVE (not reject) despite roomA's poisoned flush.
    await expect(collaborationManager.flushAllRooms()).resolves.toBeUndefined();
    expect(roomBTouched).toBe(true);

    roomA.dispose();
    roomB.dispose();
  });

  it("a hung room cannot wedge the manager: the pass completes at the per-room bound and later passes run", async () => {
    expect.assertions(4);
    const hungId = randomUUID();
    const healthyId = randomUUID();
    const hungRoom = collaborationManager.getOrCreateRoom(hungId);
    const healthyRoom = collaborationManager.getOrCreateRoom(healthyId);

    (hungRoom as unknown as CollaborationRoomShape).flushToDisk = () =>
      new Promise<void>(() => {
        /* never settles */
      });
    let healthyTouched = false;
    (healthyRoom as unknown as CollaborationRoomShape).flushToDisk =
      async () => {
        healthyTouched = true;
      };

    const startedAt = Date.now();
    // Tiny per-room bound keeps the test fast while proving the mechanism.
    await collaborationManager.flushAllRooms({ perRoomTimeoutMs: 250 });
    const elapsed = Date.now() - startedAt;

    expect(healthyTouched).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(5000);

    // The pass SETTLED despite the eternal hang — a follow-up pass must
    // therefore start and complete immediately rather than inheriting a
    // permanently-pending promise.
    let secondPassRan = false;
    (hungRoom as unknown as CollaborationRoomShape).flushToDisk =
      async () => {};
    await collaborationManager.flushAllRooms({ perRoomTimeoutMs: 1000 });
    secondPassRan = true;
    expect(secondPassRan).toBe(true);

    hungRoom.dispose();
    healthyRoom.dispose();
  });

  it("persists real dirty content when called standalone (no shutdown)", async () => {
    const { cfg, db, ownerId } = makeUnitEnv();
    const project = await createProject(cfg, db, ownerId, {
      name: "standalone",
    });
    const room = collaborationManager.getOrCreateRoom(project.id);
    const text = "dirty before any client ever connected\n";
    room.doc.transact(() => {
      room.doc.getText("standalone-m2.txt").insert(0, text);
    }, "test-edit");

    await collaborationManager.flushAllRooms();

    const persisted = await fs.readFile(
      join(cfg.workspacesDir, project.id, "standalone-m2.txt"),
      "utf8",
    );
    expect(persisted).toBe(text);

    room.dispose();
  });
});
