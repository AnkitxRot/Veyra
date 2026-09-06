import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb, type Db } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { collaborationManager } from "../src/collab/manager.js";
import * as profileStore from "../src/profile/store.js";
import { updateProfile } from "../src/profile/store.js";
import { listProjectCollaborators } from "../src/projects/service.js";

const MESSAGE_AWARENESS = 1;
const MESSAGE_CUSTOM = 3;

/** A raw client MESSAGE_AWARENESS frame with fully-controlled entries. */
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

/** A raw client MESSAGE_CUSTOM frame (used to prove inbound profile_event is
 *  ignored). */
function customFrame(obj: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc);
}

/** ws stand-in that decodes every MESSAGE_CUSTOM frame the server sends it.
 *  Typed `any` to satisfy the room's `WebSocket` parameter, like the other
 *  collaboration suites. */
function makeWs(): any {
  const custom: any[] = [];
  return {
    readyState: 1,
    close: () => {},
    custom,
    send: (data: Uint8Array) => {
      try {
        const dec = decoding.createDecoder(data);
        if (decoding.readVarUint(dec) === MESSAGE_CUSTOM) {
          custom.push(JSON.parse(decoding.readVarString(dec)));
        }
      } catch {
        /* non-custom frame (sync / awareness) — ignore */
      }
    },
  };
}

const profileEvents = (ws: any): any[] =>
  ws.custom.filter((m: any) => m && m.type === "profile_event");

function storedUser(projectId: string, clientId: number): any {
  return collaborationManager
    .getRoom(projectId)!
    .awareness.getStates()
    .get(clientId)?.user;
}

function seedUser(db: Db, id: number, username: string): void {
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'h')").run(
    id,
    username,
  );
}

describe("M62-3 — effective display identity through collaboration", () => {
  let db: Db;
  let cfg: any;
  let tmp: string;
  const roomIds: string[] = [];

  const room = (projectId: string) => {
    if (!roomIds.includes(projectId)) roomIds.push(projectId);
    return collaborationManager.getOrCreateRoom(projectId);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m62-3-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    collaborationManager.init(cfg, db);
    seedUser(db, 1, "alice");
    seedUser(db, 2, "bob");
    seedUser(db, 3, "carol");
    seedUser(db, 4, "dave");
  });

  afterEach(() => {
    for (const id of roomIds.splice(0)) {
      try {
        collaborationManager.getRoom(id)?.dispose();
      } catch {}
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // --- awareness identity ------------------------------------------------

  it("awareness user carries server-resolved displayName AND the technical username", async () => {
    updateProfile(db, 1, { displayName: "Alice Liddell" });
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(ws, awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]));

    const u = storedUser("p1", 10);
    expect(u.id).toBe(1);
    expect(u.name).toBe("alice"); // immutable technical username, unchanged
    expect(u.displayName).toBe("Alice Liddell"); // effective display name
    expect(u.role).toBe("editor");
  });

  it("falls back to username when there is no profile / empty displayName", async () => {
    const r = room("p1");
    const wsNoRow = makeWs();
    await r.addClient(wsNoRow, { userId: 2, username: "bob", role: "editor" });
    r.handleMessage(wsNoRow, awarenessFrame([{ clientId: 20, clock: 1, state: { user: {} } }]));
    expect(storedUser("p1", 20).displayName).toBe("bob");

    updateProfile(db, 3, { pronouns: "she/her" }); // profile row, but no displayName
    const wsEmpty = makeWs();
    await r.addClient(wsEmpty, { userId: 3, username: "carol", role: "editor" });
    r.handleMessage(wsEmpty, awarenessFrame([{ clientId: 30, clock: 1, state: { user: {} } }]));
    expect(storedUser("p1", 30).displayName).toBe("carol");
  });

  it("a forged incoming user.displayName is dropped; server value wins", async () => {
    updateProfile(db, 1, { displayName: "Alice Liddell" });
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "viewer" });
    r.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 11,
          clock: 4,
          state: {
            user: { id: 999, name: "root", displayName: "Admin", role: "owner" },
          },
        },
      ]),
    );
    const u = storedUser("p1", 11);
    expect(u).toEqual({
      id: 1,
      name: "alice",
      displayName: "Alice Liddell",
      avatarVersion: 0,
      role: "viewer",
    });
    expect(u.displayName).not.toBe("Admin");
  });

  it("awareness-frame construction performs no profile DB read (cache only)", async () => {
    updateProfile(db, 1, { displayName: "Alice Liddell" });
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    // addClient already resolved + cached the name. From here on, any
    // getDisplayName call inside the awareness path is a bug.
    const spy = vi.spyOn(profileStore, "getDisplayName");
    try {
      for (let clock = 1; clock <= 5; clock++) {
        r.handleMessage(
          ws,
          awarenessFrame([{ clientId: 10, clock, state: { user: {} } }]),
        );
      }
      expect(spy).not.toHaveBeenCalled();
      expect(storedUser("p1", 10).displayName).toBe("Alice Liddell");
    } finally {
      spy.mockRestore();
    }
  });

  // --- room cache lifecycle -------------------------------------------------

  it("addClient populates cache; profile_event refreshes it; next frame reflects it", async () => {
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(ws, awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]));
    expect(storedUser("p1", 10).displayName).toBe("alice");

    updateProfile(db, 1, { displayName: "Alice Liddell" });
    collaborationManager.broadcastProfileEventForUser(1);

    // one profile_event delivered
    expect(profileEvents(ws)).toEqual([{ type: "profile_event", userId: 1 }]);
    // next awareness frame uses the refreshed cached value
    r.handleMessage(ws, awarenessFrame([{ clientId: 10, clock: 2, state: { user: {} } }]));
    expect(storedUser("p1", 10).displayName).toBe("Alice Liddell");
  });

  it("reconnect repopulates the cache from the current persisted profile", async () => {
    const r = room("p1");
    const ws1 = makeWs();
    await r.addClient(ws1, { userId: 1, username: "alice", role: "editor" });
    r.removeClient(ws1); // last client gone -> cache entry pruned

    updateProfile(db, 1, { displayName: "Reconnected Alice" });
    const ws2 = makeWs();
    await r.addClient(ws2, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(ws2, awarenessFrame([{ clientId: 12, clock: 1, state: { user: {} } }]));
    expect(storedUser("p1", 12).displayName).toBe("Reconnected Alice");
  });

  // --- targeted invalidation ---------------------------------------------

  it("R1:{A,B} R2:{C} R3:{A,D} — profile update for A hits only R1 and R3", async () => {
    updateProfile(db, 1, { displayName: "Alice v1" });
    const r1 = room("R1");
    const r2 = room("R2");
    const r3 = room("R3");
    const a1 = makeWs();
    const b1 = makeWs();
    const c2 = makeWs();
    const a3 = makeWs();
    const d3 = makeWs();
    await r1.addClient(a1, { userId: 1, username: "alice", role: "editor" });
    await r1.addClient(b1, { userId: 2, username: "bob", role: "editor" });
    await r2.addClient(c2, { userId: 3, username: "carol", role: "editor" });
    await r3.addClient(a3, { userId: 1, username: "alice", role: "editor" });
    await r3.addClient(d3, { userId: 4, username: "dave", role: "editor" });

    updateProfile(db, 1, { displayName: "Alice v2" });
    collaborationManager.broadcastProfileEventForUser(1);

    // R1: exactly one profile_event for A, to every client in the room
    expect(profileEvents(a1)).toEqual([{ type: "profile_event", userId: 1 }]);
    expect(profileEvents(b1)).toEqual([{ type: "profile_event", userId: 1 }]);
    // R3: same
    expect(profileEvents(a3)).toEqual([{ type: "profile_event", userId: 1 }]);
    expect(profileEvents(d3)).toEqual([{ type: "profile_event", userId: 1 }]);
    // R2: nothing — A is not there
    expect(profileEvents(c2)).toEqual([]);

    // B and D can now observe A's refreshed identity via a fresh A frame
    r1.handleMessage(a1, awarenessFrame([{ clientId: 100, clock: 1, state: { user: {} } }]));
    r3.handleMessage(a3, awarenessFrame([{ clientId: 300, clock: 1, state: { user: {} } }]));
    expect(storedUser("R1", 100).displayName).toBe("Alice v2");
    expect(storedUser("R3", 300).displayName).toBe("Alice v2");
  });

  it("user in zero rooms -> silent no-op, no throw", async () => {
    room("R1");
    room("R2");
    expect(() =>
      collaborationManager.broadcastProfileEventForUser(1),
    ).not.toThrow();
  });

  it("an unrelated user's update never reaches peers who merely share a room", async () => {
    const r = room("p1");
    const a = makeWs();
    const b = makeWs();
    await r.addClient(a, { userId: 1, username: "alice", role: "editor" });
    await r.addClient(b, { userId: 2, username: "bob", role: "editor" });

    updateProfile(db, 3, { displayName: "Carol" }); // carol is in NO room
    collaborationManager.broadcastProfileEventForUser(3);

    expect(profileEvents(a)).toEqual([]);
    expect(profileEvents(b)).toEqual([]);
  });

  it("multiple sockets for the same user in one room -> one room event per client, not duplicated", async () => {
    const r = room("p1");
    const tab1 = makeWs();
    const tab2 = makeWs();
    await r.addClient(tab1, { userId: 1, username: "alice", role: "editor" });
    await r.addClient(tab2, { userId: 1, username: "alice", role: "editor" });

    updateProfile(db, 1, { displayName: "Alice" });
    collaborationManager.broadcastProfileEventForUser(1);

    // each socket receives the room broadcast exactly once
    expect(profileEvents(tab1)).toEqual([{ type: "profile_event", userId: 1 }]);
    expect(profileEvents(tab2)).toEqual([{ type: "profile_event", userId: 1 }]);
  });

  it("repeated updates each produce exactly one round of events", async () => {
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });

    updateProfile(db, 1, { displayName: "One" });
    collaborationManager.broadcastProfileEventForUser(1);
    updateProfile(db, 1, { displayName: "Two" });
    collaborationManager.broadcastProfileEventForUser(1);

    expect(profileEvents(ws)).toEqual([
      { type: "profile_event", userId: 1 },
      { type: "profile_event", userId: 1 },
    ]);
    r.handleMessage(ws, awarenessFrame([{ clientId: 9, clock: 1, state: { user: {} } }]));
    expect(storedUser("p1", 9).displayName).toBe("Two");
  });

  // --- transport security -----------------------------------------------

  it("an inbound client profile_event mutates nothing and is not rebroadcast", async () => {
    updateProfile(db, 1, { displayName: "Alice Liddell" });
    const r = room("p1");
    const attacker = makeWs();
    const peer = makeWs();
    await r.addClient(attacker, { userId: 2, username: "bob", role: "editor" });
    await r.addClient(peer, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(peer, awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]));

    r.handleMessage(
      attacker,
      customFrame({ type: "profile_event", userId: 1, displayName: "PWNED" }),
    );

    // no profile_event was fanned out to anyone
    expect(profileEvents(peer)).toEqual([]);
    expect(profileEvents(attacker)).toEqual([]);
    // cached / awareness identity unchanged
    expect(storedUser("p1", 10).displayName).toBe("Alice Liddell");
  });

  it("the profile_event packet is exactly {type, userId}", async () => {
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    updateProfile(db, 1, { displayName: "Alice" });
    collaborationManager.broadcastProfileEventForUser(1);
    expect(profileEvents(ws)).toHaveLength(1);
    expect(Object.keys(profileEvents(ws)[0]).sort()).toEqual(["type", "userId"]);
  });

  // --- REST collaborator roster ----------------------------------------

  it("roster displayName = effective name (username fallback, explicit name, cleared -> username)", () => {
    db.prepare("INSERT INTO projects (id, owner_id, name) VALUES ('proj', 1, 'P')").run();
    db.prepare(
      "INSERT INTO project_collaborators (project_id, user_id, role) VALUES ('proj', 2, 'editor'), ('proj', 3, 'viewer'), ('proj', 4, 'editor')",
    ).run();

    updateProfile(db, 3, { displayName: "Carol Danvers" });
    updateProfile(db, 4, { displayName: "temp" });
    updateProfile(db, 4, { displayName: null }); // cleared

    const roster = listProjectCollaborators(db, "proj");
    const byName = Object.fromEntries(roster.map((c) => [c.username, c]));

    expect(byName.bob.displayName).toBe("bob"); // no profile row
    expect(byName.carol.displayName).toBe("Carol Danvers"); // explicit
    expect(byName.dave.displayName).toBe("dave"); // cleared -> username

    // technical identity intact, no dormant profile columns leaked
    expect(Object.keys(byName.carol).sort()).toEqual(
      [
        "avatarVersion",
        "createdAt",
        "displayName",
        "role",
        "userId",
        "username",
      ].sort(),
    );
    expect(byName.carol.avatarVersion).toBe(0);
  });
});
