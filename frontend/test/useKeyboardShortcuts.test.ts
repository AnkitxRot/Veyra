import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useKeyboardShortcuts } from "../src/hooks/useKeyboardShortcuts";

function dispatchKeydown(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  const stopSpy = vi.spyOn(event, "stopPropagation");
  const preventSpy = vi.spyOn(event, "preventDefault");
  window.dispatchEvent(event);
  return { stopSpy, preventSpy };
}

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
