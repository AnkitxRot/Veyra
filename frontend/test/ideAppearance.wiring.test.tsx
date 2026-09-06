import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf-8");
const ide = read("../src/components/IDE/IDE.tsx");
const editor = read("../src/components/Editor/Editor.tsx");
const terminal = read("../src/components/Terminal/Terminal.tsx");
const types = read("../src/types.ts");
const settingsModal = read("../src/components/Settings/SettingsModal.tsx");

/**
 * M69 — IDE.tsx / Editor.tsx wiring for the unified appearance system. The
 * behaviour of the pieces is tested directly (useAppearance.test.tsx,
 * Editor.theme.test.tsx, ideThemeLifecycle.test.tsx); these guard that
 * IDE.tsx routes the one resolved-appearance source to the one place.
 */
describe("M69 — appearance controller wiring", () => {
  it("drives a single useAppearance from the typed theme preference", () => {
    expect(ide).toContain(
      'import { useAppearance } from "../../hooks/useAppearance"',
    );
    expect(ide.match(/useAppearance\(/g) ?? []).toHaveLength(1);
    expect(ide).toContain("useAppearance(preferences.theme)");
  });

  it("threads the resolved theme into the Editor and the Terminal", () => {
    expect(ide.match(/resolvedTheme=\{resolvedTheme\}/g) ?? []).toHaveLength(2);
  });

  it("Terminal themes xterm from the prop and updates it in place", () => {
    // create() no longer carries an inline hardcoded palette
    expect(terminal).not.toMatch(/theme:\s*\{\s*\n\s*background:/);
    expect(terminal).toContain("from './terminalThemes'");
    expect(terminal).toContain(
      "theme: TERMINAL_THEMES[resolvedThemeRef.current]",
    );
    // a theme change updates the live instance, keyed on the prop
    expect(terminal).toMatch(
      /xtermRef\.current\.options\.theme = TERMINAL_THEMES\[resolvedTheme\];\s*\}\s*\},\s*\[resolvedTheme\]\)/,
    );
    // initTerminal (which opens the WebSocket) is still keyed on project only
    expect(terminal).toMatch(/\}, \[project\?\.id\]\);/);
  });

  it("theme is a typed preference and part of the editable modal keys", () => {
    expect(types).toContain('theme: "system" | "dark" | "light";');
    expect(types).toMatch(/EDITOR_PREFERENCE_KEYS = \[[\s\S]*"theme",[\s\S]*\]/);
    expect(settingsModal).toContain("theme: 'system'");
  });

  it("leaves the M67 layout-preference wiring untouched", () => {
    // both hooks are driven off the same `preferences` object but are
    // otherwise independent — no shared state, no ordering coupling.
    expect(ide).toContain("useLayoutPreferences(layoutLoaded, persistLayout)");
    expect(ide).toContain("useAppearance(preferences.theme)");
    // the appearance hook does not touch the layout persist path
    const block = ide.slice(
      ide.indexOf("useAppearance(preferences.theme)"),
      ide.indexOf("useAppearance(preferences.theme)") + 300,
    );
    expect(block).not.toContain("persistLayout");
    expect(block).not.toContain("handleUpdatePreferences");
  });

  it("the settings modal renders a Theme select bound to formData.theme", () => {
    expect(settingsModal).toContain('id="settings-theme"');
    expect(settingsModal).toContain("value={formData.theme}");
    for (const v of ['value="system"', 'value="dark"', 'value="light"']) {
      expect(settingsModal).toContain(v);
    }
    // it saves through the existing editor-preference path
    expect(settingsModal).toContain("onSave(pickEditorPrefs(formData))");
  });

  it("Editor themes Monaco from the prop and updates it in place", () => {
    // create() uses the resolved theme, not a hardcoded 'vs-dark'
    expect(editor).not.toMatch(/theme:\s*["']vs-dark["']/);
    expect(editor).toContain("theme: monacoThemeRef.current");
    // a live theme change goes through the global setTheme, keyed on the prop
    const at = editor.indexOf("monaco.editor.setTheme(monacoThemeRef.current)");
    expect(at).toBeGreaterThan(-1);
    const block = editor.slice(at - 200, at + 80);
    expect(block).toContain("if (!monacoRef.current) return;");
    expect(editor).toMatch(
      /monaco\.editor\.setTheme\(monacoThemeRef\.current\);\s*\},\s*\[resolvedTheme\]\)/,
    );
    // no monaco.editor.create inside the theme effect
    expect(block).not.toContain("monaco.editor.create");
  });
});
