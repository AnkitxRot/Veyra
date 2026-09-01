import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as api from "../src/comments/api";
import { CommentStore } from "../src/comments/store";

describe("M61-A CommentStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("applyEvent triggers one throttled scoped refetch per file", async () => {
    const spy = vi
      .spyOn(api, "fetchThreads")
      .mockResolvedValue({ threads: [], nextBefore: null });
    const s = new CommentStore("p");
    s.applyEvent({
      type: "comment_event",
      threadId: "t",
      filePath: "a.ts",
      kind: "created",
      at: 1,
    });
    s.applyEvent({
      type: "comment_event",
      threadId: "t",
      filePath: "a.ts",
      kind: "replied",
      at: 2,
    });
    s.applyEvent({
      type: "comment_event",
      threadId: "u",
      filePath: "b.ts",
      kind: "created",
      at: 3,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith("p", "a.ts", expect.anything());
    expect(spy).toHaveBeenCalledWith("p", "b.ts", expect.anything());
  });

  it("load() stores threads per file and notifies subscribers", async () => {
    const thread = {
      id: "t1",
      filePath: "a.ts",
      root: { id: "c1" },
    } as any;
    vi.spyOn(api, "fetchThreads").mockResolvedValue({
      threads: [thread],
      nextBefore: null,
    });
    const s = new CommentStore("p");
    const cb = vi.fn();
    s.on(cb);
    await s.load("a.ts");
    expect(s.threadsFor("a.ts")).toEqual([thread]);
    expect(cb).toHaveBeenCalled();
  });

  it("dispose() cancels pending refetches", async () => {
    const spy = vi
      .spyOn(api, "fetchThreads")
      .mockResolvedValue({ threads: [], nextBefore: null });
    const s = new CommentStore("p");
    s.applyEvent({
      type: "comment_event",
      threadId: "t",
      filePath: "a.ts",
      kind: "created",
      at: 1,
    });
    s.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(spy).not.toHaveBeenCalled();
  });
});
