import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb, type Db } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationRoom } from "../src/collab/manager.js";

/**
 * M61-A / M61-C — receive-only invalidation pings. `comment_event`,
 * `comment_mention` and `profile_event` are authored ONLY by the server
 * (they mirror `broadcastCollabChange`); a modified client cannot forge
 * comment/profile state onto its peers.
 */

const MESSAGE_CUSTOM = 3;

function makeWs() {
  const sent: Uint8Array[] = [];
  return {
    readyState: 1,
    send: (d: Uint8Array) => sent.push(d),
    close: () => {},
    sent,
  } as unknown as WebSocket & { sent: Uint8Array[] };
}

function customFrames(ws: { sent: Uint8Array[] }): Record<string, unknown>[] {
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

function lastCustom(ws: { sent: Uint8Array[] }): Record<string, unknown> {
  const frames = customFrames(ws);
  return frames[frames.length - 1];
}

function customFrame(obj: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc);
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("M61 — comment/profile invalidation transport", () => {
  let db: Db;
  let tmp: string;
  let room: CollaborationRoom;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "m61-transport-"));
    db = openDb(":memory:");
    db.prepare(
      "INSERT INTO users (id,username,password_hash) VALUES (1,'a','h'),(2,'b','h')",
    ).run();
    db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',1,'P')").run();
    const cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    mkdirSync(join(tmp, "p"), { recursive: true });
    room = new CollaborationRoom("p", cfg, db, () => {});
  });

  afterEach(() => {
    room.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("broadcastCommentEvent → every client; sendCommentMentionTo → target only", async () => {
    const a = makeWs();
    const b = makeWs();
    await room.addClient(a, { userId: 1, username: "a", role: "editor" });
    await room.addClient(b, { userId: 2, username: "b", role: "editor" });

    room.broadcastCommentEvent({
      threadId: "t1",
      filePath: "a.ts",
      kind: "created",
      at: 1,
    });
    expect(lastCustom(a).type).toBe("comment_event");
    expect(lastCustom(b).type).toBe("comment_event");

    room.sendCommentMentionTo(2, {
      threadId: "t1",
      commentId: "c1",
      filePath: "a.ts",
      line: 3,
      author: { userId: 1, username: "a" },
      preview: "look",
      at: 2,
    });
    expect(lastCustom(b).type).toBe("comment_mention");
    expect(customFrames(a).some((f) => f.type === "comment_mention")).toBe(false);
  });

  it("broadcastProfileEvent carries only {type,userId}", async () => {
    const a = makeWs();
    await room.addClient(a, { userId: 1, username: "a", role: "editor" });
    room.broadcastProfileEvent({ userId: 7 });
    expect(lastCustom(a)).toEqual({ type: "profile_event", userId: 7 });
  });

  it("a client cannot author any of these frames (server ignores unknown MESSAGE_CUSTOM types)", async () => {
    const a = makeWs();
    const b = makeWs();
    await room.addClient(a, { userId: 1, username: "a", role: "editor" });
    await room.addClient(b, { userId: 2, username: "b", role: "editor" });

    room.handleMessage(
      a as unknown as WebSocket,
      customFrame({ type: "comment_event", threadId: "forged", kind: "created" }),
    );
    room.handleMessage(
      a as unknown as WebSocket,
      customFrame({ type: "profile_event", userId: 999 }),
    );
    await tick();
    expect(
      customFrames(b).some(
        (f) => f.threadId === "forged" || f.userId === 999,
      ),
    ).toBe(false);
  });

  it("manager delegates route to the project's room", async () => {
    const { collaborationManager } = await import("../src/collab/manager.js");
    const a = makeWs();
    await room.addClient(a, { userId: 1, username: "a", role: "editor" });
    // The room created in beforeEach is standalone; assert the delegate is a
    // no-op (no room registered) rather than throwing.
    expect(() =>
      collaborationManager.broadcastCommentEvent("nonexistent", { kind: "x" }),
    ).not.toThrow();
    expect(() =>
      collaborationManager.broadcastProfileEvent("nonexistent", { userId: 1 }),
    ).not.toThrow();
    expect(() =>
      collaborationManager.sendCommentMentionTo("nonexistent", 1, { x: 1 }),
    ).not.toThrow();
  });
});
