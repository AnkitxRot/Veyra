import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// CollaborationClient never touches monaco directly (only the ITextModel/
// IStandaloneCodeEditor types passed in), but it imports the module for
// typing purposes — stub it out like the other collab-adjacent tests do.
vi.mock("../src/monacoSetup", () => ({ monaco: {} }));

const bindingCtor = vi.fn();
vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    constructor(...args: unknown[]) {
      bindingCtor(...args);
    }
    destroy() {}
  },
}));

import { CollaborationClient } from "../src/collab/client";

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
  send() {}
}

describe("CollaborationClient — disposed client cannot rebind (Y.Doc write-after-switch guard)", () => {
  beforeEach(() => {
    bindingCtor.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bindMonacoModel is a no-op once dispose() has run: no Y.Text seed, no y-monaco binding", () => {
    const client = new CollaborationClient("project-a", {
      id: 1,
      username: "alice",
    } as any);
    client.dispose();

    // A stale prop reference from the project this client belonged to,
    // carrying content that must never leak into a new Y.Doc/project.
    const staleModel = {
      getValue: () => "content left over from project A",
    } as any;

    expect(() =>
      client.bindMonacoModel("main.py", staleModel, {} as any),
    ).not.toThrow();

    expect(bindingCtor).not.toHaveBeenCalled();
  });

  it("bindMonacoModel still binds normally on a live (non-disposed) client", () => {
    const client = new CollaborationClient("project-b", {
      id: 2,
      username: "bob",
    } as any);

    const model = { getValue: () => "hello" } as any;
    client.bindMonacoModel("main.py", model, {} as any);

    expect(bindingCtor).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
