import { describe, it, expect } from "vitest";
import { diffToChange, type RangeChange } from "../src/lsp/textDiff";

function apply(text: string, c: RangeChange): string {
  const off = (p: { line: number; character: number }) => {
    let o = 0;
    for (let l = 0; l < p.line; l++) o = text.indexOf("\n", o) + 1;
    return o + p.character;
  };
  return text.slice(0, off(c.range.start)) + c.text + text.slice(off(c.range.end));
}

describe("diffToChange", () => {
  it("returns null for identical text", () => expect(diffToChange("a", "a")).toBeNull());
  it("round-trips edits (insert, delete, replace, multi-line, emoji)", () => {
    const cases: [string, string][] = [
      ["", "hello"],
      ["hello", ""],
      ["abc", "abXc"],
      ["a\nb\nc", "a\nB\nc"],
      ["a\nb\nc", "a\nc"],
      ["line1\nline2", "line1\nline2\nline3\n"],
      ["x = 1\n", "x = 12\n"],
      ["aaaa", "aaaaa"],
      ["a😀b", "a😁b"],
      ["a😀b", "a😀😀b"],
    ];
    for (const [a, b] of cases) {
      const c = diffToChange(a, b)!;
      expect(apply(a, c)).toBe(b);
    }
  });
  it("is small for a one-char edit in a large file", () => {
    const big = "line\n".repeat(5000);
    const c = diffToChange(big, big.slice(0, 7000) + "Z" + big.slice(7000))!;
    expect(c.text).toBe("Z");
  });
});
