import { describe, it, expect } from "vitest";
import { sanitizeWorkspaceEdit, sanitizeCodeActions } from "../src/lsp/workspaceEdit.js";

const te = (newText = "x") => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  newText,
});

describe("sanitizeWorkspaceEdit", () => {
  it("normalises documentChanges and changes into a changes map of text edits only", () => {
    const e = sanitizeWorkspaceEdit({
      documentChanges: [
        { textDocument: { uri: "file:///workspace/a.ts", version: 1 }, edits: [te("A")] },
        { kind: "delete", uri: "file:///workspace/b.ts" },
        { kind: "rename", oldUri: "file:///workspace/c.ts", newUri: "file:///workspace/d.ts" },
      ],
      changes: { "file:///workspace/e.ts": [te("E")] },
    });
    expect(Object.keys(e!.changes).sort()).toEqual(["file:///workspace/a.ts", "file:///workspace/e.ts"]);
    expect(e!.changes["file:///workspace/a.ts"]![0]!.newText).toBe("A");
  });
  it("drops files outside the workspace and rejects malformed edits", () => {
    const e = sanitizeWorkspaceEdit({
      changes: {
        "file:///etc/passwd": [te()],
        "file:///workspace/ok.ts": [te(), { range: 5, newText: "bad" }, { range: te().range, newText: 3 }],
      },
    });
    expect(Object.keys(e!.changes)).toEqual(["file:///workspace/ok.ts"]);
    expect(e!.changes["file:///workspace/ok.ts"]).toHaveLength(1);
  });
  it("enforces file and edit caps", () => {
    const changes: Record<string, unknown[]> = {};
    for (let i = 0; i < 80; i++) changes[`file:///workspace/f${i}.ts`] = [te()];
    expect(sanitizeWorkspaceEdit({ changes })).toBeNull();
    expect(sanitizeWorkspaceEdit({ changes: { "file:///workspace/a.ts": Array(6000).fill(te()) } })).toBeNull();
  });
  it("returns null for junk", () => {
    expect(sanitizeWorkspaceEdit(null)).toBeNull();
    expect(sanitizeWorkspaceEdit("x")).toBeNull();
  });
});

describe("sanitizeCodeActions", () => {
  it("keeps only edit-bearing actions, strips commands, caps the list", () => {
    const out = sanitizeCodeActions([
      { title: "Organize imports", kind: "source.organizeImports", edit: { changes: { "file:///workspace/a.ts": [te()] } }, command: { command: "x", title: "x" } },
      { title: "Run command", command: "rm", arguments: [] },
      { title: "Fix", kind: "quickfix", command: { command: "c", title: "c" } },
      { title: "Bad edit", edit: { changes: { "file:///etc/x": [te()] } } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Organize imports", kind: "source.organizeImports" });
    expect(out[0]).not.toHaveProperty("command");
  });
  it("tolerates non-arrays", () => {
    expect(sanitizeCodeActions(null)).toEqual([]);
  });
});
