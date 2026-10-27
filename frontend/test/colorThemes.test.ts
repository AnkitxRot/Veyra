import { describe, it, expect } from "vitest";
import { BUILTIN_THEMES, parseColorTheme, themeCssVars, monacoThemeData } from "../src/colorThemes";

describe("colorThemes", () => {
  it("ships at least 8 valid built-ins with unique ids", () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(BUILTIN_THEMES.length);
    for (const t of BUILTIN_THEMES) expect(parseColorTheme(t)).not.toBeNull();
  });
  it("rejects invalid imports (bad hex, id, base, css injection)", () => {
    const ok = BUILTIN_THEMES[0]!;
    expect(parseColorTheme({ ...ok, id: "Bad Id" })).toBeNull();
    expect(parseColorTheme({ ...ok, base: "sepia" })).toBeNull();
    expect(parseColorTheme({ ...ok, palette: { ...ok.palette, accent: "red; } body{display:none" } })).toBeNull();
    expect(parseColorTheme({ ...ok, palette: { ...ok.palette, fg: undefined } })).toBeNull();
    expect(parseColorTheme(null)).toBeNull();
  });
  it("derives css vars and a monaco theme from one palette", () => {
    const t = BUILTIN_THEMES.find((x) => x.id === "github-light")!;
    expect(themeCssVars(t)["--accent"]).toBe("#0969da");
    expect(themeCssVars(t)["--glass-surface-1"]).toBe("rgba(255, 255, 255, 0.72)");
    expect(monacoThemeData(t).base).toBe("vs");
    expect(monacoThemeData(BUILTIN_THEMES.find((x) => x.id === "high-contrast")!).base).toBe("hc-black");
  });
});
