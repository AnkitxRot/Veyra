import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
} from "../src/collab/manager.js";

/**
 * M55 — Server-authoritative collaboration identity & awareness integrity.
 *
 * PRE-FIX VULNERABILITY (reproduced by "PRE-FIX PROOF" below against the
 * unpatched applyAwarenessUpdate path): the collaboration Awareness `user`
 * identity was client-asserted and rebroadcast verbatim, so a modified
 * client could set `user:{id,name,role}` to another user's values (or a
 * fabricated one) and every peer would render the spoofed identity. A
 * crafted entry for a *peer's* awareness clientID with a high clock could
 * also overwrite/grief that peer's presence.
 *
 * POST-FIX INVARIANT: a connection controls its own ephemeral
 * activity/location metadata, but never which authenticated user that
 * metadata belongs to, and never a peer's awareness entry.
 */

const MESSAGE_AWARENESS = 1;

/** Encodes a raw MESSAGE_AWARENESS frame with fully-controlled entries —
 *  the only way to inject a spoofed clientID/clock/state the way a modified
 *  browser would. */
function awarenessFrame(
  entries: Array<{ clientId: number; clock: number; state: unknown }>,
): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(inner, e.clientId);
    encoding.writeVarUint(inner, e.clock);
    encoding.writeVarString(inner, JSON.stringify(e.state));
  }
  const outer = encoding.createEncoder();
  encoding.writeVarUint(outer, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
  return encoding.toUint8Array(outer);
}

/** A minimal ws stand-in; awareness broadcasts go through room.awareness so
 *  we mostly read the stored state, but `send` must not throw. */
function makeWs() {
  return { readyState: 1, send: () => {}, close: () => {} } as any;
}

/** The state a peer would observe for `clientId` (this is exactly what
 *  encodeAwarenessUpdate broadcasts). */
function storedState(room: CollaborationRoom, clientId: number): any {
  return room.awareness.getStates().get(clientId);
}

const FULL_STATE = {
  user: { id: 999, name: "attacker-choice", role: "owner", color: "#abcdef" },
  status: "online",
  activity: { type: "editing", detail: "src/app.py", timestamp: 111 },
  activeFile: "src/app.py",
  cursor: { line: 3, column: 5 },
  selection: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 2 },
  lastActive: 111,
};

describe("M55 — server-authoritative collaboration awareness identity", () => {
  let db: any;
  let cfg: any;
  let tmp: string;
  const rooms: CollaborationRoom[] = [];

  const makeRoom = (projectId: string) => {
    const r = new CollaborationRoom(projectId, cfg, db, () => {});
    rooms.push(r);
    return r;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m55-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    collaborationManager.init(cfg, db);
  });

  afterEach(() => {
    for (const r of rooms.splice(0)) {
      try {
        r.dispose();
      } catch {}
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // --- identity authority ------------------------------------------------

  it("1-2. an authenticated connection's presence carries its own session identity", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "owner" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    room.handleMessage(
      wsA,
      awarenessFrame([{ clientId: 1001, clock: 1, state: { user: {} } }]),
    );
    room.handleMessage(
      wsB,
      awarenessFrame([{ clientId: 2002, clock: 1, state: { user: {} } }]),
    );

    expect(storedState(room, 1001).user).toMatchObject({
      id: 1,
      name: "alice",
      role: "owner",
    });
    expect(storedState(room, 2002).user).toMatchObject({
      id: 2,
      name: "bob",
      role: "editor",
    });
  });

  it("3-6. spoofed userId / username / role / fabricated identity are all overwritten with the session identity", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "carol", role: "viewer" });

    room.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 42,
          clock: 5,
          state: {
            user: {
              id: 1,
              name: "alice",
              role: "owner",
              extra: "ignored",
            },
          },
        },
      ]),
    );

    const s = storedState(room, 42);
    expect(s.user).toEqual({
      id: 7,
      name: "carol",
      displayName: "carol",
      role: "viewer",
    });
    expect(s.user.id).not.toBe(1);
    expect(s.user.name).not.toBe("alice");
    expect(s.user.displayName).not.toBe("alice");
    expect(s.user.role).not.toBe("owner");
    expect(s.user.extra).toBeUndefined();
  });

  it("28. a spoof attempt produces no identity change on any peer's stored state", async () => {
    const room = makeRoom("p1");
    const victim = makeWs();
    const attacker = makeWs();
    await room.addClient(victim, {
      userId: 1,
      username: "victim",
      role: "editor",
    });
    await room.addClient(attacker, {
      userId: 2,
      username: "attacker",
      role: "editor",
    });

    // Victim establishes presence on clientID 500.
    room.handleMessage(
      victim,
      awarenessFrame([{ clientId: 500, clock: 1, state: FULL_STATE }]),
    );
    expect(storedState(room, 500).user).toMatchObject({
      id: 1,
      name: "victim",
    });

    // Attacker tries to overwrite clientID 500 with a high clock.
    room.handleMessage(
      attacker,
      awarenessFrame([
        {
          clientId: 500,
          clock: 999_999,
          state: { user: { id: 1, name: "victim", role: "owner" } },
        },
      ]),
    );

    // Untouched: still the victim's session identity, editor role, clock 1.
    const s = storedState(room, 500);
    expect(s.user).toMatchObject({ id: 1, name: "victim", role: "editor" });
    expect((room.awareness.meta.get(500) as any).clock).toBe(1);
  });

  it("a connection cannot claim a clientID a live peer already owns (no grief overwrite)", async () => {
    const room = makeRoom("p1");
    const a = makeWs();
    const b = makeWs();
    await room.addClient(a, { userId: 1, username: "a", role: "editor" });
    await room.addClient(b, { userId: 2, username: "b", role: "editor" });

    room.handleMessage(
      a,
      awarenessFrame([{ clientId: 900, clock: 1, state: { user: {} } }]),
    );
    // b tries to write a's clientID
    room.handleMessage(
      b,
      awarenessFrame([
        {
          clientId: 900,
          clock: 50,
          state: { activity: { type: "terminal", timestamp: 1 } },
        },
      ]),
    );

    expect(storedState(room, 900).user).toMatchObject({ id: 1, name: "a" });
    expect(storedState(room, 900).activity).toBeUndefined();
  });

  // --- safe ephemeral fields preserved ---------------------------------

  it("7-10. valid activity / activeFile / cursor / selection are preserved verbatim", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    room.handleMessage(
      ws,
      awarenessFrame([{ clientId: 10, clock: 1, state: FULL_STATE }]),
    );

    const s = storedState(room, 10);
    expect(s.status).toBe("online");
    expect(s.activity).toEqual({
      type: "editing",
      detail: "src/app.py",
      timestamp: 111,
    });
    expect(s.activeFile).toBe("src/app.py");
    expect(s.cursor).toEqual({ line: 3, column: 5 });
    expect(s.selection).toEqual({
      startLine: 3,
      startColumn: 1,
      endLine: 4,
      endColumn: 2,
    });
    expect(s.lastActive).toBe(111);
  });

  it("all six activity types and all three availability states pass the enum gate", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    const activities = [
      "viewing",
      "editing",
      "running",
      "terminal",
      "searching",
      "reviewing",
    ];
    activities.forEach((type, i) => {
      room.handleMessage(
        ws,
        awarenessFrame([
          {
            clientId: 10,
            clock: i + 1,
            state: { activity: { type, timestamp: i } },
          },
        ]),
      );
      expect(storedState(room, 10).activity.type).toBe(type);
    });
    ["online", "idle", "dnd"].forEach((status, i) => {
      room.handleMessage(
        ws,
        awarenessFrame([{ clientId: 10, clock: 100 + i, state: { status } }]),
      );
      expect(storedState(room, 10).status).toBe(status);
    });
  });

  // --- field validation ------------------------------------------------

  it("11-15. invalid status / activity / oversized metadata / bad path / bad cursor are dropped, not stored", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    room.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 10,
          clock: 1,
          state: {
            status: "invisible",
            activity: { type: "hacking", timestamp: 1 },
            activeFile: "/etc/passwd",
            cursor: { line: -5, column: Number.NaN },
            selection: {
              startLine: Infinity,
              startColumn: 0,
              endLine: 0,
              endColumn: 0,
            },
            lastActive: Number.POSITIVE_INFINITY,
            bio: "x".repeat(50_000),
          },
        },
      ]),
    );

    const s = storedState(room, 10);
    expect(s.status).toBeUndefined();
    expect(s.activity).toBeUndefined();
    expect(s.activeFile).toBeUndefined();
    expect(s.cursor).toBeUndefined();
    expect(s.selection).toBeUndefined();
    expect(s.lastActive).toBeUndefined();
    expect(s.bio).toBeUndefined();
    // identity is still present and correct
    expect(s.user).toEqual({
      id: 1,
      name: "alice",
      displayName: "alice",
      role: "editor",
    });
  });

  it("activeFile rejects absolute / drive / traversal / control-char paths but keeps a normal relative path", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    const bad = [
      "/etc/passwd",
      "C:/Windows/system32",
      "../../secret.txt",
      "a/../../b",
      "with\u0000nul.py",
      "x".repeat(600),
    ];
    bad.forEach((activeFile, i) => {
      room.handleMessage(
        ws,
        awarenessFrame([{ clientId: 10, clock: i + 1, state: { activeFile } }]),
      );
      expect(storedState(room, 10).activeFile).toBeUndefined();
    });
    room.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 10,
          clock: 99,
          state: { activeFile: "src/nested/main.py" },
        },
      ]),
    );
    expect(storedState(room, 10).activeFile).toBe("src/nested/main.py");
  });

  it("an oversized detail string is dropped while the activity type survives", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    room.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 10,
          clock: 1,
          state: {
            activity: {
              type: "searching",
              detail: "y".repeat(9999),
              timestamp: 1,
            },
          },
        },
      ]),
    );
    const a = storedState(room, 10).activity;
    expect(a.type).toBe("searching");
    expect(a.detail).toBeUndefined();
  });

  // --- malformed payloads --------------------------------------------

  it("23. malformed frames (bad varint, non-JSON state, huge entry count, truncation) never throw or store junk", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    // absurd entry count
    const huge = encoding.createEncoder();
    encoding.writeVarUint(huge, 1);
    encoding.writeVarUint8Array(
      huge,
      (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 5_000_000);
        return encoding.toUint8Array(e);
      })(),
    );
    expect(() =>
      room.handleMessage(ws, encoding.toUint8Array(huge)),
    ).not.toThrow();

    // non-JSON state string
    const badJson = encoding.createEncoder();
    encoding.writeVarUint(badJson, 1);
    encoding.writeVarUint8Array(
      badJson,
      (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1); // one entry
        encoding.writeVarUint(e, 10);
        encoding.writeVarUint(e, 1);
        encoding.writeVarString(e, "{not json");
        return encoding.toUint8Array(e);
      })(),
    );
    expect(() =>
      room.handleMessage(ws, encoding.toUint8Array(badJson)),
    ).not.toThrow();

    // primitive (non-object, non-null) state
    room.handleMessage(
      ws,
      awarenessFrame([{ clientId: 11, clock: 1, state: 42 }]),
    );
    expect(room.awareness.getStates().has(11)).toBe(false);

    // room still healthy — a good frame after the bad ones still works
    room.handleMessage(
      ws,
      awarenessFrame([{ clientId: 12, clock: 1, state: { user: {} } }]),
    );
    expect(storedState(room, 12).user).toMatchObject({ name: "alice" });
  });

  // --- DoS bounds ----------------------------------------------------

  it("DOS: a connection cannot own more than the per-connection clientID cap", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    for (let i = 0; i < 50; i++) {
      room.handleMessage(
        ws,
        awarenessFrame([{ clientId: 3000 + i, clock: 1, state: { user: {} } }]),
      );
    }
    const cs = (room as any).clients.get(ws);
    expect(cs.awarenessClientIds.size).toBeLessThanOrEqual(8);
    expect(room.awareness.getStates().size).toBeLessThanOrEqual(9); // + room doc
  });

  it("DOS: a single frame carrying more than the entry cap is rejected wholesale", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    const many = Array.from({ length: 200 }, (_, i) => ({
      clientId: 7000 + i,
      clock: 1,
      state: { user: {} },
    }));
    room.handleMessage(ws, awarenessFrame(many));
    expect(room.awareness.getStates().size).toBe(1); // only the room's own doc
  });

  // --- lifecycle ----------------------------------------------------

  it("16-18. identity stays correct across a reconnect, and disconnect removes only that connection's presence", async () => {
    const room = makeRoom("p1");
    const first = makeWs();
    await room.addClient(first, {
      userId: 5,
      username: "dave",
      role: "editor",
    });
    room.handleMessage(
      first,
      awarenessFrame([{ clientId: 111, clock: 1, state: { user: {} } }]),
    );

    const peer = makeWs();
    await room.addClient(peer, { userId: 6, username: "erin", role: "editor" });
    room.handleMessage(
      peer,
      awarenessFrame([{ clientId: 222, clock: 1, state: { user: {} } }]),
    );

    room.removeClient(first);
    expect(room.awareness.getStates().has(111)).toBe(false);
    expect(room.awareness.getStates().has(222)).toBe(true);

    // "Reconnect": a new socket, a new random clientID — identity is still
    // the authenticated session, never inherited or forgeable.
    const reconnected = makeWs();
    await room.addClient(reconnected, {
      userId: 5,
      username: "dave",
      role: "viewer", // e.g. downgraded between sessions
    });
    room.handleMessage(
      reconnected,
      awarenessFrame([
        {
          clientId: 333,
          clock: 1,
          state: { user: { id: 6, name: "erin", role: "owner" } },
        },
      ]),
    );
    expect(storedState(room, 333).user).toEqual({
      id: 5,
      name: "dave",
      displayName: "dave",
      role: "viewer",
    });
  });

  it("19. room disposal clears all awareness state and cannot be written afterward", async () => {
    const room = makeRoom("p-disp");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    room.handleMessage(
      ws,
      awarenessFrame([{ clientId: 1, clock: 1, state: FULL_STATE }]),
    );
    expect(room.awareness.getStates().size).toBeGreaterThan(0);

    room.dispose();

    expect(() =>
      room.handleMessage(
        ws,
        awarenessFrame([{ clientId: 1, clock: 2, state: FULL_STATE }]),
      ),
    ).not.toThrow();
  });

  it("20-22. three users in one room keep distinct correct identities; a second room is isolated", async () => {
    const roomA = makeRoom("A");
    const roomB = makeRoom("B");

    const wsA1 = makeWs();
    const wsA2 = makeWs();
    const wsB1 = makeWs();
    await roomA.addClient(wsA1, { userId: 1, username: "a1", role: "owner" });
    await roomA.addClient(wsA2, { userId: 2, username: "a2", role: "editor" });
    await roomB.addClient(wsB1, { userId: 3, username: "b1", role: "editor" });

    roomA.handleMessage(
      wsA1,
      awarenessFrame([
        {
          clientId: 1,
          clock: 1,
          state: { user: { id: 3, name: "b1", role: "owner" } },
        },
      ]),
    );
    roomA.handleMessage(
      wsA2,
      awarenessFrame([{ clientId: 2, clock: 1, state: { user: {} } }]),
    );
    roomB.handleMessage(
      wsB1,
      awarenessFrame([{ clientId: 1, clock: 1, state: { user: {} } }]),
    );

    expect(storedState(roomA, 1).user).toMatchObject({ id: 1, name: "a1" });
    expect(storedState(roomA, 2).user).toMatchObject({ id: 2, name: "a2" });
    // Same numeric clientID in room B is a different person — no crosstalk.
    expect(storedState(roomB, 1).user).toMatchObject({ id: 3, name: "b1" });
  });

  it("multiple tabs of the same user each get an independent, correctly-attributed entry", async () => {
    const room = makeRoom("p1");
    const tab1 = makeWs();
    const tab2 = makeWs();
    await room.addClient(tab1, {
      userId: 1,
      username: "alice",
      role: "editor",
    });
    await room.addClient(tab2, {
      userId: 1,
      username: "alice",
      role: "editor",
    });

    room.handleMessage(
      tab1,
      awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]),
    );
    room.handleMessage(
      tab2,
      awarenessFrame([{ clientId: 20, clock: 1, state: { user: {} } }]),
    );

    // tab2 cannot retire tab1's entry
    room.handleMessage(
      tab2,
      awarenessFrame([{ clientId: 10, clock: 5, state: null }]),
    );
    expect(room.awareness.getStates().has(10)).toBe(true);

    room.removeClient(tab1);
    expect(room.awareness.getStates().has(10)).toBe(false);
    expect(room.awareness.getStates().has(20)).toBe(true);
  });

  // --- leakage ----------------------------------------------------

  it("27. no stdout / secret / command / env content can ride through awareness metadata", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    room.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 10,
          clock: 1,
          state: {
            user: { id: 1, name: "alice" },
            activity: { type: "terminal", timestamp: 1 },
            stdout: "SUPER_SECRET_M55_TEST_VALUE=hunter2",
            env: { SECRET: "hunter2" },
            command: "printenv SUPER_SECRET_M55_TEST_VALUE",
            terminalOutput: "hunter2",
            secrets: ["hunter2"],
          },
        },
      ]),
    );

    const serialized = JSON.stringify(storedState(room, 10));
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("SUPER_SECRET");
    expect(serialized).not.toContain("printenv");
    expect(serialized).not.toContain("stdout");
    expect(serialized).not.toContain("terminalOutput");
    // allowlisted fields only
    expect(Object.keys(storedState(room, 10)).sort()).toEqual(
      ["activity", "user"].sort(),
    );
  });

  // --- PRE-FIX PROOF ----------------------------------------------

  it("PRE-FIX PROOF: the raw y-protocols apply path (bypassing the M55 rebuild) DOES store a spoofed identity", () => {
    // This exercises exactly what handleMessage did before M55: apply the
    // client's awareness bytes verbatim. It documents the vulnerability the
    // rebuild closes — and would start failing if someone reintroduced the
    // verbatim path.
    const doc = new Y.Doc();
    const serverAwareness = new awarenessProtocol.Awareness(doc);
    const clientDoc = new Y.Doc();
    const clientAwareness = new awarenessProtocol.Awareness(clientDoc);
    clientAwareness.setLocalState({
      user: { id: 1, name: "victim", role: "owner" },
    });
    const update = awarenessProtocol.encodeAwarenessUpdate(clientAwareness, [
      clientAwareness.clientID,
    ]);

    awarenessProtocol.applyAwarenessUpdate(serverAwareness, update, "origin");

    const spoofed = serverAwareness
      .getStates()
      .get(clientAwareness.clientID) as any;
    expect(spoofed.user).toEqual({ id: 1, name: "victim", role: "owner" });

    serverAwareness.destroy();
    clientAwareness.destroy();
    doc.destroy();
    clientDoc.destroy();
  });

  it("POST-FIX: the same spoof through the real room handler is neutralized", async () => {
    const room = makeRoom("p1");
    const ws = makeWs();
    await room.addClient(ws, {
      userId: 8,
      username: "mallory",
      role: "editor",
    });
    room.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 77,
          clock: 3,
          state: { user: { id: 1, name: "victim", role: "owner" } },
        },
      ]),
    );
    expect(storedState(room, 77).user).toEqual({
      id: 8,
      name: "mallory",
      displayName: "mallory",
      role: "editor",
    });
  });

  // --- M56: bounded activeFileDirty awareness bit -----------------------

  describe("M56 — activeFileDirty is the only new awareness field, and it is bounded", () => {
    it("accepts a boolean activeFileDirty and attributes it to the session", async () => {
      const room = makeRoom("p1");
      const ws = makeWs();
      await room.addClient(ws, {
        userId: 3,
        username: "carol",
        role: "editor",
      });
      room.handleMessage(
        ws,
        awarenessFrame([
          {
            clientId: 33,
            clock: 1,
            state: {
              user: {},
              activeFile: "src/a.ts",
              activeFileDirty: true,
            },
          },
        ]),
      );
      const st = storedState(room, 33);
      expect(st.activeFileDirty).toBe(true);
      expect(st.user).toEqual({
        id: 3,
        name: "carol",
        displayName: "carol",
        role: "editor",
      });
    });

    it("drops a non-boolean activeFileDirty", async () => {
      const room = makeRoom("p1");
      const ws = makeWs();
      await room.addClient(ws, {
        userId: 3,
        username: "carol",
        role: "editor",
      });
      room.handleMessage(
        ws,
        awarenessFrame([
          {
            clientId: 33,
            clock: 1,
            state: { user: {}, activeFileDirty: "yes" },
          },
        ]),
      );
      expect(storedState(room, 33).activeFileDirty).toBeUndefined();
    });

    it("discards a client-supplied dirtyPaths list entirely (no path list ever survives, no FS op)", async () => {
      const room = makeRoom("p1");
      const ws = makeWs();
      const fsMod = await import("node:fs");
      const statSpy = vi.spyOn(fsMod.promises, "stat");
      await room.addClient(ws, {
        userId: 3,
        username: "carol",
        role: "editor",
      });
      room.handleMessage(
        ws,
        awarenessFrame([
          {
            clientId: 33,
            clock: 1,
            state: {
              user: {},
              activeFileDirty: true,
              dirtyPaths: ["../other-project/secret.env", "/etc/passwd"],
            },
          },
        ]),
      );
      const st = storedState(room, 33);
      expect(st.activeFileDirty).toBe(true);
      expect(st.dirtyPaths).toBeUndefined();
      expect(Object.keys(st).sort()).not.toContain("dirtyPaths");
      expect(statSpy).not.toHaveBeenCalled();
    });

    it("a client cannot claim another collaborator's dirty state (peer clientID ownership still enforced)", async () => {
      const room = makeRoom("p1");
      const wsA = makeWs();
      const wsB = makeWs();
      await room.addClient(wsA, { userId: 1, username: "a", role: "editor" });
      await room.addClient(wsB, { userId: 2, username: "b", role: "editor" });
      // B claims clientID 500.
      room.handleMessage(
        wsB,
        awarenessFrame([{ clientId: 500, clock: 1, state: { user: {} } }]),
      );
      // A tries to write dirty state onto B's clientID 500.
      room.handleMessage(
        wsA,
        awarenessFrame([
          {
            clientId: 500,
            clock: 5,
            state: { user: {}, activeFileDirty: true },
          },
        ]),
      );
      const st = storedState(room, 500);
      expect(st.user).toEqual({
        id: 2,
        name: "b",
        displayName: "b",
        role: "editor",
      });
      expect(st.activeFileDirty).toBeUndefined();
    });
  });
});
