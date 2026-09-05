import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// M63 — Unified connection & sync-state visibility.
//
// This file: the real post-reconnect `resynchronizing` phase and pending
// local Yjs update accounting. (Reconnect grace + ceiling + retry live in
// collab.reconnect.test.ts.)
//
// Convention mirrors collab.explicitDisposalReset.test.ts: real
// yjs/y-protocols/lib0, a bare FakeWebSocket, y-monaco + monacoSetup stubbed
// (this file never binds a model, so the stubs are inert).
vi.mock("../src/monacoSetup", () => ({ monaco: {} }));
vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    constructor() {}
    destroy() {}
  },
}));

import { CollaborationClient } from "../src/collab/client";

const MESSAGE_SYNC = 0;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
  }

  send(data: ArrayBufferLike): void {
    this.sent.push(new Uint8Array(data as ArrayBuffer));
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: Uint8Array): void {
    const copy = new Uint8Array(data);
    this.onmessage?.({ data: copy.buffer } as any);
  }

  simulateClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as any);
  }

  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

// The exact SyncStep1 -> SyncStep2 exchange backend/src/collab/manager.ts
// performs, reused unmocked.
function serverReplyToSyncStep1(
  serverDoc: Y.Doc,
  syncStep1Message: Uint8Array,
): Uint8Array {
  const decoder = decoding.createDecoder(syncStep1Message);
  decoding.readVarUint(decoder); // consume MESSAGE_SYNC envelope tag
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, serverDoc, "fake-server");
  return encoding.toUint8Array(encoder);
}

const USER = { id: 1, username: "alice", role: "editor" } as any;

/** Drive the current client (via its latest fake socket) through: first
 *  connect -> ordinary blip close -> reconnect open. Returns the reconnect
 *  socket. Leaves status at `resynchronizing`. */
function reconnectLatest(): FakeWebSocket {
  const first = FakeWebSocket.latest();
  first.simulateOpen();
  first.simulateClose(1006);
  vi.advanceTimersByTime(2000); // let scheduleReconnect's timer fire connect()
  const second = FakeWebSocket.latest();
  second.simulateOpen();
  return second;
}

describe("CollaborationClient — M63 resynchronizing state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("first connect goes straight to connected, never resynchronizing", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    expect(client.status).toBe("connected");
    client.dispose();
  });

  it("enters resynchronizing on a reconnect open, before the server SyncStep2", () => {
    const client = new CollaborationClient("p", USER);
    const ws2 = reconnectLatest();
    expect(client.status).toBe("resynchronizing");
    expect(ws2.sent.length).toBeGreaterThan(0); // it did send its SyncStep1
    client.dispose();
  });

  it("leaves resynchronizing for connected only when the server SyncStep2 arrives", () => {
    const client = new CollaborationClient("p", USER);
    const ws2 = reconnectLatest();
    expect(client.status).toBe("resynchronizing");

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "server content");
    ws2.simulateMessage(serverReplyToSyncStep1(serverDoc, ws2.sent[0]));

    expect(client.status).toBe("connected");
    client.dispose();
  });

  it("force-completes resynchronizing after RESYNC_TIMEOUT_MS if SyncStep2 never arrives", () => {
    const client = new CollaborationClient("p", USER);
    reconnectLatest();
    expect(client.status).toBe("resynchronizing");
    vi.advanceTimersByTime(10_000);
    expect(client.status).toBe("connected");
    client.dispose();
  });

  it("emits connection_change for the resynchronizing transition", () => {
    const client = new CollaborationClient("p", USER);
    const seen: string[] = [];
    client.on("connection_change", (s: string) => seen.push(s));
    const ws2 = reconnectLatest();
    ws2.simulateMessage(serverReplyToSyncStep1(new Y.Doc(), ws2.sent[0]));
    expect(seen).toContain("resynchronizing");
    expect(seen.indexOf("resynchronizing")).toBeLessThan(
      seen.lastIndexOf("connected"),
    );
    client.dispose();
  });

  it("dispose() clears the resync timer", () => {
    const client = new CollaborationClient("p", USER);
    reconnectLatest(); // arms the resync timer
    client.dispose();
    expect((client as any).resyncTimer).toBeNull();
  });
});

describe("CollaborationClient — M63 pending local update accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("counts a local Yjs update made while the transport is down as pending", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    FakeWebSocket.latest().simulateClose(1006);

    const counts: number[] = [];
    client.on("pending_updates_change", (n: number) => counts.push(n));

    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "offline edit");
    }, "local-edit");

    expect(client.pendingLocalUpdates).toBe(1);
    expect(counts).toEqual([1]);
    client.dispose();
  });

  it("does not count a remote Yjs update as a pending local update", () => {
    const client = new CollaborationClient("p", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "remote peer content");
    ws1.simulateMessage(serverReplyToSyncStep1(serverDoc, ws1.sent[0]));

    expect(client.doc.getText("main.py").toString()).toBe("remote peer content");
    expect(client.pendingLocalUpdates).toBe(0);
    client.dispose();
  });

  it("does not count a local update as pending while the transport is open", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();

    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "online edit");
    }, "local-edit");

    expect(client.pendingLocalUpdates).toBe(0);
    client.dispose();
  });

  it("clears pending local updates to zero once resync actually completes", () => {
    const client = new CollaborationClient("p", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateClose(1006);

    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "edit one");
    }, "local-edit");
    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "edit two ");
    }, "local-edit");
    expect(client.pendingLocalUpdates).toBe(2);

    vi.advanceTimersByTime(2000);
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();
    expect(client.pendingLocalUpdates).toBe(2); // still pending during resync
    ws2.simulateMessage(serverReplyToSyncStep1(new Y.Doc(), ws2.sent[0]));

    expect(client.status).toBe("connected");
    expect(client.pendingLocalUpdates).toBe(0);
    client.dispose();
  });

  it("resets pending local updates when an explicit-disposal reset discards the lineage", () => {
    const client = new CollaborationClient("p", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateClose(1006);
    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "doomed edit");
    }, "local-edit");
    expect(client.pendingLocalUpdates).toBe(1);

    vi.advanceTimersByTime(2000);
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage(serverReplyToSyncStep1(new Y.Doc(), ws2.sent[0]));
    expect(client.status).toBe("connected");
    ws2.simulateClose(1001); // explicit server disposal

    expect(client.pendingLocalUpdates).toBe(0);
    client.dispose();
  });
});
