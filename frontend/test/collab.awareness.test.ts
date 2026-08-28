import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/monacoSetup", () => ({ monaco: {} }));

vi.mock("y-monaco", () => ({
  MonacoBinding: class {
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

describe("CollaborationClient — Ambient Presence, Activity State Machine & Privacy Invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("initializes with online availability, viewing activity, and sanitizes user presence", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
      role: "owner",
    } as any);

    const localState = client.awareness.getLocalState() as any;
    expect(localState).toBeDefined();
    expect(localState.user).toBeDefined();
    expect(localState.user.name).toBe("alice");
    expect(localState.status).toBe("online");
    expect(localState.activity.type).toBe("viewing");
    expect(localState.cursor).toBeUndefined();
    expect(localState.selection).toBeUndefined();

    // Privacy Invariant: verify no content or sensitive fields leaked in local awareness
    expect(localState.content).toBeUndefined();
    expect(localState.selectedText).toBeUndefined();
    expect(localState.secrets).toBeUndefined();
    expect(localState.terminalOutput).toBeUndefined();

    client.dispose();
  });

  it("transitions activity to editing on recordEdit() and reverts to viewing after 5s debounce", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    client.recordEdit();
    let localState = client.awareness.getLocalState() as any;
    expect(localState.activity.type).toBe("editing");

    // Advance 3 seconds: still editing
    vi.advanceTimersByTime(3000);
    localState = client.awareness.getLocalState() as any;
    expect(localState.activity.type).toBe("editing");

    // Advance past 5s hysteresis window: reverts to viewing
    vi.advanceTimersByTime(2500);
    localState = client.awareness.getLocalState() as any;
    expect(localState.activity.type).toBe("viewing");

    client.dispose();
  });

  it("transitions availability to idle after 2 minutes of inactivity", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    expect((client.awareness.getLocalState() as any).status).toBe("online");

    // Advance 119 seconds: still online
    vi.advanceTimersByTime(119000);
    expect((client.awareness.getLocalState() as any).status).toBe("online");

    // Advance past 120 seconds: becomes idle
    vi.advanceTimersByTime(2000);
    expect((client.awareness.getLocalState() as any).status).toBe("idle");

    // Any activity restores online
    client.recordEdit();
    expect((client.awareness.getLocalState() as any).status).toBe("online");

    client.dispose();
  });

  it("transitions availability to idle after 1 minute of window blur", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    expect((client.awareness.getLocalState() as any).status).toBe("online");

    // Simulate window blur
    window.dispatchEvent(new Event("blur"));

    // Advance 59 seconds: still online
    vi.advanceTimersByTime(59000);
    expect((client.awareness.getLocalState() as any).status).toBe("online");

    // Advance past 60 seconds: becomes idle
    vi.advanceTimersByTime(2000);
    expect((client.awareness.getLocalState() as any).status).toBe("idle");

    // Focus immediately restores online
    window.dispatchEvent(new Event("focus"));
    expect((client.awareness.getLocalState() as any).status).toBe("online");

    client.dispose();
  });

  it("respects user DND override and ignores idle/activity transitions when DND is active", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    client.setDnd(true);
    expect((client.awareness.getLocalState() as any).status).toBe("dnd");

    // Window blur or timer advance does not overwrite DND
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(150000);
    expect((client.awareness.getLocalState() as any).status).toBe("dnd");

    // Clearing DND restores online
    client.setDnd(false);
    expect((client.awareness.getLocalState() as any).status).toBe("online");

    client.dispose();
  });

  it("supports explicit activity states (running, terminal, searching) and restoreActivity()", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    client.setActivity("running", "Running python main.py");
    expect((client.awareness.getLocalState() as any).activity.type).toBe(
      "running",
    );

    client.restoreActivity();
    expect((client.awareness.getLocalState() as any).activity.type).toBe(
      "viewing",
    );

    client.setActivity("terminal");
    expect((client.awareness.getLocalState() as any).activity.type).toBe(
      "terminal",
    );

    client.restoreActivity();
    expect((client.awareness.getLocalState() as any).activity.type).toBe(
      "viewing",
    );

    client.dispose();
  });

  it("debounces selection updates and preserves line/column ranges without content", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    client.updateSelection({
      startLine: 10,
      startColumn: 1,
      endLine: 12,
      endColumn: 25,
    });

    // Advance debounce timer (50ms)
    vi.advanceTimersByTime(60);

    const localState = client.awareness.getLocalState() as any;
    expect(localState.selection).toEqual({
      startLine: 10,
      startColumn: 1,
      endLine: 12,
      endColumn: 25,
    });

    client.dispose();
  });

  // --- M56: activeFileDirty bit ---------------------------------------

  it("mirrors setActiveFileDirty() into a single bounded awareness bit, deduping repeats", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    expect(
      (client.awareness.getLocalState() as any).activeFileDirty,
    ).toBeUndefined();

    client.setActiveFileDirty(true);
    expect((client.awareness.getLocalState() as any).activeFileDirty).toBe(
      true,
    );

    // No arbitrary path list is ever emitted — only the boolean.
    const st = client.awareness.getLocalState() as any;
    expect(st.dirtyPaths).toBeUndefined();

    client.setActiveFileDirty(false);
    expect((client.awareness.getLocalState() as any).activeFileDirty).toBe(
      false,
    );

    client.dispose();
  });

  it("clears the dirty bit on file switch (notifyFileOpen)", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);

    client.notifyFileOpen("a.ts");
    client.setActiveFileDirty(true);
    expect((client.awareness.getLocalState() as any).activeFileDirty).toBe(
      true,
    );

    client.notifyFileOpen("b.ts");
    expect((client.awareness.getLocalState() as any).activeFileDirty).toBe(
      false,
    );

    client.dispose();
  });

  it("never reports another user's dirty state — setActiveFileDirty only touches local state", () => {
    const client = new CollaborationClient("proj-1", {
      id: 42,
      username: "alice",
    } as any);
    client.setActiveFileDirty(true);
    // Only this client's own awareness entry carries the bit.
    const states = client.awareness.getStates();
    const own = states.get(client.awareness.clientID) as any;
    expect(own.activeFileDirty).toBe(true);
    client.dispose();
  });
});
