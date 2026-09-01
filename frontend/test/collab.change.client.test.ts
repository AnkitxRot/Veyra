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

class RecordingWebSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  close() {}
  send(d: Uint8Array) {
    this.sent.push(d);
  }
}
let lastWs: RecordingWebSocket | null = null;

function customFrame(obj: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc);
}
function feed(client: CollaborationClient, obj: unknown): void {
  (
    client as unknown as { handleMessage: (m: Uint8Array) => void }
  ).handleMessage(customFrame(obj));
}

const wellFormed = {
  type: "collab_change",
  id: "collab:x1",
  kind: "edit_burst",
  at: "2026-08-31T10:00:00.000Z",
  actor: { userId: 7, username: "rahul" },
  filePath: "auth/session.ts",
  lineRange: null,
  updateCount: 2,
  linesAdded: 3,
  linesRemoved: 0,
};

describe("CollaborationClient — M60 collab_change", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocket",
      class extends RecordingWebSocket {
        constructor() {
          super();
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          lastWs = this;
          this.readyState = 1;
          setTimeout(() => this.onopen?.(), 0);
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    lastWs = null;
  });

  const mk = () =>
    new CollaborationClient("p", { id: 1, username: "me" } as never);

  it("emits collab_change on a well-formed frame; ignores malformed", () => {
    const client = mk();
    const spy = vi.fn();
    client.on("collab_change", spy);
    feed(client, wellFormed);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].actor.username).toBe("rahul");

    feed(client, { type: "collab_change", actor: 123 });
    feed(client, { type: "collab_change", id: "y", actor: { userId: "no" } });
    feed(client, { type: "collab_change", id: "z", actor: { userId: 1 }, kind: "??" });
    expect(spy).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("the client never constructs a collab_change frame (receive-only)", () => {
    const src = CollaborationClient.toString();
    // A frame is built as `{ type: "collab_change", ... }` before send/encode.
    // The client only ever compares (`parsed.type === "collab_change"`) and
    // re-emits (`this.emit("collab_change", ...)`) — never builds one.
    expect(src).not.toMatch(/type\s*:\s*["']collab_change["']/);
    expect(src).toMatch(/parsed\.type === ["']collab_change["']/);
    expect(src).toMatch(/emit\(["']collab_change["']/);
  });

  it("reconnect after an offline gap emits reconnected_after_gap with offlineMs", async () => {
    vi.useFakeTimers();
    const client = mk();
    await vi.advanceTimersByTimeAsync(1); // onopen
    const gap = vi.fn();
    client.on("reconnected_after_gap", gap);

    // simulate a network drop (not code 1001/4403)
    lastWs!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(60_000); // let scheduleReconnect fire + reconnect

    expect(gap).toHaveBeenCalled();
    expect(typeof gap.mock.calls[0][0].offlineMs).toBe("number");
    expect(gap.mock.calls[0][0].offlineMs).toBeGreaterThanOrEqual(0);
    client.dispose();
    vi.useRealTimers();
  });
});
