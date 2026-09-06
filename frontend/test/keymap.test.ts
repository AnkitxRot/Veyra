import { describe, it, expect } from "vitest";
import {
  CONFIGURABLE_COMMANDS,
  DEFAULT_KEYMAP,
  isValidChord,
  chordFromEvent,
  chordToDisplay,
  chordToMonacoKeybinding,
  resolveKeymap,
  findConflict,
  type CommandId,
} from "../src/keymap/keymap";

const SAVE: CommandId = "workbench.action.saveFile";
const QUICK_OPEN: CommandId = "workbench.action.quickOpen";
const PALETTE: CommandId = "workbench.action.showCommands";
const SIDEBAR: CommandId = "workbench.action.toggleSidebar";

/** Minimal KeyboardEvent-ish stand-in (jsdom `KeyboardEvent` also works). */
function kev(
  over: Partial<KeyboardEvent> & { code?: string; key?: string },
): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  } as KeyboardEvent;
}

describe("keymap — command set", () => {
  it("has exactly the five configurable IDE-chrome commands with default chords", () => {
    expect(CONFIGURABLE_COMMANDS.map((c) => c.id).sort()).toEqual(
      [
        "workbench.action.quickOpen",
        "workbench.action.saveFile",
        "workbench.action.showCommands",
        "workbench.action.toggleBottomPanel",
        "workbench.action.toggleSidebar",
      ],
    );
    expect(DEFAULT_KEYMAP[SAVE]).toBe("mod+s");
    expect(DEFAULT_KEYMAP[PALETTE]).toBe("mod+shift+p");
    // toggle-sidebar is the one command skipped inside a text input (Ctrl+B = bold)
    expect(
      CONFIGURABLE_COMMANDS.find((c) => c.id === SIDEBAR)!.skipInTextInput,
    ).toBe(true);
    expect(
      CONFIGURABLE_COMMANDS.find((c) => c.id === SAVE)!.skipInTextInput,
    ).toBe(false);
  });
});

describe("isValidChord", () => {
  it("accepts canonical mod-anchored chords", () => {
    for (const c of ["mod+s", "mod+p", "mod+shift+p", "mod+alt+k", "mod+alt+shift+f", "mod+1", "mod+/", "mod+f5"]) {
      expect(isValidChord(c), c).toBe(true);
    }
  });

  it("rejects bare keys, shift-only, raw ctrl, bad order, uppercase, and empty", () => {
    for (const c of ["s", "p", "shift+p", "alt+k", "ctrl+p", "meta+p", "shift+mod+p", "Mod+S", "MOD+S", "mod+shift+", "mod+", ""]) {
      expect(isValidChord(c), c).toBe(false);
    }
  });

  it("rejects browser/OS-reserved combinations", () => {
    for (const c of ["mod+w", "mod+t", "mod+n", "mod+q", "mod+r", "mod+shift+w", "mod+shift+t", "mod+shift+i", "mod+shift+j"]) {
      expect(isValidChord(c), c).toBe(false);
    }
  });
});

describe("chordFromEvent", () => {
  it("builds a canonical chord in fixed mod/alt/shift/key order (from e.code)", () => {
    expect(chordFromEvent(kev({ code: "KeyS", ctrlKey: true }))).toBe("mod+s");
    expect(
      chordFromEvent(kev({ code: "KeyP", ctrlKey: true, shiftKey: true })),
    ).toBe("mod+shift+p");
    expect(
      chordFromEvent(kev({ code: "KeyK", ctrlKey: true, altKey: true, shiftKey: true })),
    ).toBe("mod+alt+shift+k");
  });

  it("is layout / shift stable — Digit1 with shift is still '1', not '!'", () => {
    expect(
      chordFromEvent(kev({ code: "Digit1", key: "!", ctrlKey: true, shiftKey: true })),
    ).toBe("mod+shift+1");
  });

  it("falls back to e.key for synthetic events with no code", () => {
    expect(chordFromEvent(kev({ key: "s", ctrlKey: true }))).toBe("mod+s");
  });

  it("returns null for a bare modifier keydown or an unmappable key", () => {
    expect(chordFromEvent(kev({ code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(kev({ code: "ShiftLeft", shiftKey: true }))).toBeNull();
    expect(chordFromEvent(kev({ code: "Tab", ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(kev({ code: "Enter", ctrlKey: true }))).toBeNull();
  });

  it("returns null when there is no primary modifier (plain typing never matches)", () => {
    expect(chordFromEvent(kev({ code: "KeyS" }))).toBeNull();
    expect(chordFromEvent(kev({ code: "KeyS", shiftKey: true }))).toBeNull();
  });
});

describe("chordToDisplay", () => {
  it("renders the platform label", () => {
    expect(chordToDisplay("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(chordToDisplay("mod+shift+p", true)).toBe("⇧⌘P");
    expect(chordToDisplay("mod+s", false)).toBe("Ctrl+S");
    expect(chordToDisplay("mod+s", true)).toBe("⌘S");
    expect(chordToDisplay("mod+alt+k", true)).toBe("⌥⌘K");
    expect(chordToDisplay("mod+f5", false)).toBe("Ctrl+F5");
  });
});

describe("resolveKeymap", () => {
  it("layers overrides on the defaults and builds a reverse index", () => {
    const r = resolveKeymap({ [SAVE]: "mod+alt+s" });
    expect(r.byCommand[SAVE]).toBe("mod+alt+s");
    expect(r.byCommand[QUICK_OPEN]).toBe("mod+p"); // still default
    expect(r.byChord.get("mod+alt+s")).toBe(SAVE);
    expect(r.byChord.get("mod+s")).toBeUndefined(); // freed by the remap
    expect(r.byChord.get("mod+p")).toBe(QUICK_OPEN);
  });

  it("ignores overrides for unknown command IDs", () => {
    const r = resolveKeymap({ "x.y.z": "mod+k" } as Record<string, string>);
    expect(r.byCommand[SAVE]).toBe("mod+s");
    expect(r.byChord.has("mod+k")).toBe(false);
  });
});

describe("findConflict", () => {
  it("reports the command that already owns a candidate chord", () => {
    // assigning save's default onto quick-open
    expect(findConflict({}, QUICK_OPEN, "mod+s")).toBe(SAVE);
    // no conflict when the chord is free
    expect(findConflict({}, QUICK_OPEN, "mod+alt+o")).toBeNull();
    // no self-conflict
    expect(findConflict({ [SAVE]: "mod+alt+s" }, SAVE, "mod+alt+s")).toBeNull();
    // a straight swap is not a conflict when evaluated together
    expect(findConflict({ [QUICK_OPEN]: "mod+s" }, SAVE, "mod+p")).toBeNull();
  });
});

describe("chordToMonacoKeybinding", () => {
  const monaco = {
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
    KeyCode: { KeyS: 49, KeyP: 46, Digit1: 22, Slash: 90, F5: 63 },
  };
  it("converts a canonical chord to a Monaco keybinding bitmask", () => {
    expect(chordToMonacoKeybinding("mod+s", monaco)).toBe(2048 | 49);
    expect(chordToMonacoKeybinding("mod+alt+s", monaco)).toBe(2048 | 512 | 49);
    expect(chordToMonacoKeybinding("mod+shift+p", monaco)).toBe(2048 | 1024 | 46);
  });
  it("returns null for a key Monaco's KeyCode map does not cover", () => {
    expect(chordToMonacoKeybinding("mod+`", monaco)).toBeNull();
  });
});
