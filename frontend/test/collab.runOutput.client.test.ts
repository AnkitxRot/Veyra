import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as encoding from "lib0/encoding";

vi.mock("../src/monacoSetup", () => ({ monaco: {} }));
vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    destroy() {}
  },
}));

import { CollaborationClient } from "../src/collab/client";

const MESSAGE_CUSTOM = 3;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send(d: ArrayBufferLike) {
    this.sent.push(new Uint8Array(d as ArrayBuffer));
  }
}

function customFrame(obj: Record<string, unknown>): ArrayBuffer {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc).buffer as ArrayBuffer;
}

const USER = { id: 42, username: "alice", role: "editor" } as any;

const outputFrame = (over: Record<string, unknown> = {}) => ({
  type: "run_output",
  executionId: "e1",
  seq: 1,
  truncated: false,
  chunks: [{ stream: "stdout", data: "hello\n" }],
  ...over,
});

describe("CollaborationClient — M65 shared run output (receive-only)", () => {
  let client: CollaborationClient;
  let ws: FakeWebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    client = new CollaborationClient("proj-1", USER);
    ws = FakeWebSocket.instances[0];
  });

  afterEach(() => {
    client.dispose();
    vi.unstubAllGlobals();
  });

  const feed = (obj: Record<string, unknown>) =>
    ws.onmessage?.({ data: customFrame(obj) });

  it("accumulates output chunks and emits run_output_change", () => {
    const changes: any[] = [];
    client.on("run_output_change", (e: any) => changes.push(e));

    feed(outputFrame({ seq: 1, chunks: [{ stream: "stdout", data: "a" }] }));
    feed(outputFrame({ seq: 2, chunks: [{ stream: "stderr", data: "b" }] }));

    const outs = client.getRunOutputs();
    expect(outs).toHaveLength(1);
    expect(outs[0].executionId).toBe("e1");
    expect(outs[0].chunks).toEqual([
      { stream: "stdout", data: "a" },
      { stream: "stderr", data: "b" },
    ]);
    expect(changes).toHaveLength(2);
  });

  it("a snapshot frame replaces the buffer and sets the seq baseline", () => {
    feed(outputFrame({ seq: 5, chunks: [{ stream: "stdout", data: "live\n" }] }));
    feed(
      outputFrame({
        snapshot: true,
        seq: 9,
        truncated: true,
        chunks: [{ stream: "stdout", data: "REPLAYED\n" }],
      }),
    );

    const out = client.getRunOutputs()[0];
    expect(out.chunks).toEqual([{ stream: "stdout", data: "REPLAYED\n" }]);
    expect(out.truncated).toBe(true);
  });

  it("ignores a live batch whose seq was already covered by the snapshot (reconnect dedupe)", () => {
    feed(
      outputFrame({
        snapshot: true,
        seq: 4,
        chunks: [
          { stream: "stdout", data: "1\n" },
          { stream: "stdout", data: "2\n" },
        ],
      }),
    );
    // a duplicated in-flight batch the server had already folded into the snapshot
    feed(outputFrame({ seq: 3, chunks: [{ stream: "stdout", data: "2\n" }] }));
    feed(outputFrame({ seq: 4, chunks: [{ stream: "stdout", data: "2\n" }] }));
    // a genuinely newer batch still lands
    feed(outputFrame({ seq: 5, chunks: [{ stream: "stdout", data: "3\n" }] }));

    const out = client.getRunOutputs()[0];
    expect(out.chunks.map((c) => c.data).join("")).toBe("1\n2\n3\n");
  });

  it("latches truncated when the client-side buffer overflows", () => {
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) {
      feed(outputFrame({ seq: i + 1, chunks: [{ stream: "stdout", data: big }] }));
    }
    const out = client.getRunOutputs()[0];
    expect(out.truncated).toBe(true);
    const bytes = out.chunks.reduce((n, c) => n + c.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("drops the buffer when the run's status is cleared", () => {
    feed(outputFrame());
    expect(client.getRunOutputs()).toHaveLength(1);
    ws.onmessage?.({
      data: customFrame({ type: "run_status", executionId: "e1", userId: 7, state: "cleared" }),
    });
    expect(client.getRunOutputs()).toHaveLength(0);
  });

  it("ignores a malformed run_output frame", () => {
    const changes: any[] = [];
    client.on("run_output_change", (e: any) => changes.push(e));
    feed({ type: "run_output", executionId: "e1", chunks: "not-an-array" });
    feed({ type: "run_output", chunks: [{ stream: "stdout", data: "x" }] }); // no executionId
    feed(outputFrame({ chunks: [{ stream: "telnet", data: "x" }] })); // bad stream
    expect(client.getRunOutputs()).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });

  it("never transmits a run_output frame to the server", () => {
    feed(outputFrame());
    const decoded = ws.sent.map((u8) => {
      try {
        const dec = (encoding as any); // decode manually
        void dec;
        return new TextDecoder().decode(u8);
      } catch {
        return "";
      }
    });
    expect(decoded.some((s) => s.includes("run_output"))).toBe(false);
  });

  it("clears buffers on dispose()", () => {
    feed(outputFrame());
    client.dispose();
    expect(client.getRunOutputs()).toHaveLength(0);
  });
});
