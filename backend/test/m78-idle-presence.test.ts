import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationRoom } from "../src/collab/manager.js";
import { createProject } from "../src/projects/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MESSAGE_AWARENESS = 1;
const SWEEP_MS = 200; // stand-in for DEFAULT_AWARENESS_RECONCILE_MS (15_000)
const COALESCE_MS = 10;

/** A live client socket that records every frame the room sends it. */
function capturingWs() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as Uint8Array[],
    send(d: Uint8Array) {
      this.sent.push(new Uint8Array(d));
    },
    close() {},
  } as any;
}

/** A real MESSAGE_AWARENESS frame, exactly as a browser client sends it. */
function buildAwarenessFrame(
  ca: awarenessProtocol.Awareness,
  fields: Record<string, unknown>,
) {
  for (const [k, v] of Object.entries(fields)) ca.setLocalStateField(k, v);
  const update = awarenessProtocol.encodeAwarenessUpdate(ca, [ca.clientID]);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, update);
  return encoding.toUint8Array(enc);
}

/** Decode a MESSAGE_AWARENESS frame → Map<clientId, { clock, state }>. */
function decodeAwareness(buf: Uint8Array) {
  const d = decoding.createDecoder(buf);
  if (decoding.readVarUint(d) !== MESSAGE_AWARENESS) return null;
  const inner = decoding.createDecoder(decoding.readVarUint8Array(d));
  const n = decoding.readVarUint(inner);
  const out = new Map<number, { clock: number; state: any }>();
  for (let i = 0; i < n; i++) {
    const clientId = decoding.readVarUint(inner);
    const clock = decoding.readVarUint(inner);
    out.set(clientId, { clock, state: JSON.parse(decoding.readVarString(inner)) });
  }
  return out;
}

/** Every awareness frame `ws` received that carries an entry for `clientId`. */
function awarenessFramesFor(ws: any, clientId: number) {
  return ws.sent
    .map(decodeAwareness)
    .filter((m: any) => m && m.has(clientId));
}

describe("M78 — idle connected collaborators stay visible to peers", () => {
  let db: any;
  let cfg: any;
  let tmpWs: string;
  let tmpData: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpWs = mkdtempSync(join(tmpdir(), "cloudide-m78-ws-"));
    tmpData = mkdtempSync(join(tmpdir(), "cloudide-m78-data-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmpWs, dataDir: tmpData };
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      rmSync(tmpWs, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tmpData, { recursive: true, force: true });
    } catch {}
  });

  async function room2() {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2
    const project = await createProject(cfg, db, 1, { name: "IdleRoom" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn(), {
      awarenessReconcileMs: SWEEP_MS,
      awarenessCoalesceMs: COALESCE_MS,
    });
    const wsA = capturingWs();
    const wsB = capturingWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const caA = new awarenessProtocol.Awareness(new Y.Doc());
    const caB = new awarenessProtocol.Awareness(new Y.Doc());
    // both go online, then stop interacting entirely
    room.handleMessage(
      wsA,
      buildAwarenessFrame(caA, {
        user: { name: "Alice", color: "#89b4fa" },
        status: "idle",
        activity: { type: "viewing", detail: null, timestamp: 1 },
        lastActive: 1000,
      }),
    );
    room.handleMessage(
      wsB,
      buildAwarenessFrame(caB, {
        user: { name: "Bob", color: "#a6e3a1" },
        status: "online",
        activity: { type: "viewing", detail: null, timestamp: 1 },
        lastActive: 1000,
      }),
    );
    vi.advanceTimersByTime(COALESCE_MS + 1); // flush the join broadcasts
    return { room, wsA, wsB, aId: caA.clientID, bId: caB.clientID, caA, caB };
  }

  it("REPRO/FIX: a peer keeps receiving refreshes for an idle collaborator across sweeps", async () => {
    const { room, wsB, aId } = await room2();
    wsB.sent.length = 0;

    // ~3 sweep windows pass with zero interaction from Alice.
    vi.advanceTimersByTime(SWEEP_MS * 3 + COALESCE_MS + 5);

    const refreshes = awarenessFramesFor(wsB, aId);
    // Before the fix this is 0 → a real peer's y-protocols Awareness would
    // have deleted Alice at 30s. After the fix Bob is refreshed each sweep.
    expect(refreshes.length).toBeGreaterThanOrEqual(2);
    // the server's own view still has Alice, and her lastUpdated keeps moving
    expect(room.awareness.getStates().has(aId)).toBe(true);

    room.dispose();
  });

  it("the refresh carries an INCREASING clock and the UNCHANGED idle state", async () => {
    const { room, wsB, aId } = await room2();
    wsB.sent.length = 0;
    vi.advanceTimersByTime(SWEEP_MS * 3 + COALESCE_MS + 5);

    const refreshes = awarenessFramesFor(wsB, aId);
    const clocks = refreshes.map((m: any) => m.get(aId).clock);
    for (let i = 1; i < clocks.length; i++) {
      expect(clocks[i]).toBeGreaterThan(clocks[i - 1]);
    }
    const last = refreshes[refreshes.length - 1].get(aId).state;
    // idle stays idle — never flipped to "active"/"online" by the keepalive
    expect(last.status).toBe("idle");
    expect(last.activity.type).toBe("viewing");
    expect(last.lastActive).toBe(1000); // not bumped
    expect(last.user.name).toBe("alice"); // server-stamped identity, intact

    room.dispose();
  });

  it("never sends a client its OWN entry in a keepalive frame", async () => {
    const { room, wsA, wsB, aId, bId } = await room2();
    wsA.sent.length = 0;
    wsB.sent.length = 0;
    vi.advanceTimersByTime(SWEEP_MS * 3 + COALESCE_MS + 5);

    // Alice's socket only ever hears about Bob, never re-hears herself.
    for (const m of wsA.sent.map(decodeAwareness)) {
      if (m) expect(m.has(aId)).toBe(false);
    }
    for (const m of wsB.sent.map(decodeAwareness)) {
      if (m) expect(m.has(bId)).toBe(false);
    }
    room.dispose();
  });

  it("a genuine disconnect still removes the collaborator (no zombie keepalive)", async () => {
    const { room, wsA, wsB, aId } = await room2();
    room.removeClient(wsA); // Alice's socket closes for real
    wsB.sent.length = 0;
    vi.advanceTimersByTime(SWEEP_MS * 4 + COALESCE_MS + 5);

    expect(room.awareness.getStates().has(aId)).toBe(false);
    // any frame Bob got that mentions Alice must be a REMOVAL (state null)
    for (const m of awarenessFramesFor(wsB, aId)) {
      expect(m.get(aId).state).toBeNull();
    }
    room.dispose();
  });

  it("a dead socket (readyState !== 1) is not kept warm by the keepalive", async () => {
    const { room, wsA, wsB, aId } = await room2();
    wsA.readyState = 3; // died with no close event
    wsB.sent.length = 0;
    vi.advanceTimersByTime(SWEEP_MS * 3 + COALESCE_MS + 5);

    // M74 reconcile drops the orphan; the keepalive never re-adds it.
    expect(room.awareness.getStates().has(aId)).toBe(false);
    room.dispose();
  });

  it("the keepalive stops and the timer is cleared once the room empties / disposes", async () => {
    const { room, wsA, wsB } = await room2();
    room.removeClient(wsA);
    room.removeClient(wsB); // room now empty
    expect((room as any).awarenessReconcileTimer).toBeNull();

    room.dispose();
    expect((room as any).awarenessReconcileTimer).toBeNull();
    // nothing throws / emits after dispose
    vi.advanceTimersByTime(SWEEP_MS * 5);
  });

  it("MONOTONIC CLOCK: an idle collaborator's real update is still applied after the server clock has advanced", async () => {
    const { room, wsA, wsB, aId, caA } = await room2();
    wsB.sent.length = 0;
    // sweeps advance the server's meta.clock for Alice well past caA's clock
    vi.advanceTimersByTime(SWEEP_MS * 5 + COALESCE_MS + 5);
    const serverClock = (room.awareness.meta.get(aId) as any).clock;
    expect(serverClock).toBeGreaterThan(3);

    // Alice comes back and edits — caA's own clock is only ~2 here (idle tab
    // that never renewed). The frame must NOT be dropped on the stale clock.
    room.handleMessage(
      wsA,
      buildAwarenessFrame(caA, {
        status: "online",
        activity: { type: "editing", detail: "main.py", timestamp: 2 },
      }),
    );
    vi.advanceTimersByTime(COALESCE_MS + 5);

    expect((room.awareness.getStates().get(aId) as any).activity.type).toBe(
      "editing",
    );
    const echoed = awarenessFramesFor(wsB, aId).pop();
    expect(echoed.get(aId).state.activity.type).toBe("editing");
    expect(echoed.get(aId).clock).toBeGreaterThan(serverClock);

    room.dispose();
  });

  it("does not disturb M74 reconciliation: orphan of a silently-dead socket is still dropped on the next removeClient", async () => {
    const { room, wsA, wsB, aId, bId } = await room2();
    wsA.readyState = 3; // silent death
    room.removeClient(wsB); // unrelated clean leave drives the reconcile
    expect(room.awareness.getStates().has(aId)).toBe(false);
    expect(room.awareness.getStates().has(bId)).toBe(false);
    room.dispose();
  });
});
