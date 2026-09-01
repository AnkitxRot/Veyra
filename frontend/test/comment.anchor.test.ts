import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { encodeAnchor, resolveAnchor, fuzzyMatchSlice } from "../src/comments/anchor";

const docWith = (t: string) => {
  const d = new Y.Doc();
  d.getText("f").insert(0, t);
  return d;
};

describe("M61-A comment anchor math", () => {
  it("exact after an insertion ABOVE the anchor", async () => {
    const d = docWith("line1\nline2\nTARGET\nline4\n");
    const t = d.getText("f");
    const s = "line1\nline2\n".length;
    const e = s + "TARGET".length;
    const a = await encodeAnchor(t, s, e);
    t.insert(0, "new\nnew\n");
    const r = await resolveAnchor(d, "f", a);
    expect(r.state).toBe("exact");
    expect(r.range!.startLineNumber).toBe(5);
  });

  it("stale when the whole anchored range is replaced", async () => {
    const d = docWith("a\nTARGET LINE\nb\n");
    const t = d.getText("f");
    const a = await encodeAnchor(t, 2, 2 + "TARGET LINE".length);
    t.delete(0, t.length);
    t.insert(0, "completely different content\n");
    const r = await resolveAnchor(d, "f", a);
    expect(r.state).toBe("stale");
    expect(r.range).toBeNull();
  });

  it("stale + recovery line when the slice moved", async () => {
    const d = docWith("header\nconst x = compute(a, b)\nfooter\n");
    const t = d.getText("f");
    const s = "header\n".length;
    const e = s + "const x = compute(a, b)".length;
    const a = await encodeAnchor(t, s, e);
    t.delete(0, t.length);
    t.insert(
      0,
      "new header\nnew line\nanother\nconst x = compute(a, b)\nend\n",
    );
    const r = await resolveAnchor(d, "f", a);
    expect(r.state).toBe("stale");
    expect(r.recovery?.line).toBe(4);
  });

  it("drifted (no warning) when anchored text changed length in place", async () => {
    const d = docWith("x\nTARGET\ny\n");
    const t = d.getText("f");
    const a = await encodeAnchor(t, 2, 2 + "TARGET".length);
    t.insert(2 + "TAR".length, "XXX");
    const r = await resolveAnchor(d, "f", a);
    expect(r.state).toBe("drifted");
    expect(r.range!.startLineNumber).toBe(2);
  });

  it("fuzzyMatchSlice returns null for a weak match (never auto-jump)", () => {
    const r = fuzzyMatchSlice(
      "totally\nunrelated\nlines\nhere\n",
      "const x = compute(a, b)",
    );
    expect(r).toBeNull();
  });
});
