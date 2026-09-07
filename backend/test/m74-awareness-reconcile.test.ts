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

/** A minimal stand-in for a live client WebSocket. */
function makeMockWs() {
  return { readyState: 1, send: () => {}, close: () => {} } as any;
}

/**
 * A real MESSAGE_AWARENESS frame, exactly as a browser client would send it:
 * a throwaway Y.Doc + Awareness supplies a genuine, randomly-assigned
 * clientID, and `setLocalStateField` produces a real awareness update wrapped
 * in the envelope the room's `handleMessage` expects.
 */
function buildAwarenessFrame(
  clientAwareness: awarenessProtocol.Awareness,
  user: Record<string, unknown>,
) {
  clientAwareness.setLocalStateField("user", user);
  const update = awarenessProtocol.encodeAwarenessUpdate(clientAwareness, [
    clientAwareness.clientID,
  ]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

describe("M74 — awareness table reconciliation against live sockets", () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;
  let tempDataDir: string;

  beforeEach(() => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m74-ws-"));
    tempDataDir = mkdtempSync(join(tmpdir(), "cloudide-m74-data-"));
    db = openDb(":memory:");
    cfg = {
      ...resolveConfig(),
      workspacesDir: tempWorkspacesDir,
      dataDir: tempDataDir,
    };
  });

  afterEach(() => {
    try {
      rmSync(tempWorkspacesDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * The "socket closes without the removal frame reaching the server" race
   * (heartbeat-reaper / dev StrictMode / project-switch churn), per
   * STATUS.md:8262-8272, :8308-8310.
   *
   * Connection A's underlying socket dies with no `close` event and no
   * awareness-removal frame — so `removeClient(wsA)` never runs and A's
   * awareness entry is never withdrawn by A itself. A *different* room
   * lifecycle event then occurs (collaborator B disconnects cleanly). After
   * that event the room's awareness table must contain no entry that is not
   * backed by a live socket: A's stale state must be gone, leaving only the
   * server's own `doc.clientID` baseline (`setLocalState({})` in the
   * y-protocols Awareness constructor — belongs to no participant).
   *
   * Today `removeClient()` only withdraws the leaver's own tracked
   * `awarenessClientIds` and never reconciles the rest of the table, so A's
   * `{ user }` entry survives as an orphan.
   */
  it("drops a dead connection's awareness entry when another client leaves", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2

    const project = await createProject(cfg, db, 1, { name: "ChurnRoom" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);

    const wsA = makeMockWs();
    const wsB = makeMockWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    const clientAwarenessA = new awarenessProtocol.Awareness(new Y.Doc());
    const clientAwarenessB = new awarenessProtocol.Awareness(new Y.Doc());
    const clientIdA = clientAwarenessA.clientID;
    const clientIdB = clientAwarenessB.clientID;

    room.handleMessage(wsA, buildAwarenessFrame(clientAwarenessA, { name: "Alice" }));
    room.handleMessage(wsB, buildAwarenessFrame(clientAwarenessB, { name: "Bob" }));

    // Both presences are live in the room's awareness table.
    expect(room.awareness.getStates().has(clientIdA)).toBe(true);
    expect(room.awareness.getStates().has(clientIdB)).toBe(true);

    // A's socket dies silently: no 'close' event -> no removeClient(wsA), and
    // no awareness-removal frame was ever sent.
    wsA.readyState = 3; // WebSocket.CLOSED

    // A different room lifecycle event: B disconnects cleanly.
    room.removeClient(wsB);

    const states = room.awareness.getStates();

    // A's socket is dead and untracked -> its awareness entry must not linger.
    expect(states.has(clientIdA)).toBe(false);
    // B left cleanly.
    expect(states.has(clientIdB)).toBe(false);
    // Only the server's own doc.clientID baseline ({}) remains.
    expect(states.size).toBe(1);

    room.dispose();
    clientAwarenessA.destroy();
    clientAwarenessB.destroy();
  });

  /**
   * A late joiner must never receive a dead connection's presence in its
   * initial awareness snapshot. Connection A's socket dies with no `close`
   * event (so `removeClient(wsA)` never runs and the reconcile in commit 1 is
   * not triggered); connection C then joins. The awareness frame `addClient`
   * sends C must carry only the server's own `doc.clientID` baseline plus the
   * one genuinely-live peer (B).
   */
  it("excludes a dead connection's awareness entry from a late joiner's snapshot", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("carol", "h", "user"); // id 3

    const project = await createProject(cfg, db, 1, { name: "JoinSnapshotRoom" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);

    const wsA = makeMockWs();
    const wsB = makeMockWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    const clientAwarenessA = new awarenessProtocol.Awareness(new Y.Doc());
    const clientAwarenessB = new awarenessProtocol.Awareness(new Y.Doc());
    const clientIdA = clientAwarenessA.clientID;
    const clientIdB = clientAwarenessB.clientID;
    room.handleMessage(wsA, buildAwarenessFrame(clientAwarenessA, { name: "Alice" }));
    room.handleMessage(wsB, buildAwarenessFrame(clientAwarenessB, { name: "Bob" }));

    // A's socket dies silently: no 'close', no removeClient, no removal frame.
    wsA.readyState = 3; // WebSocket.CLOSED

    // C joins and records every frame the room sends it.
    const received: Uint8Array[] = [];
    const wsC = {
      readyState: 1,
      send: (data: Uint8Array) => received.push(data),
      close: () => {},
    } as any;
    await room.addClient(wsC, { userId: 3, username: "carol", role: "editor" });

    // The lone MESSAGE_AWARENESS frame in C's join snapshot.
    const MESSAGE_AWARENESS = 1;
    const awarenessFrames = received.filter((buf) => {
      const d = decoding.createDecoder(buf);
      return decoding.readVarUint(d) === MESSAGE_AWARENESS;
    });
    expect(awarenessFrames.length).toBe(1);

    // Decode the awareness update the joiner received into { clientID -> state }.
    const d = decoding.createDecoder(awarenessFrames[0]!);
    decoding.readVarUint(d); // MESSAGE_AWARENESS
    const update = decoding.readVarUint8Array(d);
    const ud = decoding.createDecoder(update);
    const count = decoding.readVarUint(ud);
    const snapshot = new Map<number, unknown>();
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(ud);
      decoding.readVarUint(ud); // clock
      snapshot.set(clientId, JSON.parse(decoding.readVarString(ud)));
    }

    // The dead connection's presence is not delivered to the joiner.
    expect(snapshot.has(clientIdA)).toBe(false);
    // The live peer is.
    expect(snapshot.has(clientIdB)).toBe(true);
    // Server's own doc.clientID baseline ({}) plus B — nothing else.
    expect(snapshot.has(room.doc.clientID)).toBe(true);
    expect(snapshot.size).toBe(2);

    room.dispose();
    clientAwarenessA.destroy();
    clientAwarenessB.destroy();
  });

  /**
   * The periodic safety-net guard: when a socket dies with no 'close' event,
   * `removeClient()` never runs for it, so neither commit 1's on-removal
   * reconcile nor a fresh join is guaranteed to fire. A non-empty room runs
   * `reconcileAwarenessAgainstLiveSockets()` on a fixed interval
   * (`DEFAULT_AWARENESS_RECONCILE_MS`, overridden here for speed) so a dead
   * connection's presence is still cleared within one or two intervals.
   *
   * Both A and B drop without a close event (the deploy / connection-storm
   * case the guard exists for) and `removeClient` is never called for either;
   * after two intervals the table is back to the server's own baseline.
   */
  it("periodic guard reconciles dead sockets even when removeClient never runs", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2

    const project = await createProject(cfg, db, 1, { name: "PeriodicGuardRoom" });
    const onDispose = vi.fn();
    // Short interval so the test does not wait the production 15s.
    const room = new CollaborationRoom(project.id, cfg, db, onDispose, {
      awarenessReconcileMs: 25,
    });

    const wsA = makeMockWs();
    const wsB = makeMockWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    const clientAwarenessA = new awarenessProtocol.Awareness(new Y.Doc());
    const clientAwarenessB = new awarenessProtocol.Awareness(new Y.Doc());
    const clientIdA = clientAwarenessA.clientID;
    const clientIdB = clientAwarenessB.clientID;
    room.handleMessage(wsA, buildAwarenessFrame(clientAwarenessA, { name: "Alice" }));
    room.handleMessage(wsB, buildAwarenessFrame(clientAwarenessB, { name: "Bob" }));
    expect(room.awareness.getStates().has(clientIdA)).toBe(true);
    expect(room.awareness.getStates().has(clientIdB)).toBe(true);

    // Both sockets die silently: no 'close', no removeClient, no removal frame.
    wsA.readyState = 3; // WebSocket.CLOSED
    wsB.readyState = 3;

    // Wait roughly three guard intervals.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const states = room.awareness.getStates();
    expect(states.has(clientIdA)).toBe(false);
    expect(states.has(clientIdB)).toBe(false);
    // Only the server's own doc.clientID baseline ({}) remains.
    expect(states.size).toBe(1);

    room.dispose();
    clientAwarenessA.destroy();
    clientAwarenessB.destroy();
  });

  /**
   * M76 regression: many join / silent-death / clean-leave cycles must not
   * let the awareness table grow without bound. Each iteration adds two
   * fresh connections (new random clientIDs), kills one silently, removes the
   * other cleanly. After every iteration the table is back to exactly the
   * server's own `doc.clientID` baseline — no orphan accumulation across 25
   * cycles.
   */
  it("repeated join/silent-death/leave cycles never accumulate orphan entries", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2

    const project = await createProject(cfg, db, 1, { name: "CycleRoom" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());

    const clientAwarenesses: awarenessProtocol.Awareness[] = [];
    for (let i = 0; i < 25; i++) {
      const wsA = makeMockWs();
      const wsB = makeMockWs();
      await room.addClient(wsA, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

      const caA = new awarenessProtocol.Awareness(new Y.Doc());
      const caB = new awarenessProtocol.Awareness(new Y.Doc());
      clientAwarenesses.push(caA, caB);
      room.handleMessage(wsA, buildAwarenessFrame(caA, { name: `A${i}` }));
      room.handleMessage(wsB, buildAwarenessFrame(caB, { name: `B${i}` }));

      expect(room.awareness.getStates().size).toBe(3); // A + B + baseline

      wsA.readyState = 3; // dies silently — no removeClient
      room.removeClient(wsB); // clean leave drives the on-removal reconcile

      // Back to just the server baseline — both this iteration's entries gone.
      expect(room.awareness.getStates().size).toBe(1);
      expect(room.awareness.getStates().has(caA.clientID)).toBe(false);
      expect(room.awareness.getStates().has(caB.clientID)).toBe(false);
    }

    room.dispose();
    for (const ca of clientAwarenesses) ca.destroy();
  });

  /**
   * M76 regression: a single user reconnecting (new socket, new Yjs clientID,
   * old socket dead) must leave exactly one awareness entry for that user —
   * the new one — never a duplicate and never a lingering stale entry.
   */
  it("a reconnect (new clientID, old socket dead) leaves exactly one entry for the user", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "ReconnectRoom" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());

    const ws1 = makeMockWs();
    await room.addClient(ws1, { userId: 1, username: "alice", role: "editor" });
    const ca1 = new awarenessProtocol.Awareness(new Y.Doc());
    room.handleMessage(ws1, buildAwarenessFrame(ca1, { name: "Alice" }));
    expect(room.awareness.getStates().has(ca1.clientID)).toBe(true);

    // Old socket dies silently; the client reconnects on a fresh socket with a
    // brand-new Yjs clientID before any removeClient(ws1) fires.
    ws1.readyState = 3;
    const ws2 = makeMockWs();
    await room.addClient(ws2, { userId: 1, username: "alice", role: "editor" });
    const ca2 = new awarenessProtocol.Awareness(new Y.Doc());
    room.handleMessage(ws2, buildAwarenessFrame(ca2, { name: "Alice" }));

    // The dead socket's 'close' event finally arrives and removeClient(ws1)
    // runs — late, after the reconnect. It must withdraw only the stale entry.
    room.removeClient(ws1);

    const states = room.awareness.getStates();
    expect(states.has(ca2.clientID)).toBe(true); // the live reconnected entry
    expect(states.has(ca1.clientID)).toBe(false); // stale entry gone
    // one live user entry + server baseline, no duplicate
    expect(states.size).toBe(2);
    // server forces authoritative identity — user.name is the immutable
    // username, and there is exactly one entry for the user (no duplicate).
    const users = [...states.values()]
      .map((s: any) => s.user?.name)
      .filter(Boolean);
    expect(users).toEqual(["alice"]);

    room.dispose();
    ca1.destroy();
    ca2.destroy();
  });
});
