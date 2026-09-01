import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { KeepDeduper, keepCalloutAsComment } from "../src/comments/keep";
import type { AttentionEvent } from "../src/collab/attention";

vi.mock("../src/comments/api", () => ({
  createThread: vi.fn(async (_pid: string, input: any) => ({
    thread: { id: "new-thread", filePath: input.filePath, anchor: input.anchor, root: { body: input.body } },
  })),
}));

import * as api from "../src/comments/api";

const makeCallout = (over: Partial<AttentionEvent> = {}): AttentionEvent => ({
  id: over.id ?? "c1",
  kind: "callout",
  author: over.author ?? { userId: 7, username: "Rahul", color: "#89b4fa" },
  file: over.file ?? "src/a.ts",
  range: over.range ?? { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
  message: over.message ?? "look here",
  createdAt: Date.now(),
  expiresAt: Date.now() + 90000,
  ...over,
});

describe("M61-A keepCalloutAsComment", () => {
  let deduper: KeepDeduper;
  beforeEach(() => {
    deduper = new KeepDeduper();
    vi.clearAllMocks();
  });

  it("creates a persistent thread via the canonical API and does not mutate the original callout", async () => {
    const doc = new Y.Doc();
    doc.getText("src/a.ts").insert(0, "hello world\n");
    const callout = makeCallout({ id: "keep-1", file: "src/a.ts", message: "keep me" });
    const res = await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    expect(res).not.toBeNull();
    expect(api.createThread).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({ filePath: "src/a.ts", body: "keep me", mentions: [] }),
    );
    // Callout object itself is unchanged (message still there, not cleared)
    expect(callout.message).toBe("keep me");
    // Deduper now has it
    expect(deduper.has("keep-1")).toBe(true);
  });

  it("does not create duplicate persistence for the same callout id (second Keep is no-op)", async () => {
    const doc = new Y.Doc();
    doc.getText("src/a.ts").insert(0, "hello\n");
    const callout = makeCallout({ id: "dup-1" });
    const r1 = await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    const r2 = await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
    expect(api.createThread).toHaveBeenCalledTimes(1);
  });

  it("releases the claim on failure so a retry can succeed", async () => {
    const doc = new Y.Doc();
    doc.getText("src/a.ts").insert(0, "hello\n");
    const callout = makeCallout({ id: "fail-1" });
    // First call fails (mock rejection)
    vi.mocked(api.createThread).mockRejectedValueOnce(new Error("network"));
    const r1 = await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    expect(r1).toBeNull();
    expect(deduper.has("fail-1")).toBe(false);
    // Second call succeeds
    vi.mocked(api.createThread).mockResolvedValueOnce({ thread: { id: "ok" } } as any);
    const r2 = await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    expect(r2).not.toBeNull();
    expect(deduper.has("fail-1")).toBe(true);
  });

  it("returns null for a non-callout kind (point)", async () => {
    const doc = new Y.Doc();
    const callout = makeCallout({ kind: "point" as any, message: undefined });
    const res = await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    expect(res).toBeNull();
    expect(api.createThread).not.toHaveBeenCalled();
  });

  it("captures file, range and message through the server path (anchor startLine matches callout range)", async () => {
    const doc = new Y.Doc();
    const content = "line1\nline2\nTARGET\nline4\n";
    doc.getText("src/a.ts").insert(0, content);
    const callout = makeCallout({
      file: "src/a.ts",
      range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 7 },
      message: "original message",
    });
    await keepCalloutAsComment({ callout, doc, projectId: "p" }, deduper);
    const arg = vi.mocked(api.createThread).mock.calls[0][1] as any;
    expect(arg.filePath).toBe("src/a.ts");
    expect(arg.anchor.startLine).toBe(3);
    expect(arg.body).toBe("original message");
  });
});
