import { describe, it, expect } from "vitest";
import { mergeLayers, parseSettingsJson, sanitizeLayer, sourceOf, filterSchema, validateSetting } from "../src/settingsSchema";

describe("settingsSchema", () => {
  it("validates by type, range and enum", () => {
    expect(validateSetting("fontSize", 14)).toBe(true);
    expect(validateSetting("fontSize", 2)).toBe(false);
    expect(validateSetting("fontSize", "14")).toBe(false);
    expect(validateSetting("wordWrap", "on")).toBe(true);
    expect(validateSetting("wordWrap", "bogus")).toBe(false);
    expect(validateSetting("nope", 1)).toBe(false);
    expect(validateSetting("fontFamily", "Fira Code, monospace")).toBe(true);
    expect(validateSetting("fontFamily", "x;}body{display:none")).toBe(false);
  });
  it("sanitizes untrusted project JSON", () => {
    expect(parseSettingsJson('{"tabSize":2,"evil":1,"minimap":"yes"}')).toEqual({ tabSize: 2 });
    expect(parseSettingsJson("garbage")).toEqual({});
    expect(sanitizeLayer([1])).toEqual({});
  });
  it("layers: project > user > default", () => {
    const base = { fontSize: 13, tabSize: 4 };
    expect(mergeLayers(base, { fontSize: 15 }, { tabSize: 2 })).toEqual({ fontSize: 15, tabSize: 2 });
    expect(mergeLayers(base, { tabSize: 8 }, { tabSize: 2 }).tabSize).toBe(2);
    expect(sourceOf("tabSize", { tabSize: 8 }, { tabSize: 2 })).toBe("project");
    expect(sourceOf("fontSize", { fontSize: 1 }, {})).toBe("user");
    expect(sourceOf("minimap", {}, {})).toBe("default");
  });
  it("searches label, key and description", () => {
    expect(filterSchema("wrap").map((d) => d.key)).toContain("wordWrap");
    expect(filterSchema("").length).toBeGreaterThan(9);
  });
});
