import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ide = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);

/**
 * M66 — "format on save" moved from a browser-only localStorage flag into the
 * typed server-persisted preference store. Source guards (rendering the
 * ~3600-line IDE.tsx is not the house style).
 */
describe("M66 — formatOnSave preference wiring", () => {
  it("derives formatOnSave from the loaded preferences, not a useState flag", () => {
    expect(ide).toContain("const formatOnSave = preferences.formatOnSave;");
    // no local setter — it is a derived value, not component state
    expect(ide).not.toContain("setFormatOnSave");
    expect(ide).not.toMatch(/useState[^\n]*cloudeee_format_on_save/);
    // the legacy key is only read once, in the one-time migration
    expect(
      ide.match(/localStorage\.getItem\("cloudeee_format_on_save"\)/g) ?? [],
    ).toHaveLength(1);
  });

  it("both toggles persist through the preference PUT, not localStorage", () => {
    expect(ide).not.toContain(
      'localStorage.setItem(\n                  "cloudeee_format_on_save"',
    );
    expect(ide).not.toMatch(/localStorage\.setItem\([^)]*cloudeee_format_on_save/);
    expect(
      ide.match(/handleUpdatePreferences\(\{ formatOnSave: next \}\)/g) ?? [],
    ).toHaveLength(2);
  });

  it("runs a one-time migration of the legacy localStorage flag", () => {
    const at = ide.indexOf("M66 one-time migration");
    expect(at).toBeGreaterThan(-1);
    const block = ide.slice(at, at + 800);
    expect(block).toContain(
      'localStorage.getItem("cloudeee_format_on_save")',
    );
    expect(block).toContain("handleUpdatePreferences({ formatOnSave: true })");
    expect(block).toContain(
      'localStorage.removeItem("cloudeee_format_on_save")',
    );
  });

  it("handleUpdatePreferences is a stable useCallback listed in the command-registry deps", () => {
    expect(ide).toContain("const handleUpdatePreferences = useCallback(");
    // it appears in the command-registry effect's dependency array
    const regAt = ide.indexOf("editor.action.toggleFormatOnSave");
    const depsTail = ide.slice(regAt, ide.indexOf("]);", regAt) + 3);
    expect(depsTail).toContain("handleUpdatePreferences,");
  });
});
