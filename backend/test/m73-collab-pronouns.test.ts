import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import * as encoding from "lib0/encoding";
import { openDb, type Db } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { collaborationManager } from "../src/collab/manager.js";
import * as profileStore from "../src/profile/store.js";
import { updateProfile } from "../src/profile/store.js";

const MESSAGE_AWARENESS = 1;

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

function makeWs(): any {
  return { readyState: 1, close: () => {}, send: () => {} };
}

function storedUser(projectId: string, clientId: number): any {
  return collaborationManager
    .getRoom(projectId)!
    .awareness.getStates()
    .get(clientId)?.user;
}

describe("M73 — collaborator pronouns through presence identity", () => {
  let db: Db;
  let cfg: any;
  let tmp: string;
  const roomIds: string[] = [];

  const room = (projectId: string) => {
    if (!roomIds.includes(projectId)) roomIds.push(projectId);
    return collaborationManager.getOrCreateRoom(projectId);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m73-pronouns-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    collaborationManager.init(cfg, db);
    db.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES (1,'alice','h'),(2,'bob','h')",
    ).run();
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
    vi.restoreAllMocks();
  });

  it("carries no user.pronouns key when the user has none set", async () => {
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(
      ws,
      awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]),
    );
    expect("pronouns" in storedUser("p1", 10)).toBe(false);
  });

  it("a join after pronouns are set carries the sanitized value", async () => {
    updateProfile(db, 1, { pronouns: "  she/her  " });
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(
      ws,
      awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]),
    );
    expect(storedUser("p1", 10).pronouns).toBe("she/her");
  });

  it("a targeted profile_event refreshes the cached pronouns in place", async () => {
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(
      ws,
      awarenessFrame([{ clientId: 10, clock: 1, state: { user: {} } }]),
    );
    expect("pronouns" in storedUser("p1", 10)).toBe(false);

    updateProfile(db, 1, { pronouns: "they/them" });
    collaborationManager.broadcastProfileEventForUser(1);

    r.handleMessage(
      ws,
      awarenessFrame([{ clientId: 10, clock: 2, state: { user: {} } }]),
    );
    expect(storedUser("p1", 10).pronouns).toBe("they/them");
  });

  it("a forged incoming user.pronouns is discarded", async () => {
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(
      ws,
      awarenessFrame([
        {
          clientId: 11,
          clock: 1,
          state: { user: { pronouns: "admin/root", id: 42 } },
        },
      ]),
    );
    expect("pronouns" in storedUser("p1", 11)).toBe(false);
    expect(storedUser("p1", 11).id).toBe(1);
  });

  it("the awareness frame path performs no getPronouns DB read", async () => {
    updateProfile(db, 1, { pronouns: "she/her" });
    const r = room("p1");
    const ws = makeWs();
    await r.addClient(ws, { userId: 1, username: "alice", role: "editor" });
    const spy = vi.spyOn(profileStore, "getPronouns");
    for (let clock = 1; clock <= 5; clock++) {
      r.handleMessage(
        ws,
        awarenessFrame([{ clientId: 10, clock, state: { user: {} } }]),
      );
    }
    expect(spy).not.toHaveBeenCalled();
    expect(storedUser("p1", 10).pronouns).toBe("she/her");
  });

  it("the cache repopulates from the current profile on reconnect", async () => {
    const r = room("p1");
    const ws1 = makeWs();
    await r.addClient(ws1, { userId: 1, username: "alice", role: "editor" });
    r.removeClient(ws1);

    updateProfile(db, 1, { pronouns: "xe/xem" });
    const ws2 = makeWs();
    await r.addClient(ws2, { userId: 1, username: "alice", role: "editor" });
    r.handleMessage(
      ws2,
      awarenessFrame([{ clientId: 12, clock: 1, state: { user: {} } }]),
    );
    expect(storedUser("p1", 12).pronouns).toBe("xe/xem");
  });
});
