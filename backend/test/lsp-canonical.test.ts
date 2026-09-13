import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  resolveCanonicalText,
  yjsDocumentSource,
} from "../src/lsp/canonical.js";

describe("lsp canonical document source", () => {
  it("does not materialize empty Y.Text keys on read", () => {
    const doc = new Y.Doc();
    const source = yjsDocumentSource(() => doc);
    expect(source.read("main.py")).toBeNull();
    expect(doc.share.has("main.py")).toBe(false);
  });

  it("prefers Yjs text over a stale client payload", () => {
    const doc = new Y.Doc();
    doc.getText("main.py").insert(0, "undefined_name\n");
    const source = yjsDocumentSource(() => doc);
    expect(resolveCanonicalText(source, "main.py", "x = 1\n")).toBe(
      "undefined_name\n",
    );
  });

  it("attaches an observer after the room and share key appear", async () => {
    const doc = new Y.Doc();
    const box: { doc?: Y.Doc } = {};
    const source = yjsDocumentSource(() => box.doc);
    const seen: string[] = [];
    const unsub = source.subscribe("main.py", (text) => seen.push(text));
    expect(source.read("main.py")).toBeNull();

    box.doc = doc;
    doc.getText("main.py").insert(0, "hello");
    const start = Date.now();
    while (!seen.includes("hello") && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toContain("hello");

    doc.getText("main.py").insert(5, " world");
    const start2 = Date.now();
    while (
      !seen.some((t) => t.includes("world")) &&
      Date.now() - start2 < 2000
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen.some((t) => t.includes("hello world"))).toBe(true);
    unsub();
  });

  it("falls back to client text when Yjs has no opinion", () => {
    const source = yjsDocumentSource(() => undefined);
    expect(resolveCanonicalText(source, "main.py", "x = 1\n")).toBe("x = 1\n");
  });
});
