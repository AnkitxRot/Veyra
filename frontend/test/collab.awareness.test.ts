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

  it("transitions availability to away after 1 minute of window blur", () => {
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

    // M57: advance past 60 seconds: becomes "away" (window blurred), which is
    // distinct from "idle" (no interaction while the window is still focused).
    vi.advanceTimersByTime(2000);
    expect((client.awareness.getLocalState() as any).status).toBe("away");

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

  // --- M57: working folder, intent, navigating, away ---------------------

  it('notifyFileOpen sets workingFolder to dirname(activeFile)', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.notifyFileOpen('src/auth/service.ts');
    expect((client.awareness.getLocalState() as any).workingFolder).toBe('src/auth');
    client.notifyFileOpen('main.py');
    expect((client.awareness.getLocalState() as any).workingFolder).toBeNull();
    client.dispose();
  });

  it('window blur transitions availability to "away" (not "idle")', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(60_000);
    expect((client.awareness.getLocalState() as any).status).toBe('away');
    client.dispose();
  });

  it('window focus restores online from away', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(60_000);
    expect((client.awareness.getLocalState() as any).status).toBe('away');
    window.dispatchEvent(new Event('focus'));
    expect((client.awareness.getLocalState() as any).status).toBe('online');
    client.dispose();
  });

  it('recordNavigation sets activity "navigating" then reverts to "viewing"', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.notifyFileOpen('a.ts');
    client.recordNavigation();
    expect((client.awareness.getLocalState() as any).activity.type).toBe('navigating');
    vi.advanceTimersByTime(2500);
    expect((client.awareness.getLocalState() as any).activity.type).toBe('viewing');
    client.dispose();
  });

  it('recordNavigation does not override an in-flight editing state', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.notifyFileOpen('a.ts');
    client.recordEdit();
    client.recordNavigation();
    expect((client.awareness.getLocalState() as any).activity.type).toBe('editing');
    client.dispose();
  });

  it('setIntent sets a cleaned, bounded intent and setIntent("") clears it', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.setIntent("  Implement\nJWT refresh  ");
    const st = client.awareness.getLocalState() as any;
    expect(st.intent.text).toBe('Implement JWT refresh');
    expect(typeof st.intent.updatedAt).toBe('number');
    client.setIntent('');
    expect((client.awareness.getLocalState() as any).intent).toBeNull();
    client.dispose();
  });

  it('setIntent is a no-op when the cleaned text is unchanged', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.setIntent('hello');
    const first = (client.awareness.getLocalState() as any).intent.updatedAt;
    vi.advanceTimersByTime(5);
    client.setIntent('hello');
    expect((client.awareness.getLocalState() as any).intent.updatedAt).toBe(first);
    client.dispose();
  });

  it('setIntent truncates to 120 chars', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.setIntent('x'.repeat(400));
    expect((client.awareness.getLocalState() as any).intent.text).toHaveLength(120);
    client.dispose();
  });

  it('resetLocalCollabState clears workingFolder and intent', () => {
    const client = new CollaborationClient('proj-1', { id: 1, username: 'a' } as any);
    client.notifyFileOpen('src/x/y.ts');
    client.setIntent('hello');
    (client as any).resetLocalCollabState();
    const st = client.awareness.getLocalState() as any;
    expect(st.workingFolder ?? null).toBeNull();
    expect(st.intent ?? null).toBeNull();
    // tracker reset: same text re-emits
    client.setIntent('hello');
    expect((client.awareness.getLocalState() as any).intent.text).toBe('hello');
    client.dispose();
  });

});
