import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// M63 — Unified connection & sync-state visibility.
//
// This file: the transient-blip grace before the first `disconnected` UI
// signal, the bounded reconnect ceiling, and the manual `retry()` path.
// (The resynchronizing phase + pending-update accounting live in
// collab.connectionState.test.ts.)
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

function serverReplyToSyncStep1(
  serverDoc: Y.Doc,
  syncStep1Message: Uint8Array,
): Uint8Array {
  const decoder = decoding.createDecoder(syncStep1Message);
  decoding.readVarUint(decoder);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, serverDoc, "fake-server");
  return encoding.toUint8Array(encoder);
}

const USER = { id: 1, username: "alice", role: "editor" } as any;

describe("CollaborationClient — M63 transient-blip grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not emit a disconnected connection_change for a blip that recovers within grace", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    const seen: string[] = [];
    client.on("connection_change", (s: string) => seen.push(s));

    FakeWebSocket.latest().simulateClose(1006);
    vi.advanceTimersByTime(2000); // reconnect attempt (first backoff ~1500ms)
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage(serverReplyToSyncStep1(new Y.Doc(), ws2.sent[0]));

    expect(seen).not.toContain("disconnected");
    expect(seen).toContain("resynchronizing");
    expect(client.status).toBe("connected");
    client.dispose();
  });

  it("emits disconnected once a reconnect attempt has already failed", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    const seen: string[] = [];
    client.on("connection_change", (s: string) => seen.push(s));

    FakeWebSocket.latest().simulateClose(1006); // drop 1 (grace armed)
    vi.advanceTimersByTime(2000); // reconnect attempt -> new socket
    FakeWebSocket.latest().simulateClose(1006); // drop 2 (reconnect failed)

    expect(seen).toContain("disconnected");
    client.dispose();
  });

  it("still sets client.status to disconnected synchronously on any close", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    FakeWebSocket.latest().simulateClose(1006);
    expect(client.status).toBe("disconnected");
    client.dispose();
  });

  it("does not leave the grace emit pending after recovery (no late disconnected)", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    FakeWebSocket.latest().simulateClose(1006);
    vi.advanceTimersByTime(2000);
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage(serverReplyToSyncStep1(new Y.Doc(), ws2.sent[0]));
    expect(client.status).toBe("connected");

    const seen: string[] = [];
    client.on("connection_change", (s: string) => seen.push(s));
    vi.advanceTimersByTime(30_000); // any stale grace timer would fire here
    expect(seen).not.toContain("disconnected");
    client.dispose();
  });

  it("dispose() clears the grace timer", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    FakeWebSocket.latest().simulateClose(1006); // arms the grace timer
    client.dispose();
    expect((client as any).disconnectGraceTimer).toBeNull();
  });
});

describe("CollaborationClient — M63 bounded reconnect + manual retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function exhaust(): void {
    FakeWebSocket.latest().simulateOpen();
    for (let i = 0; i < 20; i++) {
      FakeWebSocket.latest().simulateClose(1006);
      vi.advanceTimersByTime(15_000);
    }
  }

  it("stops scheduling reconnects after the attempt ceiling and reports it as terminal", () => {
    const client = new CollaborationClient("p", USER);
    let exhausted = false;
    client.on("reconnect_exhausted", () => (exhausted = true));

    exhaust();

    expect(exhausted).toBe(true);
    expect(client.reconnectExhausted).toBe(true);
    expect((client as any).reconnectTimer).toBeNull();
    const socketsBefore = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(socketsBefore); // no more attempts
    client.dispose();
  });

  it("emits a disconnected connection_change when it gives up", () => {
    const client = new CollaborationClient("p", USER);
    const seen: string[] = [];
    client.on("connection_change", (s: string) => seen.push(s));
    exhaust();
    expect(seen).toContain("disconnected");
    client.dispose();
  });

  it("retry() from the terminal state resumes reconnecting with fresh attempt state", () => {
    const client = new CollaborationClient("p", USER);
    exhaust();
    expect(client.reconnectExhausted).toBe(true);
    const socketsBefore = FakeWebSocket.instances.length;

    client.retry();

    expect(client.reconnectExhausted).toBe(false);
    expect((client as any).reconnectAttempts).toBe(0);
    expect(FakeWebSocket.instances.length).toBe(socketsBefore + 1);
    expect(client.status).toBe("connecting");
    client.dispose();
  });

  it("a successful reconnect after retry() clears the terminal state", () => {
    const client = new CollaborationClient("p", USER);
    exhaust();
    client.retry();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage(serverReplyToSyncStep1(new Y.Doc(), ws.sent[0]));
    expect(client.reconnectExhausted).toBe(false);
    expect(client.status).toBe("connected");
    client.dispose();
  });

  it("forbidden is terminal: no reconnect scheduled and retry() is a no-op", () => {
    const client = new CollaborationClient("p", USER);
    FakeWebSocket.latest().simulateOpen();
    FakeWebSocket.latest().simulateClose(4403);
    expect(client.status).toBe("forbidden");
    expect((client as any).reconnectTimer).toBeNull();

    const socketsBefore = FakeWebSocket.instances.length;
    client.retry();
    expect(FakeWebSocket.instances.length).toBe(socketsBefore);
    expect(client.status).toBe("forbidden");
    client.dispose();
  });
});
