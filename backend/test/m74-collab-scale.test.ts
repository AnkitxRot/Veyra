import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationRoom, collaborationManager } from "../src/collab/manager.js";
import { createProject } from "../src/projects/service.js";
import { isDockerRunning } from "../src/tools.js";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import { SandboxManager } from "../src/execution/sandbox.js";

const MESSAGE_AWARENESS = 1;
const execFileAsync = promisify(execFile);

function makeMockWs() {
  return { readyState: 1, send: () => {}, close: () => {} } as any;
}

/** A real MESSAGE_AWARENESS frame, exactly as a browser client sends it. */
function buildAwarenessFrame(
  ca: awarenessProtocol.Awareness,
  user: Record<string, unknown>,
) {
  ca.setLocalStateField("user", user);
  const update = awarenessProtocol.encodeAwarenessUpdate(ca, [ca.clientID]);
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", name]);
    return true;
  } catch {
    return false;
  }
}

const N = 12; // clears the 10+ bar with margin

interface HeadlessClient {
  ws: any;
  clientId: number;
  userId: number;
  awareness: awarenessProtocol.Awareness;
}

/**
 * Spawns `count` headless clients into `room`, each on its own real Yjs
 * runtime, each publishing one distinct awareness `user` state through the
 * real `handleMessage` -> sanitize -> applyAwarenessUpdate path.
 */
async function spawnClients(
  room: CollaborationRoom,
  count: number,
): Promise<HeadlessClient[]> {
  const clients: HeadlessClient[] = [];
  for (let i = 0; i < count; i++) {
    const ws = makeMockWs();
    const userId = i + 1;
    await room.addClient(ws, {
      userId,
      username: `scale_u${userId}`,
      role: "editor",
    });
    const awareness = new awarenessProtocol.Awareness(new Y.Doc());
    room.handleMessage(ws, buildAwarenessFrame(awareness, { name: `User ${userId}` }));
    clients.push({ ws, clientId: awareness.clientID, userId, awareness });
  }
  return clients;
}

describe("M74 — awareness + occupancy at 12 concurrent collaborators", () => {
  let db: any;
  let cfg: any;
  let tmpWs: string;
  let tmpData: string;

  beforeEach(() => {
    tmpWs = mkdtempSync(join(tmpdir(), "cloudide-m74-scale-ws-"));
    tmpData = mkdtempSync(join(tmpdir(), "cloudide-m74-scale-data-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmpWs, dataDir: tmpData };
    collaborationManager.init(cfg, db);
    for (let i = 1; i <= N; i++) {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run(`scale_u${i}`, "h", "user");
    }
  });

  afterEach(() => {
    try {
      rmSync(tmpWs, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tmpData, { recursive: true, force: true });
    } catch {}
  });

  it("clears abruptly-dropped clients from the awareness table on the next removeClient", async () => {
    const project = await createProject(cfg, db, 1, { name: "Scale12" });
    const room = collaborationManager.getOrCreateRoom(project.id);
    const clients = await spawnClients(room, N);

    // Baseline: every client is present, plus the server's own doc.clientID.
    expect(room.awareness.getStates().size).toBe(N + 1);
    for (const c of clients) {
      expect(room.awareness.getStates().has(c.clientId)).toBe(true);
    }
    expect(collaborationManager.roomOccupancy(project.id)).toEqual({
      liveClients: N,
      distinctUsers: N,
    });

    // Churn burst: clients 0..4 die abruptly (no close, no removal frame),
    // client 5 leaves cleanly (this drives the on-removal reconcile sweep).
    for (let i = 0; i < 5; i++) clients[i]!.ws.readyState = 3;
    room.removeClient(clients[5]!.ws);

    // Survivors: 6..11 = 6 live sockets.
    const states = room.awareness.getStates();
    expect(states.size).toBe(6 + 1); // survivors + baseline, zero orphans
    for (let i = 0; i <= 5; i++) {
      expect(states.has(clients[i]!.clientId)).toBe(false);
    }
    for (let i = 6; i < N; i++) {
      expect(states.has(clients[i]!.clientId)).toBe(true);
    }
    expect(room.occupancy()).toEqual({ liveClients: 6, distinctUsers: 6 });
    expect(collaborationManager.roomOccupancy(project.id)).toEqual({
      liveClients: 6,
      distinctUsers: 6,
    });
  });

  it("the periodic guard clears abruptly-dropped clients with no removeClient at all", async () => {
    const project = await createProject(cfg, db, 1, { name: "Scale12Guard" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn(), {
      awarenessReconcileMs: 25, // production default is 15s; sped up for the test
    });
    const clients = await spawnClients(room, N);
    expect(room.awareness.getStates().size).toBe(N + 1);

    // 8 of the 12 sockets die silently; removeClient is never called.
    for (let i = 0; i < 8; i++) clients[i]!.ws.readyState = 3;

    // Wait ~3 guard intervals.
    await new Promise((r) => setTimeout(r, 100));

    const states = room.awareness.getStates();
    expect(states.size).toBe(4 + 1); // 4 survivors + baseline
    for (let i = 0; i < 8; i++) {
      expect(states.has(clients[i]!.clientId)).toBe(false);
    }
    for (let i = 8; i < N; i++) {
      expect(states.has(clients[i]!.clientId)).toBe(true);
    }
    expect(room.occupancy()).toEqual({ liveClients: 4, distinctUsers: 4 });

    room.dispose();
  });
});

describe.skipIf(!isDockerRunning())(
  "M74 — sandbox lifecycle under a 12-collaborator room",
  () => {
    const cleanup: Array<{ mgr: SandboxManager; projectId: string }> = [];

    afterAll(async () => {
      for (const { mgr, projectId } of cleanup) {
        await mgr.stopProjectSandbox(projectId).catch(() => {});
      }
    });

    it("keeps the container warm while any collaborator is live, releases once all drop", async () => {
      const cfg = makeTestConfig();
      const db = openDb(":memory:");
      for (let i = 1; i <= N; i++) {
        db.prepare(
          "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        ).run(`scale_u${i}`, "h", "user");
      }
      collaborationManager.init(cfg, db);

      const mgr = new SandboxManager();
      mgr.setRoomOccupancyProvider((pid) =>
        collaborationManager.roomOccupancy(pid),
      );
      const projectId = `m74scale-${randomUUID()}`;
      await mgr.ensureProjectSandbox(projectId, cfg, makeWorkspace(cfg), 1);
      cleanup.push({ mgr, projectId });
      const name = `ide-sandbox-${projectId}`;
      const T0 = Date.now();

      const room = collaborationManager.getOrCreateRoom(projectId);
      const clients = await spawnClients(room, N);

      // 12 distinct users share this one container.
      const metrics = mgr.getRoomOccupancyMetrics();
      expect(metrics.containers).toBe(1);
      expect(metrics.containersWithMultipleUsers).toBe(1);
      expect(metrics.provisionedContainerRoomOccupancy).toEqual({
        totalLiveClients: N,
        totalDistinctUsers: N,
      });

      // 1h "later", 1s idle timeout — kept warm because the room is occupied.
      expect(
        await mgr.reapIdleSandboxes(1_000, 120_000, T0 + 3_600_000),
      ).toEqual([]);
      expect(await containerExists(name)).toBe(true);

      // Churn: 9 die abruptly, 3 remain -> still warm.
      for (let i = 0; i < 9; i++) clients[i]!.ws.readyState = 3;
      expect(collaborationManager.roomOccupancy(projectId).liveClients).toBe(3);
      expect(
        await mgr.reapIdleSandboxes(1_000, 120_000, T0 + 3_600_000),
      ).toEqual([]);
      expect(await containerExists(name)).toBe(true);

      // All remaining drop -> occupancy 0 -> the base idle rule reaps it.
      for (let i = 9; i < N; i++) clients[i]!.ws.readyState = 3;
      expect(collaborationManager.roomOccupancy(projectId).liveClients).toBe(0);
      const reaped = await mgr.reapIdleSandboxes(
        1_000,
        Infinity,
        T0 + 3_600_000,
      );
      expect(reaped).toContain(projectId);
      expect(await containerExists(name)).toBe(false);

      room.dispose();
    });
  },
);
