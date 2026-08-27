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

function runStatusFrame(obj: Record<string, unknown>): ArrayBuffer {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify({ type: "run_status", ...obj }));
  return encoding.toUint8Array(enc).buffer as ArrayBuffer;
}

const USER = { id: 42, username: "alice", role: "owner" } as any;

const RUNNING = {
  executionId: "e1",
  userId: 7,
  username: "bob",
  state: "running",
  file: "src/app.py",
  language: "python",
  startedAt: Date.now(),
  endedAt: null,
  exitCode: null,
};

describe("CollaborationClient — M54 run-status (receive-only)", () => {
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
    ws.onmessage?.({ data: runStatusFrame(obj) });

  it("stores an incoming running status and emits run_status_change", () => {
    const changes: any[] = [];
    client.on("run_status_change", (e: any) => changes.push(e));

    feed(RUNNING);

    expect(client.getRunStatuses()).toEqual([RUNNING]);
    expect(changes).toHaveLength(1);
    expect(changes[0][0].state).toBe("running");
  });

  it("updates the same executionId in place on a terminal frame (no duplicate)", () => {
    feed(RUNNING);
    feed({ ...RUNNING, state: "success", endedAt: Date.now(), exitCode: 0 });

    const all = client.getRunStatuses();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      executionId: "e1",
      state: "success",
      exitCode: 0,
    });
  });

  it("removes an entry on a 'cleared' frame", () => {
    feed(RUNNING);
    expect(client.getRunStatuses()).toHaveLength(1);

    ws.onmessage?.({
      data: runStatusFrame({ executionId: "e1", userId: 7, state: "cleared" }),
    });

    expect(client.getRunStatuses()).toHaveLength(0);
  });

  it("ignores a malformed run_status frame", () => {
    const changes: any[] = [];
    client.on("run_status_change", (e: any) => changes.push(e));

    feed({ executionId: "x", state: "bogus" }); // bad state, no userId
    feed({ executionId: "y", userId: "nope", state: "running" }); // bad userId

    expect(client.getRunStatuses()).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });

  it("clears run statuses on dispose()", () => {
    feed(RUNNING);
    expect(client.getRunStatuses()).toHaveLength(1);
    client.dispose();
    expect(client.getRunStatuses()).toHaveLength(0);
  });

  it("never transmits a run_status frame to the server", () => {
    feed(RUNNING);
    feed({ ...RUNNING, state: "success", endedAt: Date.now(), exitCode: 0 });

    for (const w of FakeWebSocket.instances) {
      for (const frame of w.sent) {
        const txt = new TextDecoder().decode(frame);
        expect(txt).not.toContain("run_status");
      }
    }
  });
});
