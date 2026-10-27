import { describe, it, expect } from "vitest";
import { applyChange, isRangeChange } from "../src/lsp/textEdit.js";

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe("applyChange", () => {
  it("inserts, deletes and replaces within and across lines", () => {
    expect(applyChange("ab\ncd", { range: r(0, 1, 0, 1), text: "X" })).toBe("aXb\ncd");
    expect(applyChange("ab\ncd", { range: r(0, 1, 1, 1), text: "" })).toBe("ad");
    expect(applyChange("ab\ncd", { range: r(1, 2, 1, 2), text: "\ne" })).toBe("ab\ncd\ne");
    expect(applyChange("", { range: r(0, 0, 0, 0), text: "hi" })).toBe("hi");
  });
  it("allows the position just past the last line end and rejects out-of-range edits", () => {
    expect(applyChange("ab", { range: r(0, 2, 0, 2), text: "c" })).toBe("abc");
    expect(applyChange("ab", { range: r(0, 3, 0, 3), text: "c" })).toBeNull();
    expect(applyChange("ab", { range: r(1, 0, 1, 0), text: "c" })).toBeNull();
    expect(applyChange("ab", { range: r(0, 1, 0, 0), text: "c" })).toBeNull();
    expect(applyChange("ab", { range: r(-1, 0, 0, 0), text: "c" })).toBeNull();
  });
  it("detects range-change shape", () => {
    expect(isRangeChange({ range: r(0, 0, 0, 0), text: "" })).toBe(true);
    expect(isRangeChange({ text: "full" })).toBe(false);
    expect(isRangeChange(null)).toBe(false);
  });
});
