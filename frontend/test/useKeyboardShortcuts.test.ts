import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useKeyboardShortcuts } from "../src/hooks/useKeyboardShortcuts";
import { resolveKeymap } from "../src/keymap/keymap";

function dispatchKeydown(
  init: KeyboardEventInit & { code?: string },
  target?: EventTarget,
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (target) Object.defineProperty(event, "target", { value: target });
  const stopSpy = vi.spyOn(event, "stopPropagation");
  const preventSpy = vi.spyOn(event, "preventDefault");
  window.dispatchEvent(event);
  return { stopSpy, preventSpy };
}

const HANDLERS = () => ({
  onOpenCommandPalette: vi.fn(),
  onOpenQuickOpen: vi.fn(),
  getActiveFile: () => "a.py",
  onToggleSidebar: vi.fn(),
  onToggleBottomPanel: vi.fn(),
});

function collectSaveEvents() {
  const events: CustomEvent[] = [];
  const listener = (e: Event) => events.push(e as CustomEvent);
  document.addEventListener("ide-save", listener);
  return {
    events,
    stop: () => document.removeEventListener("ide-save", listener),
  };
}

describe("useKeyboardShortcuts — canonical save path (M1)", () => {
  afterEach(() => {
    cleanup();
  });

  it("Ctrl+S dispatches exactly one ide-save CustomEvent carrying the active file path", () => {
    const getActiveFile = vi.fn(() => "src/app.py");
    renderHook(() =>
      useKeyboardShortcuts({
        onOpenCommandPalette: vi.fn(),
        onOpenQuickOpen: vi.fn(),
        getActiveFile,
      }),
    );

    const { events, stop } = collectSaveEvents();
    const { stopSpy, preventSpy } = dispatchKeydown({
      key: "s",
      ctrlKey: true,
    });
    stop();

    expect(events).toHaveLength(1);
    expect(events[0].detail.path).toBe("src/app.py");
    // Load-bearing: stopPropagation on this capture-phase listener is what
    // keeps Monaco's own internal Ctrl+S keybinding (Editor.tsx) from firing
    // a second ide-save dispatch for the same keystroke.
    expect(stopSpy).toHaveBeenCalled();
    expect(preventSpy).toHaveBeenCalled();
  });

  it("does not dispatch ide-save for unrelated shortcuts (Ctrl+P, Ctrl+Shift+P)", () => {
    const onOpenCommandPalette = vi.fn();
    const onOpenQuickOpen = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        onOpenCommandPalette,
        onOpenQuickOpen,
        getActiveFile: () => "src/app.py",
      }),
    );

    const { events, stop } = collectSaveEvents();
    dispatchKeydown({ key: "p", ctrlKey: true });
    dispatchKeydown({ key: "p", ctrlKey: true, shiftKey: true });
    stop();

    expect(events).toHaveLength(0);
    expect(onOpenQuickOpen).toHaveBeenCalledTimes(1);
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("dispatches exactly once per distinct Ctrl+S keystroke — no duplicate dispatch accumulation", () => {
    renderHook(() =>
      useKeyboardShortcuts({
        onOpenCommandPalette: vi.fn(),
        onOpenQuickOpen: vi.fn(),
        getActiveFile: () => "a.py",
      }),
    );

    const { events, stop } = collectSaveEvents();
    dispatchKeydown({ key: "s", ctrlKey: true });
    dispatchKeydown({ key: "s", ctrlKey: true });
    dispatchKeydown({ key: "s", ctrlKey: true });
    stop();

    expect(events).toHaveLength(3);
  });

  it("does not dispatch ide-save when the hook is disabled", () => {
    renderHook(() =>
      useKeyboardShortcuts(
        {
          onOpenCommandPalette: vi.fn(),
          onOpenQuickOpen: vi.fn(),
          getActiveFile: () => "a.py",
        },
        false,
      ),
    );

    const { events, stop } = collectSaveEvents();
    dispatchKeydown({ key: "s", ctrlKey: true });
    stop();

    expect(events).toHaveLength(0);
  });

  it("resolves a null active file to a null path rather than throwing", () => {
    renderHook(() =>
      useKeyboardShortcuts({
        onOpenCommandPalette: vi.fn(),
        onOpenQuickOpen: vi.fn(),
        getActiveFile: () => null,
      }),
    );

    const { events, stop } = collectSaveEvents();
    dispatchKeydown({ key: "s", ctrlKey: true });
    stop();

    expect(events).toHaveLength(1);
    expect(events[0].detail.path).toBeNull();
  });
});

describe("useKeyboardShortcuts — M70 configurable dispatch", () => {
  afterEach(cleanup);

  it("fires a command on its REMAPPED chord and no longer on the default", () => {
    const h = HANDLERS();
    renderHook(() =>
      useKeyboardShortcuts(
        h,
        true,
        resolveKeymap({ "workbench.action.saveFile": "mod+alt+s" }),
      ),
    );
    const { events, stop } = collectSaveEvents();

    dispatchKeydown({ code: "KeyS", ctrlKey: true, altKey: true }); // new
    dispatchKeydown({ code: "KeyS", ctrlKey: true }); // old — must not save
    stop();

    expect(events).toHaveLength(1);
  });

  it("still suppresses the browser dialog on an unbound mod+s / mod+p", () => {
    const h = HANDLERS();
    renderHook(() =>
      useKeyboardShortcuts(
        h,
        true,
        resolveKeymap({
          "workbench.action.saveFile": "mod+alt+s",
          "workbench.action.quickOpen": "mod+alt+o",
        }),
      ),
    );
    const { events, stop } = collectSaveEvents();
    const { preventSpy: sPrevent } = dispatchKeydown({ code: "KeyS", ctrlKey: true });
    const { preventSpy: pPrevent } = dispatchKeydown({ code: "KeyP", ctrlKey: true });
    stop();

    expect(events).toHaveLength(0);
    expect(h.onOpenQuickOpen).not.toHaveBeenCalled();
    expect(sPrevent).toHaveBeenCalled();
    expect(pPrevent).toHaveBeenCalled();
  });

  it("skips toggle-sidebar inside a text input but fires it elsewhere", () => {
    const h = HANDLERS();
    renderHook(() => useKeyboardShortcuts(h, true, resolveKeymap({})));

    const input = document.createElement("input");
    dispatchKeydown({ code: "KeyB", ctrlKey: true }, input);
    expect(h.onToggleSidebar).not.toHaveBeenCalled();

    const div = document.createElement("div");
    dispatchKeydown({ code: "KeyB", ctrlKey: true }, div);
    expect(h.onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("does not skip save / quick-open inside a text input (they are global)", () => {
    const h = HANDLERS();
    renderHook(() => useKeyboardShortcuts(h, true, resolveKeymap({})));
    const { events, stop } = collectSaveEvents();
    const input = document.createElement("input");
    dispatchKeydown({ code: "KeyS", ctrlKey: true }, input);
    dispatchKeydown({ code: "KeyP", ctrlKey: true }, input);
    stop();
    expect(events).toHaveLength(1);
    expect(h.onOpenQuickOpen).toHaveBeenCalledTimes(1);
  });

  it("does not re-register the listener when the keymap changes (one dispatch per keystroke)", () => {
    const h = HANDLERS();
    const { rerender } = renderHook(
      ({ km }) => useKeyboardShortcuts(h, true, km),
      { initialProps: { km: resolveKeymap({}) } },
    );
    const { events, stop } = collectSaveEvents();

    dispatchKeydown({ code: "KeyS", ctrlKey: true });
    rerender({ km: resolveKeymap({ "workbench.action.saveFile": "mod+alt+s" }) });
    dispatchKeydown({ code: "KeyS", ctrlKey: true, altKey: true });
    rerender({ km: resolveKeymap({ "workbench.action.saveFile": "mod+alt+shift+s" }) });
    dispatchKeydown({ code: "KeyS", ctrlKey: true, altKey: true, shiftKey: true });
    stop();

    // one per keystroke — never 2/3/4 from stacked listeners
    expect(events).toHaveLength(3);
  });

  it("removes the window listener on unmount", () => {
    const h = HANDLERS();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts(h, true, resolveKeymap({})),
    );
    const addedKeydown = add.mock.calls.filter((c) => c[0] === "keydown").length;
    unmount();
    const removedKeydown = remove.mock.calls.filter(
      (c) => c[0] === "keydown",
    ).length;
    expect(addedKeydown).toBe(1);
    expect(removedKeydown).toBe(1);
    add.mockRestore();
    remove.mockRestore();

    const { events, stop } = collectSaveEvents();
    dispatchKeydown({ code: "KeyS", ctrlKey: true });
    stop();
    expect(events).toHaveLength(0); // nothing fires after unmount
  });
});
