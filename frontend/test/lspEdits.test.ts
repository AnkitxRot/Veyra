import { describe, it, expect } from "vitest";
import { splitChanges, toMonacoEdits } from "../src/lsp/edits";

const edit = { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "x" };

describe("lsp edits", () => {
  it("converts to 1-based monaco edits and drops malformed", () => {
    expect(toMonacoEdits([edit, { newText: 1 }, null])).toEqual([
      { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 }, text: "x" },
    ]);
    expect(toMonacoEdits("nope")).toEqual([]);
  });
  it("splits open vs unopened files", () => {
    const r = splitChanges({ "u:a": [edit], "u:b": [edit], "u:c": [] }, (u) => u.slice(2), (p) => p === "a");
    expect(r.open.map((o) => o.path)).toEqual(["a"]);
    expect(r.skipped).toEqual(["b"]);
  });
});
