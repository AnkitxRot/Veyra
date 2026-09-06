import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf-8");
const ide = read("../src/components/IDE/IDE.tsx");
const editor = read("../src/components/Editor/Editor.tsx");
const hook = read("../src/hooks/useKeyboardShortcuts.ts");
const types = read("../src/types.ts");

/**
 * M70 — IDE.tsx / Editor.tsx / hook wiring for configurable keybindings.
 * Behaviour is tested directly (keymap.test.ts, useKeyboardShortcuts.test.ts,
 * Editor.saveTruthfulness.test.tsx, ideKeybindingLifecycle.test.tsx); these
 * guard that the one resolved keymap flows to the one dispatcher.
 */
describe("M70 — keybinding wiring", () => {
  it("IDE resolves ONE keymap from the typed preference and feeds the dispatcher", () => {
    expect(ide).toContain('import {\n  resolveKeymap,');
    expect(ide.match(/resolveKeymap\(/g) ?? []).toHaveLength(1);
    expect(ide).toContain("resolveKeymap(preferences.keymap)");
    // passed as the 3rd arg to the single hook call
    const at = ide.indexOf("useKeyboardShortcuts(");
    const call = ide.slice(at, at + 700);
    expect(call).toContain("resolvedKeymap,");
  });

  it("the command-palette labels for the five commands come from the resolved keymap", () => {
    for (const id of [
      "workbench.action.quickOpen",
      "workbench.action.showCommands",
      "workbench.action.saveFile",
      "workbench.action.toggleSidebar",
      "workbench.action.toggleBottomPanel",
    ]) {
      expect(ide).toContain(`kbLabel("${id}", false)`);
      expect(ide).toContain(`kbLabel("${id}", true)`);
    }
    // no hardcoded shortcut strings left for those five
    expect(ide).not.toContain('shortcut: "Ctrl+S"');
    expect(ide).not.toContain('shortcut: "Ctrl+P"');
  });

  it("the hook dispatches by keymap lookup, not five hardcoded chord checks", () => {
    expect(hook).toContain("keymapRef.current.byChord.get(chord)");
    expect(hook).not.toMatch(/key === ['"]s['"]/);
    // listener lifecycle bound only to `enabled` — keymap read via ref
    expect(hook).toMatch(/\}, \[enabled\]\);/);
    expect(hook).toContain("keymapRef.current = resolvedKeymap;");
    // the always-suppress guard for the browser save/print dialog
    expect(hook).toContain("ALWAYS_SUPPRESS");
  });

  it("Editor takes the save chord and registers a disposable Monaco action", () => {
    expect(ide).toContain(
      'saveChord={resolvedKeymap.byCommand["workbench.action.saveFile"]}',
    );
    expect(editor).toContain("chordToMonacoKeybinding");
    expect(editor).not.toMatch(/addCommand\(\s*monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyS/);
    expect(editor).toContain('id: "cloudeee.action.save"');
    expect(editor).toContain("saveActionRef.current?.dispose()");
  });

  it("keymap is a typed preference, excluded from the editor-tab payload", () => {
    expect(types).toContain("keymap: Record<string, string>;");
    // NOT in EDITOR_PREFERENCE_KEYS (own tab, like the layout keys)
    const at = types.indexOf("EDITOR_PREFERENCE_KEYS = [");
    const block = types.slice(at, types.indexOf("]", at));
    expect(block).not.toContain('"keymap"');
  });
});
