import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { openDb, type Db } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationRoom } from "../src/collab/manager.js";
import { CollaborationHistorian } from "../src/collab/historian.js";

const MESSAGE_CUSTOM = 3;

/** A MESSAGE_SYNC(update) frame carrying a fresh local doc's full state. */
function editFrame(mutate: (d: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  mutate(doc);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}

/** A MESSAGE_SYNC(step2) frame — a client re-seeding the room from its lineage. */
function syncStep2Frame(mutate: (d: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  mutate(doc);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
  syncProtocol.writeSyncStep2(enc, doc);
  return encoding.toUint8Array(enc);
}

function makeWs() {
  const sent: Uint8Array[] = [];
  return {
    readyState: 1,
    send: (d: Uint8Array) => sent.push(d),
    close: () => {},
    sent,
  } as unknown as WebSocket & { sent: Uint8Array[] };
}

function customMessages(
  ws: { sent: Uint8Array[] },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const buf of ws.sent) {
    try {
      const dec = decoding.createDecoder(buf);
      if (decoding.readVarUint(dec) !== MESSAGE_CUSTOM) continue;
      out.push(JSON.parse(decoding.readVarString(dec)));
    } catch {
      /* not a JSON custom frame */
    }
  }
  return out;
}

type RoomCfg = Parameters<CollaborationHistorian["init"]>[1];

function freshHistorian(db: Db, cfg: RoomCfg): CollaborationHistorian {
  const Ctor = CollaborationHistorian as unknown as {
    new (): CollaborationHistorian;
  };
  const h = new Ctor();
  h.init(db, cfg);
  h.setBroadcaster((_pid, ev) =>
    roomRef?.broadcastCollabChange(
      ev as unknown as Record<string, unknown>,
    ),
  );
  return h;
}

let roomRef: CollaborationRoom | null = null;

describe("M60 room attribution", () => {
  let db: Db;
  let cfg: RoomCfg & { workspacesDir: string; dataDir: string };
  let tmp: string;
  let room: CollaborationRoom;
  let h: CollaborationHistorian;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "m60-room-"));
    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO users (id,username,password_hash) VALUES (7,'rahul','h'),(8,'ankit','h'),(9,'viewer','h')",
    ).run();
    db.prepare(
      "INSERT INTO projects (id,owner_id,name) VALUES ('p',7,'P')",
    ).run();
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    mkdirSync(join(tmp, "p"), { recursive: true });
    h = freshHistorian(db, cfg);
    room = new CollaborationRoom("p", cfg, db, () => {}, {}, h);
    roomRef = room;
  });

  afterEach(() => {
    room.dispose();
    h.stop();
    roomRef = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("attributes an edit to the authenticated user", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });
    room.handleMessage(
      ws,
      editFrame((d) => d.getText("a.ts").insert(0, "line1\nline2\n")),
    );
    room.dispose();
    h.flushQueue();
    const row = db
      .prepare("SELECT * FROM collaboration_changes WHERE file_path='a.ts'")
      .get() as { author_user_id: number; update_count: number } | undefined;
    expect(row?.author_user_id).toBe(7);
    expect(row!.update_count).toBeGreaterThanOrEqual(1);
  });

  it("a client re-seeding the room via sync-step-2 produces NO history (server-restart / reconnect)", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });
    // client had local content across several files; the fresh room doc has
    // none, so this step-2 integrates every struct as "new".
    room.handleMessage(
      ws,
      syncStep2Frame((d) => {
        d.getText("a.ts").insert(0, "prior a\n");
        d.getText("b.ts").insert(0, "prior b\n");
        d.getText("c.ts").insert(0, "prior c\n");
      }),
    );
    room.dispose();
    h.flushQueue();
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("an incremental edit AFTER a step-2 re-seed IS attributed", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });
    room.handleMessage(
      ws,
      syncStep2Frame((d) => d.getText("a.ts").insert(0, "prior\n")),
    );
    room.handleMessage(
      ws,
      editFrame((d) => d.getText("a.ts").insert(0, "now typing\n")),
    );
    room.dispose();
    h.flushQueue();
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) c FROM collaboration_changes WHERE author_user_id=7",
          )
          .get() as { c: number }
      ).c,
    ).toBe(1);
  });

  it("a sync frame that throws mid-apply does not leave attribution suppressed", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });

    // MESSAGE_SYNC + syncType=step2 (so the guard arms suppression) followed by
    // a truncated var-uint8-array length — readSyncMessage throws partway
    // through. The try/finally around it must still clear m60SuppressAttribution
    // so a later external_mutation/initial_disk_load transaction (which the M60
    // hook checks the flag BEFORE its own origin handling) still contaminates,
    // and a genuine edit is still recorded.
    const bad = encoding.createEncoder();
    encoding.writeVarUint(bad, 0 /* MESSAGE_SYNC */);
    encoding.writeVarUint(bad, 1 /* messageYjsSyncStep2 */);
    encoding.writeVarUint(bad, 9999 /* claims 9999 bytes that do not follow */);
    room.handleMessage(ws, encoding.toUint8Array(bad));

    // A genuine edit right after must still be attributed.
    room.handleMessage(
      ws,
      editFrame((d) => d.getText("a.ts").insert(0, "still recorded\n")),
    );
    room.dispose();
    h.flushQueue();
    const row = db
      .prepare(
        "SELECT COUNT(*) c FROM collaboration_changes WHERE author_user_id=7 AND file_path='a.ts'",
      )
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("a viewer edit produces no history", async () => {
    const ws = makeWs();
    await room.addClient(ws, {
      userId: 9,
      username: "viewer",
      role: "viewer",
    });
    room.handleMessage(
      ws,
      editFrame((d) => d.getText("a.ts").insert(0, "x")),
    );
    room.dispose();
    h.flushQueue();
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("external_mutation is never attributed as a change event", async () => {
    // A non-dirty file gets replaced externally (snapshot restore / git checkout
    // pattern). The Y.Text transaction runs under origin 'external_mutation' —
    // the M60 hook must record NO history row for it.
    writeFileSync(join(tmp, "p", "a.ts"), "disk\n");
    await room.handleExternalFileMutation("a.ts", "external replace\n");
    room.dispose();
    h.flushQueue();
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("an external write refused by the M56 conflict gate leaves the author's burst intact", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });
    writeFileSync(join(tmp, "p", "a.ts"), "disk\n");
    room.handleMessage(
      ws,
      editFrame((d) => d.getText("a.ts").insert(0, "typed by rahul\n")),
    );
    // file is now dirty -> external replace is REFUSED (conflict), Y.Text untouched
    const res = await room.handleExternalFileMutation("a.ts", "external\n");
    expect(res.conflict).toBe(true);
    room.dispose();
    h.flushQueue();
    const rows = db
      .prepare("SELECT * FROM collaboration_changes")
      .all() as Array<{ author_user_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].author_user_id).toBe(7);
  });

  it("removeClient closes that author's bursts; dispose closes all", async () => {
    const a = makeWs();
    const b = makeWs();
    await room.addClient(a, { userId: 7, username: "rahul", role: "editor" });
    await room.addClient(b, { userId: 8, username: "ankit", role: "editor" });
    room.handleMessage(
      a,
      editFrame((d) => d.getText("a.ts").insert(0, "a\n")),
    );
    room.handleMessage(
      b,
      editFrame((d) => d.getText("b.ts").insert(0, "b\n")),
    );
    room.removeClient(a);
    h.flushQueue();
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) c FROM collaboration_changes WHERE author_user_id=7",
          )
          .get() as { c: number }
      ).c,
    ).toBe(1);
    room.dispose();
    h.flushQueue();
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) c FROM collaboration_changes WHERE author_user_id=8",
          )
          .get() as { c: number }
      ).c,
    ).toBe(1);
  });

  it("broadcasts collab_change to clients in the room", async () => {
    const a = makeWs();
    const b = makeWs();
    await room.addClient(a, { userId: 7, username: "rahul", role: "editor" });
    await room.addClient(b, { userId: 8, username: "ankit", role: "editor" });
    room.handleMessage(
      a,
      editFrame((d) => d.getText("a.ts").insert(0, "a\n")),
    );
    room.removeClient(a);
    h.flushQueue();
    const msgs = customMessages(b);
    expect(
      msgs.some(
        (m) =>
          m.type === "collab_change" &&
          (m.actor as { userId: number }).userId === 7,
      ),
    ).toBe(true);
  });

  it("a multi-tab author keeping one socket open does NOT close bursts on the other's disconnect", async () => {
    const tab1 = makeWs();
    const tab2 = makeWs();
    await room.addClient(tab1, {
      userId: 7,
      username: "rahul",
      role: "editor",
    });
    await room.addClient(tab2, {
      userId: 7,
      username: "rahul",
      role: "editor",
    });
    room.handleMessage(
      tab1,
      editFrame((d) => d.getText("a.ts").insert(0, "x\n")),
    );
    room.removeClient(tab1); // tab2 still open
    h.flushQueue();
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as {
          c: number;
        }
      ).c,
    ).toBe(0); // burst still open, nothing persisted yet
    room.dispose();
    h.flushQueue();
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });
});
