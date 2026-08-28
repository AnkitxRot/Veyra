import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  CollaborationRoom,
  DEFAULT_YJS_COALESCE_MS,
  DEFAULT_AWARENESS_COALESCE_MS,
  DEFAULT_HIGH_WATERMARK_BYTES,
  DEFAULT_LOW_WATERMARK_BYTES,
} from "../src/collab/manager.js";
import { createProject } from "../src/projects/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** A WebSocket-shaped mock whose bufferedAmount the test controls directly,
 *  and whose send() is a spy so physical broadcast counts are observable. */
function makeControllableWs(initialBufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount: initialBufferedAmount,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function buildSyncUpdateFrame(clientDoc: Y.Doc, mutate: () => void) {
  let update: Uint8Array | null = null;
  const capture = (u: Uint8Array) => {
    update = u;
  };
  clientDoc.on("update", capture);
  mutate();
  clientDoc.off("update", capture);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update!);
  return encoding.toUint8Array(encoder);
}

// M55: the server now rebuilds every inbound awareness state — identity is
// forced to the authenticated session and unknown top-level fields are
// dropped — so a test frame must carry its payload in a real, allowlisted
// ephemeral field (here: `cursor`) rather than smuggling arbitrary keys
// under `user`. The coalescing behaviour under test is unchanged.
function buildAwarenessFrame(
  clientAwareness: awarenessProtocol.Awareness,
  fields: Record<string, unknown>,
) {
  clientAwareness.setLocalState({
    ...(clientAwareness.getLocalState() ?? {}),
    ...fields,
  });
  const update = awarenessProtocol.encodeAwarenessUpdate(clientAwareness, [
    clientAwareness.clientID,
  ]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Applies whatever the room actually sent to `ws.send` onto a real client
 *  doc/awareness, exactly like a genuine browser client would — used to
 *  prove eventual convergence, not just "send was called". */
function applyServerMessage(
  message: Uint8Array,
  clientDoc: Y.Doc,
  clientAwareness?: awarenessProtocol.Awareness,
): void {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, clientDoc, "test-client");
    // Ignore any reply the client would send back — these tests only care
    // about what the room delivered, not the client's own outbound traffic.
  } else if (messageType === MESSAGE_AWARENESS && clientAwareness) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(
      clientAwareness,
      update,
      "test-client",
    );
  }
}

function setup() {
  const tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m6-test-"));
  const tempDataDir = mkdtempSync(join(tmpdir(), "cloudide-m6-data-"));
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("m6owner", "h", "user"); // id 1, the owner every test's createProject() uses
  const cfg = {
    ...resolveConfig(),
    workspacesDir: tempWorkspacesDir,
    dataDir: tempDataDir,
  } as any;
  return {
    db,
    cfg,
    cleanup: () => {
      try {
        rmSync(tempWorkspacesDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(tempDataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("M6 collaboration broadcast coalescing + backpressure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // --- A. Yjs coalescing ---------------------------------------------------

  it("A. multiple Yjs updates inside the coalesce window collapse into one physical send, and the observer converges exactly", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, { name: "coalesceA" });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});
      const filePath = "shared.py";

      const typerDoc = new Y.Doc();
      const typerWs = makeControllableWs();
      await room.addClient(typerWs as any, {
        userId: 1,
        username: "typer",
        role: "editor",
      });

      const observerDoc = new Y.Doc();
      const observerWs = makeControllableWs();
      await room.addClient(observerWs as any, {
        userId: 2,
        username: "observer",
        role: "editor",
      });
      observerWs.send.mockClear(); // drop the handshake Step1/Step2 call

      vi.useFakeTimers();
      const text = typerDoc.getText(filePath);
      const keystrokes = ["p", "r", "i", "n", "t", "(", "1", ")"];
      for (const ch of keystrokes) {
        room.handleMessage(
          typerWs as any,
          buildSyncUpdateFrame(typerDoc, () => text.insert(text.length, ch)),
        );
      }
      // All 8 keystrokes were queued inside the same window — nothing sent
      // to the observer yet.
      expect(observerWs.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);

      // Exactly one physical send delivered all 8 keystrokes' operations.
      expect(observerWs.send).toHaveBeenCalledTimes(1);
      applyServerMessage(
        observerWs.send.mock.calls[0][0] as Uint8Array,
        observerDoc,
      );
      expect(observerDoc.getText(filePath).toString()).toBe("print(1)");
      expect(observerDoc.getText(filePath).toString()).toBe(
        room.doc.getText(filePath).toString(),
      );

      room.dispose();
    } finally {
      cleanup();
    }
  });

  it("A2. coalesced delivery matches the non-coalesced result bit-for-bit (no operations lost by merging)", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, { name: "coalesceA2" });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});
      const filePath = "f.txt";

      const doc = new Y.Doc();
      const ws = makeControllableWs();
      await room.addClient(ws as any, {
        userId: 1,
        username: "u",
        role: "editor",
      });

      const observerDoc = new Y.Doc();
      const observerWs = makeControllableWs();
      await room.addClient(observerWs as any, {
        userId: 2,
        username: "o",
        role: "editor",
      });
      observerWs.send.mockClear();

      vi.useFakeTimers();
      const text = doc.getText(filePath);
      room.handleMessage(
        ws as any,
        buildSyncUpdateFrame(doc, () => text.insert(0, "AAA")),
      );
      room.handleMessage(
        ws as any,
        buildSyncUpdateFrame(doc, () => text.insert(3, "BBB")),
      );
      room.handleMessage(
        ws as any,
        buildSyncUpdateFrame(doc, () => text.delete(1, 2)),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);

      expect(observerWs.send).toHaveBeenCalledTimes(1);
      applyServerMessage(
        observerWs.send.mock.calls[0][0] as Uint8Array,
        observerDoc,
      );
      // Independently reproduce the same three edits against a fresh doc,
      // uncoalesced (three real applyUpdate calls), and compare final text —
      // this is the "equals the non-coalesced result" proof, not just
      // "converged to whatever the room has".
      const referenceDoc = new Y.Doc();
      const t = referenceDoc.getText(filePath);
      t.insert(0, "AAA");
      t.insert(3, "BBB");
      t.delete(1, 2);
      expect(observerDoc.getText(filePath).toString()).toBe(t.toString());
      expect(room.doc.getText(filePath).toString()).toBe(t.toString());

      room.dispose();
    } finally {
      cleanup();
    }
  });

  // --- B. Awareness coalescing ---------------------------------------------

  it("B. rapid awareness changes collapse into one send carrying the latest state", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, { name: "coalesceB" });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});

      const senderDoc = new Y.Doc();
      const senderAwareness = new awarenessProtocol.Awareness(senderDoc);
      const senderWs = makeControllableWs();
      await room.addClient(senderWs as any, {
        userId: 1,
        username: "sender",
        role: "editor",
      });

      const observerWs = makeControllableWs();
      await room.addClient(observerWs as any, {
        userId: 2,
        username: "observer",
        role: "editor",
      });
      observerWs.send.mockClear();

      vi.useFakeTimers();
      for (let line = 1; line <= 5; line++) {
        room.handleMessage(
          senderWs as any,
          buildAwarenessFrame(senderAwareness, {
            cursor: { line, column: 1 },
          }),
        );
      }
      expect(observerWs.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEFAULT_AWARENESS_COALESCE_MS);

      expect(observerWs.send).toHaveBeenCalledTimes(1);
      const observerAwareness = new awarenessProtocol.Awareness(new Y.Doc());
      applyServerMessage(
        observerWs.send.mock.calls[0][0] as Uint8Array,
        new Y.Doc(),
        observerAwareness,
      );
      const state = observerAwareness.getStates().get(senderAwareness.clientID);
      expect((state as any).cursor.line).toBe(5); // latest, not first
      // M55: identity is server-stamped, never the client's to choose.
      expect((state as any).user).toMatchObject({ id: 1, name: "sender" });

      room.dispose();
    } finally {
      cleanup();
    }
  });

  // --- C. Backpressure ------------------------------------------------------

  it("C. a slow socket stops receiving awareness first, while Yjs updates and other clients are unaffected", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, {
        name: "backpressureC",
      });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});

      const typerDoc = new Y.Doc();
      const typerWs = makeControllableWs();
      await room.addClient(typerWs as any, {
        userId: 1,
        username: "typer",
        role: "editor",
      });

      // Above the awareness cutoff (half the high watermark) but below the
      // full Yjs high watermark.
      const slowWs = makeControllableWs(DEFAULT_HIGH_WATERMARK_BYTES / 2 + 1);
      await room.addClient(slowWs as any, {
        userId: 2,
        username: "slow",
        role: "editor",
      });
      const normalWs = makeControllableWs();
      await room.addClient(normalWs as any, {
        userId: 3,
        username: "normal",
        role: "editor",
      });
      slowWs.send.mockClear();
      normalWs.send.mockClear();

      vi.useFakeTimers();

      // Awareness: the slow socket must NOT receive it; the normal socket
      // must.
      room.handleMessage(
        typerWs as any,
        buildAwarenessFrame(new awarenessProtocol.Awareness(typerDoc), {
          cursor: { line: 1, column: 1 },
        }),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_AWARENESS_COALESCE_MS);
      expect(slowWs.send).not.toHaveBeenCalled();
      expect(normalWs.send).toHaveBeenCalledTimes(1);

      // Yjs update: the same slow socket (still under the FULL watermark)
      // must still receive it — awareness is cut off first, Yjs isn't yet.
      const text = typerDoc.getText("f.py");
      room.handleMessage(
        typerWs as any,
        buildSyncUpdateFrame(typerDoc, () => text.insert(0, "x")),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);
      expect(slowWs.send).toHaveBeenCalledTimes(1);
      expect(normalWs.send).toHaveBeenCalledTimes(2);

      room.dispose();
    } finally {
      cleanup();
    }
  });

  it("C2. a socket over the full Yjs high watermark stops receiving Yjs broadcasts too, without blocking other clients or growing an unbounded per-client queue", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, {
        name: "backpressureC2",
      });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});

      const typerDoc = new Y.Doc();
      const typerWs = makeControllableWs();
      await room.addClient(typerWs as any, {
        userId: 1,
        username: "typer",
        role: "editor",
      });

      const deadSlowWs = makeControllableWs(DEFAULT_HIGH_WATERMARK_BYTES + 1);
      await room.addClient(deadSlowWs as any, {
        userId: 2,
        username: "deadslow",
        role: "editor",
      });
      const normalWs = makeControllableWs();
      await room.addClient(normalWs as any, {
        userId: 3,
        username: "normal",
        role: "editor",
      });
      deadSlowWs.send.mockClear();
      normalWs.send.mockClear();

      vi.useFakeTimers();
      const text = typerDoc.getText("f.py");
      // Several edits while the slow client stays maxed out — proves no
      // per-client array grows without bound: nothing about this loop's
      // cost depends on how many edits happen while the client is slow,
      // since sendYjsBroadcast only ever does an O(1) bufferedAmount check
      // and returns, storing nothing.
      for (let i = 0; i < 20; i++) {
        room.handleMessage(
          typerWs as any,
          buildSyncUpdateFrame(typerDoc, () => text.insert(text.length, "a")),
        );
        await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);
      }

      // The slow client received NOTHING throughout — never blocked the
      // normal client, which received all 20 coalesced flushes.
      expect(deadSlowWs.send).not.toHaveBeenCalled();
      expect(normalWs.send).toHaveBeenCalledTimes(20);

      room.dispose();
    } finally {
      cleanup();
    }
  });

  // --- D. Recovery ----------------------------------------------------------

  it("D. once bufferedAmount drops to the low watermark, the recovered client gets a full-document catch-up and converges", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, { name: "recoveryD" });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});
      const filePath = "f.py";

      const typerDoc = new Y.Doc();
      const typerWs = makeControllableWs();
      await room.addClient(typerWs as any, {
        userId: 1,
        username: "typer",
        role: "editor",
      });

      const slowWs = makeControllableWs(DEFAULT_HIGH_WATERMARK_BYTES + 1);
      await room.addClient(slowWs as any, {
        userId: 2,
        username: "slow",
        role: "editor",
      });
      slowWs.send.mockClear();

      vi.useFakeTimers();
      const text = typerDoc.getText(filePath);
      room.handleMessage(
        typerWs as any,
        buildSyncUpdateFrame(typerDoc, () => text.insert(0, "print(1)")),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);
      // Confirmed backpressured: nothing delivered while over the watermark.
      expect(slowWs.send).not.toHaveBeenCalled();

      // Recover: buffer drains below the low watermark. Advance past the
      // recheck interval (500ms) for the room to notice.
      slowWs.bufferedAmount = DEFAULT_LOW_WATERMARK_BYTES - 1;
      await vi.advanceTimersByTimeAsync(600);

      // sendCatchUp() issues two physical sends: the full-document Yjs
      // catch-up, then a separate awareness snapshot (the room's own
      // Awareness instance always has a non-empty baseline state for
      // doc.clientID, so awareness.getStates().size > 0 even with no real
      // peers connected).
      expect(slowWs.send).toHaveBeenCalledTimes(2);
      const decoder = decoding.createDecoder(
        slowWs.send.mock.calls[0][0] as Uint8Array,
      );
      expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
      const recoveredDoc = new Y.Doc();
      applyServerMessage(
        slowWs.send.mock.calls[0][0] as Uint8Array,
        recoveredDoc,
      );
      // The catch-up carried the FULL document, not just what was missed
      // since backpressure started — this client had nothing at all before.
      expect(recoveredDoc.getText(filePath).toString()).toBe("print(1)");
      expect(recoveredDoc.getText(filePath).toString()).toBe(
        room.doc.getText(filePath).toString(),
      );

      room.dispose();
    } finally {
      cleanup();
    }
  });

  it("D2. disconnecting a backpressured client cancels its recovery tracking and leaves no dangling timers", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, { name: "recoveryD2" });
      const room = new CollaborationRoom(project.id, cfg, db, () => {});

      const typerDoc = new Y.Doc();
      const typerWs = makeControllableWs();
      await room.addClient(typerWs as any, {
        userId: 1,
        username: "typer",
        role: "editor",
      });
      const slowWs = makeControllableWs(DEFAULT_HIGH_WATERMARK_BYTES + 1);
      await room.addClient(slowWs as any, {
        userId: 2,
        username: "slow",
        role: "editor",
      });

      vi.useFakeTimers();
      const text = typerDoc.getText("f.py");
      room.handleMessage(
        typerWs as any,
        buildSyncUpdateFrame(typerDoc, () => text.insert(0, "x")),
      );
      // This marks slowWs backpressured, which arms the recheck interval —
      // a real pending timer at this point.
      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);

      room.removeClient(slowWs as any);
      room.dispose();

      // dispose() clears every timer this room ever armed (debounce,
      // max-flush, idle-dispose, yjs/awareness coalesce, slow-client
      // recheck) — nothing should still be scheduled.
      expect(vi.getTimerCount()).toBe(0);

      typerDoc.destroy();
    } finally {
      cleanup();
    }
  });

  // --- F. Handshake is never coalesced or backpressured --------------------

  it("F. the initial sync handshake is sent immediately, even with a huge coalesce window and an already-overloaded socket", async () => {
    const { db, cfg, cleanup } = setup();
    try {
      const project = await createProject(cfg, db, 1, { name: "handshakeF" });
      // A deliberately huge window: if the handshake were ever routed
      // through the coalescer, it would never arrive within this test.
      const room = new CollaborationRoom(project.id, cfg, db, () => {}, {
        yjsCoalesceMs: 10_000_000,
        awarenessCoalesceMs: 10_000_000,
      });

      // Already far over the high watermark before it even joins.
      const overloadedWs = makeControllableWs(
        DEFAULT_HIGH_WATERMARK_BYTES * 10,
      );

      vi.useFakeTimers();
      await room.addClient(overloadedWs as any, {
        userId: 1,
        username: "u",
        role: "editor",
      });

      // Sync Step 1 sent synchronously by addClient — no timer advance at
      // all, and this client is already "overloaded", proving handshake
      // delivery bypasses both coalescing and backpressure entirely.
      // addClient() also sends a second, separate message: the room's
      // baseline awareness snapshot (its own Awareness instance always has
      // a non-empty state for doc.clientID). Both are unconditional
      // handshake sends, neither routed through the coalescer/backpressure.
      expect(overloadedWs.send).toHaveBeenCalledTimes(2);
      const decoder = decoding.createDecoder(
        overloadedWs.send.mock.calls[0][0] as Uint8Array,
      );
      expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);

      room.dispose();
    } finally {
      cleanup();
    }
  });
});
