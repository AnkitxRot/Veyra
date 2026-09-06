import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/monacoSetup", () => ({
  monaco: { editor: { EndOfLineSequence: { LF: 0, CRLF: 1 } } },
}));
vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    destroy() {}
  },
}));

import { CollaborationClient } from "../src/collab/client";

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
  close() {
    this.readyState = 3;
  }
  send(data: ArrayBufferLike) {
    this.sent.push(new Uint8Array(data as ArrayBuffer));
  }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code } as any);
  }
  static latest() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

const USER = { id: 7, username: "ada99", role: "editor" } as any;

function selfUser(client: CollaborationClient): any {
  return client.awareness.getLocalState()?.user;
}
function selfPresence(client: CollaborationClient) {
  return client.getOnlineCollaborators().find((c) => c.userId === 7)!;
}

describe("M73 — CollaborationClient.updateLocalIdentity (self-render, no reconnect)", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("seeds the local user with stable identity only — no presentation fields yet", () => {
    const client = new CollaborationClient("p", USER);
    const u = selfUser(client);
    expect(u.id).toBe(7);
    expect(u.name).toBe("ada99");
    expect("displayName" in u).toBe(false);
    expect("avatarVersion" in u).toBe(false);
    expect("pronouns" in u).toBe(false);
    client.dispose();
  });

  it("folds displayName / avatarVersion / pronouns into the local presence entry", () => {
    const client = new CollaborationClient("p", USER);
    client.updateLocalIdentity({
      displayName: "Ada L.",
      avatarVersion: 3,
      pronouns: "she/her",
    });
    const p = selfPresence(client);
    expect(p.name).toBe("ada99"); // stable identity untouched
    expect(p.displayName).toBe("Ada L.");
    expect(p.avatarVersion).toBe(3);
    expect(p.pronouns).toBe("she/her");
    client.dispose();
  });

  it("creates no new WebSocket and does not change connection status", () => {
    const client = new CollaborationClient("p", USER);
    const before = FakeWebSocket.instances.length;
    const status = client.status;
    client.updateLocalIdentity({ displayName: "Ada L.", avatarVersion: 9 });
    expect(FakeWebSocket.instances.length).toBe(before);
    expect(client.status).toBe(status);
    client.dispose();
  });

  it("blank / non-positive values clear the presentation fields", () => {
    const client = new CollaborationClient("p", USER);
    client.updateLocalIdentity({ displayName: "Ada L.", avatarVersion: 3, pronouns: "she/her" });
    client.updateLocalIdentity({ displayName: "   ", avatarVersion: 0, pronouns: "" });
    const u = selfUser(client);
    expect("displayName" in u).toBe(false);
    expect("avatarVersion" in u).toBe(false);
    expect("pronouns" in u).toBe(false);
    client.dispose();
  });

  it("an unchanged patch is a no-op (no awareness churn)", () => {
    const client = new CollaborationClient("p", USER);
    client.updateLocalIdentity({ displayName: "Ada L.", avatarVersion: 3 });
    const spy = vi.spyOn(client.awareness, "setLocalStateField");
    client.updateLocalIdentity({ displayName: "Ada L.", avatarVersion: 3 });
    expect(spy).not.toHaveBeenCalled();
    client.dispose();
  });

  it("the identity survives an explicit-disposal lineage reset", () => {
    const client = new CollaborationClient("p", USER);
    client.updateLocalIdentity({ displayName: "Ada L.", avatarVersion: 3, pronouns: "she/her" });
    const ws = FakeWebSocket.latest();
    ws.simulateOpen(); // status → "connected"
    ws.simulateClose(1001); // explicit server disposal → fresh lineage
    const p = selfPresence(client);
    expect(p.displayName).toBe("Ada L.");
    expect(p.avatarVersion).toBe(3);
    expect(p.pronouns).toBe("she/her");
    client.dispose();
  });

  it("is inert after dispose", () => {
    const client = new CollaborationClient("p", USER);
    client.dispose();
    expect(() =>
      client.updateLocalIdentity({ displayName: "Late" }),
    ).not.toThrow();
  });
});
