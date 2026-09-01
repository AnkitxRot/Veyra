import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

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

function sentCustom(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const buf of lastWs?.sent ?? []) {
    try {
      const dec = decoding.createDecoder(buf);
      if (decoding.readVarUint(dec) !== MESSAGE_CUSTOM) continue;
      out.push(JSON.parse(decoding.readVarString(dec)));
    } catch {}
  }
  return out;
}

function customFrame(obj: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc);
}

function feed(client: CollaborationClient, obj: unknown): void {
  (client as unknown as { handleMessage: (m: Uint8Array) => void }).handleMessage(
    customFrame(obj),
  );
}

describe("CollaborationClient — M58 attention", () => {
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
    new CollaborationClient("p", { id: 1, username: "a" } as never);

  it("sendAttentionPoint emits a well-formed MESSAGE_CUSTOM frame", async () => {
    const client = mk();
    await new Promise((r) => setTimeout(r, 1));
    client.sendAttentionPoint("auth/session.ts", {
      startLine: 47,
      startColumn: 1,
      endLine: 47,
      endColumn: 1,
    });
    expect(sentCustom()).toContainEqual({
      type: "attention_point",
      file: "auth/session.ts",
      range: { startLine: 47, startColumn: 1, endLine: 47, endColumn: 1 },
    });
    client.dispose();
  });

  it("an inbound attention_event lands in the store and fires attention_change", () => {
    const client = mk();
    const changes: unknown[][] = [];
    client.on("attention_change", (l: unknown[]) => changes.push(l));
    feed(client, {
      type: "attention_event",
      id: "abc0000000000000",
      kind: "callout",
      author: { userId: 7, username: "r", color: "#89b4fa" },
      file: "a.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      message: "hi",
      createdAt: Date.now(),
      expiresAt: Date.now() + 90_000,
    });
    expect(client.getAttention().map((e) => e.id)).toContain("abc0000000000000");
    expect(
      (changes.at(-1) as { id: string }[]).some(
        (e) => e.id === "abc0000000000000",
      ),
    ).toBe(true);
    client.dispose();
  });

  it("dismissAttentionRequest sends a dismiss frame and removes it locally", async () => {
    const client = mk();
    await new Promise((r) => setTimeout(r, 1));
    feed(client, {
      type: "attention_event",
      id: "req0000000000000",
      kind: "request",
      targetUserId: 1,
      author: { userId: 7, username: "r", color: "#89b4fa" },
      file: "a.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      message: "look",
      createdAt: Date.now(),
      expiresAt: Date.now() + 120_000,
    });
    expect(client.getAttention()).toHaveLength(1);
    client.dismissAttentionRequest("req0000000000000", true);
    expect(sentCustom()).toContainEqual({
      type: "attention_dismiss",
      id: "req0000000000000",
      acted: true,
    });
    expect(client.getAttention()).toHaveLength(0);
    client.dispose();
  });

  it("resetLocalCollabState clears transient attention", () => {
    const client = mk();
    feed(client, {
      type: "attention_event",
      id: "x000000000000000",
      kind: "point",
      author: { userId: 7, username: "r", color: "#89b4fa" },
      file: "a.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      createdAt: Date.now(),
      expiresAt: Date.now() + 6_000,
    });
    (
      client as unknown as { resetLocalCollabState: () => void }
    ).resetLocalCollabState();
    expect(client.getAttention()).toEqual([]);
    client.dispose();
  });

  it("emits attention_rate_limited on the transient notice", () => {
    const client = mk();
    const seen: unknown[] = [];
    client.on("attention_rate_limited", (m: unknown) => seen.push(m));
    feed(client, {
      type: "attention_rate_limited",
      scope: "outstanding_requests",
    });
    expect(seen).toHaveLength(1);
    client.dispose();
  });
});
