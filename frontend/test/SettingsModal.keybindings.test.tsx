import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import * as React from "react";

vi.mock("../src/api", () => ({
  getProfile: () => Promise.resolve({}),
  updateProfile: () => Promise.resolve({}),
}));

import SettingsModal, {
  DEFAULT_PREFERENCES,
} from "../src/components/Settings/SettingsModal";

afterEach(cleanup);

function open(keymap: Record<string, string> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsModal
      isOpen
      preferences={{ ...DEFAULT_PREFERENCES, keymap }}
      onSave={
        onSave as unknown as React.ComponentProps<typeof SettingsModal>["onSave"]
      }
      onClose={vi.fn()}
      username="ada99"
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /keybindings/i }));
  return { onSave };
}

/** the row (listitem) whose text contains `title` */
function row(title: string) {
  return screen
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(title))!;
}

function captureChord(
  el: HTMLElement,
  init: KeyboardEventInit & { code?: string },
) {
  fireEvent.keyDown(el, { bubbles: true, ...init });
}

describe("SettingsModal — Keybindings tab (M70)", () => {
  it("lists every configurable command with its current shortcut", () => {
    open();
    for (const [title, label] of [
      ["Command Palette", /Shift\+P/i],
      ["Quick Open File", /Ctrl\+P|⌘P/i],
      ["Save Active File", /Ctrl\+S|⌘S/i],
      ["Toggle Sidebar", /Ctrl\+B|⌘B/i],
      ["Toggle Bottom Console Drawer", /Ctrl\+J|⌘J/i],
    ] as const) {
      const r = row(title);
      expect(r).toBeTruthy();
      expect(r.textContent).toMatch(label);
    }
  });

  it("reflects a persisted override instead of the default", () => {
    open({ "workbench.action.saveFile": "mod+alt+s" });
    expect(row("Save Active File").textContent).toMatch(/Alt\+S|⌥⌘S/i);
  });

  it("captures a chord, shows it, and saves only on Apply", () => {
    const { onSave } = open();
    const r = row("Save Active File");
    fireEvent.click(within(r).getByRole("button", { name: /edit|change/i }));
    const field = within(r).getByLabelText(/press the new shortcut/i);

    captureChord(field, { code: "KeyS", ctrlKey: true, altKey: true });
    // shown, not yet saved
    expect(r.textContent).toMatch(/Alt\+S|⌥⌘S/i);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(within(r).getByRole("button", { name: /apply/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual({
      keymap: { "workbench.action.saveFile": "mod+alt+s" },
    });
  });

  it("rejects an invalid / unusable captured chord and does not enable Apply", () => {
    open();
    const r = row("Save Active File");
    fireEvent.click(within(r).getByRole("button", { name: /edit|change/i }));
    const field = within(r).getByLabelText(/press the new shortcut/i);

    captureChord(field, { code: "KeyW", ctrlKey: true }); // browser-reserved
    expect(r.textContent).toMatch(/reserved|not usable|invalid/i);
    expect((within(r).getByRole("button", { name: /apply/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exposes a conflict before saving and blocks Apply", () => {
    const { onSave } = open();
    const r = row("Quick Open File");
    fireEvent.click(within(r).getByRole("button", { name: /edit|change/i }));
    const field = within(r).getByLabelText(/press the new shortcut/i);

    captureChord(field, { code: "KeyS", ctrlKey: true }); // == save's default
    expect(r.textContent).toMatch(/already|conflict|Save Active File/i);
    expect((within(r).getByRole("button", { name: /apply/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(r).getByRole("button", { name: /apply/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reset-one clears just that override", () => {
    const { onSave } = open({
      "workbench.action.saveFile": "mod+alt+s",
      "workbench.action.quickOpen": "mod+alt+o",
    });
    const r = row("Save Active File");
    fireEvent.click(within(r).getByRole("button", { name: /reset/i }));
    expect(onSave).toHaveBeenCalledWith({
      keymap: { "workbench.action.quickOpen": "mod+alt+o" },
    });
  });

  it("reset-all clears every override", () => {
    const { onSave } = open({ "workbench.action.saveFile": "mod+alt+s" });
    fireEvent.click(
      screen.getByRole("button", { name: /reset all (keybindings|shortcuts)/i }),
    );
    expect(onSave).toHaveBeenCalledWith({ keymap: {} });
  });

  it("the capture field carries data-keybinding-capture so the global dispatcher stands down", () => {
    open();
    const r = row("Save Active File");
    fireEvent.click(within(r).getByRole("button", { name: /edit|change/i }));
    const field = within(r).getByLabelText(/press the new shortcut/i);
    expect(field.closest("[data-keybinding-capture]")).toBeTruthy();
  });

  it("stays on the Keybindings tab after an Apply re-issues preferences", () => {
    // simulates IDE.tsx adopting the server response: re-render with a new
    // `preferences` object. The tab must NOT bounce back to Editor.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const base = { ...DEFAULT_PREFERENCES };
    const { rerender } = render(
      <SettingsModal
        isOpen
        preferences={base}
        onSave={onSave as any}
        onClose={vi.fn()}
        username="ada99"
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /keybindings/i }));
    expect(screen.getByRole("tab", { name: /keybindings/i }).getAttribute("aria-selected")).toBe("true");

    rerender(
      <SettingsModal
        isOpen
        preferences={{ ...base, keymap: { "workbench.action.saveFile": "mod+alt+s" } }}
        onSave={onSave as any}
        onClose={vi.fn()}
        username="ada99"
      />,
    );
    expect(screen.getByRole("tab", { name: /keybindings/i }).getAttribute("aria-selected")).toBe("true");
    // and the draft adopted the new server value
    expect(row("Save Active File").textContent).toMatch(/Alt\+S|⌥⌘S/i);
  });

  it("the editor-tab Save payload never carries keymap", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsModal
        isOpen
        preferences={{ ...DEFAULT_PREFERENCES }}
        onSave={onSave as any}
        onClose={vi.fn()}
        username="ada99"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save preferences/i }));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("keymap");
  });
});
