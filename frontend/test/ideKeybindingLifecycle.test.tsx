import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import { useKeyboardShortcuts } from "../src/hooks/useKeyboardShortcuts";
import { resolveKeymap } from "../src/keymap/keymap";

// M70 — end-to-end lifecycle: the typed `keymap` preference -> `resolveKeymap`
// (memoised, as IDE.tsx does it) -> `useKeyboardShortcuts` -> command dispatch.
// Proves hydration, remap, browser-shortcut passthrough, and that a preference
// change never stacks or leaks the window listener.

function key(init: KeyboardEventInit & { code?: string }, target?: EventTarget) {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (target) Object.defineProperty(e, "target", { value: target });
  const preventSpy = vi.spyOn(e, "preventDefault");
  window.dispatchEvent(e);
  return { preventSpy };
}

/** Mirrors IDE.tsx's keymap wiring around a bare surface. */
function KeymapHarness({
  keymap,
  onCommand,
}: {
  keymap: Record<string, string>;
  onCommand: (id: string) => void;
}) {
  const resolved = React.useMemo(() => resolveKeymap(keymap), [keymap]);
  useKeyboardShortcuts(
    {
      onOpenCommandPalette: () => onCommand("palette"),
      onOpenQuickOpen: () => onCommand("quickOpen"),
      getActiveFile: () => "a.py",
      onToggleSidebar: () => onCommand("sidebar"),
      onToggleBottomPanel: () => onCommand("bottom"),
    },
    true,
    resolved,
  );
  return null;
}

function saveEvents() {
  const events: CustomEvent[] = [];
  const l = (e: Event) => events.push(e as CustomEvent);
  document.addEventListener("ide-save", l);
  return { events, stop: () => document.removeEventListener("ide-save", l) };
}

afterEach(cleanup);

describe("M70 — keybinding lifecycle (integration)", () => {
  it("hydrates a persisted override — the command fires on the stored chord", () => {
    const onCommand = vi.fn();
    render(
      <KeymapHarness
        keymap={{ "workbench.action.toggleSidebar": "mod+alt+b" }}
        onCommand={onCommand}
      />,
    );
    key({ code: "KeyB", ctrlKey: true, altKey: true });
    expect(onCommand).toHaveBeenCalledWith("sidebar");
    // the default chord is now free
    onCommand.mockClear();
    key({ code: "KeyB", ctrlKey: true });
    expect(onCommand).not.toHaveBeenCalledWith("sidebar");
  });

  it("re-resolves on a preference change with no listener stacking", () => {
    const onCommand = vi.fn();
    const { rerender } = render(
      <KeymapHarness keymap={{}} onCommand={onCommand} />,
    );
    const { events, stop } = saveEvents();

    key({ code: "KeyS", ctrlKey: true }); // default -> save
    act(() => {
      rerender(
        <KeymapHarness
          keymap={{ "workbench.action.saveFile": "mod+alt+s" }}
          onCommand={onCommand}
        />,
      );
    });
    key({ code: "KeyS", ctrlKey: true, altKey: true }); // new -> save
    key({ code: "KeyS", ctrlKey: true }); // old -> suppressed, no save
    stop();

    expect(events).toHaveLength(2); // one per real save keystroke, never doubled
  });

  it("leaves copy / paste / cut / undo / redo / select-all completely untouched", () => {
    const onCommand = vi.fn();
    render(<KeymapHarness keymap={{}} onCommand={onCommand} />);
    const { events, stop } = saveEvents();
    for (const code of ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyY", "KeyA"]) {
      const { preventSpy } = key({ code, ctrlKey: true });
      expect(preventSpy, code).not.toHaveBeenCalled();
    }
    stop();
    expect(events).toHaveLength(0);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("normal typing in a text input never triggers a command", () => {
    const onCommand = vi.fn();
    render(<KeymapHarness keymap={{}} onCommand={onCommand} />);
    const { events, stop } = saveEvents();
    const input = document.createElement("input");
    for (const code of ["KeyS", "KeyP", "KeyB", "KeyJ", "KeyH", "KeyI"]) {
      key({ code }, input); // no modifier — plain typing
    }
    stop();
    expect(events).toHaveLength(0);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("only one window keydown listener exists regardless of re-renders", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onCommand = vi.fn();
    const { rerender, unmount } = render(
      <KeymapHarness keymap={{}} onCommand={onCommand} />,
    );
    for (let i = 0; i < 5; i++) {
      rerender(
        <KeymapHarness
          keymap={{ "workbench.action.saveFile": `mod+alt+${"sdfgh"[i]}` }}
          onCommand={onCommand}
        />,
      );
    }
    const added = add.mock.calls.filter((c) => c[0] === "keydown").length;
    unmount();
    const removed = remove.mock.calls.filter((c) => c[0] === "keydown").length;
    expect(added).toBe(1);
    expect(removed).toBe(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
