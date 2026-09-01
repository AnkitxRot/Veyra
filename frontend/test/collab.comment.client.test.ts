import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("CollaborationClient — M61 comment/profile pings", () => {
  let client: CollaborationClient;
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocket",
      class extends RecordingWebSocket {
        constructor() {
          super();
        }
      },
    );
    client = new CollaborationClient("p", { id: 1, name: "a" } as any);
  });

  it("emits comment_event for a valid frame, ignores a malformed one", () => {
    const seen: any[] = [];
    client.on("comment_event", (e: any) => seen.push(e));
    feed(client, {
      type: "comment_event",
      threadId: "t",
      filePath: "a.ts",
      kind: "created",
      at: 1,
    });
    feed(client, { type: "comment_event" });
    expect(seen.length).toBe(1);
    expect(seen[0].threadId).toBe("t");
  });

  it("emits comment_mention only for well-formed frames", () => {
    const seen: any[] = [];
    client.on("comment_mention", (e: any) => seen.push(e));
    feed(client, {
      type: "comment_mention",
      threadId: "t",
      commentId: "c",
      filePath: "a.ts",
      line: 3,
      author: { userId: 2, username: "b" },
      preview: "look",
      at: 1,
    });
    feed(client, { type: "comment_mention", threadId: "t" });
    expect(seen.length).toBe(1);
  });

  it("emits profile_event with a numeric userId only", () => {
    const seen: any[] = [];
    client.on("profile_event", (e: any) => seen.push(e));
    feed(client, { type: "profile_event", userId: 7 });
    feed(client, { type: "profile_event", userId: "7" });
    expect(seen).toEqual([{ type: "profile_event", userId: 7 }]);
  });

  it("the client never authors these frames", () => {
    const ws = new RecordingWebSocket();
    (client as unknown as { ws: RecordingWebSocket }).ws = ws;
    // No public method exists to send a comment_event / profile_event.
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(client)).some((m) =>
        /comment_event|profile_event|sendComment|sendProfile/i.test(m),
      ),
    ).toBe(false);
  });
});
