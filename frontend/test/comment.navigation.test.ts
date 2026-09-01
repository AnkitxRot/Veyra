import { describe, it, expect } from "vitest";
import { countsByFile, navigableThreads, nextInFile, previousInFile, nextUnresolved } from "../src/comments/navigation";
import type { CommentThreadDTO } from "../src/types";

function t(over: Partial<CommentThreadDTO> & { id: string; filePath: string; startLine: number; resolvedAt?: string | null; anchorStatus?: string; deletedAt?: string | null }): CommentThreadDTO {
  return {
    id: over.id,
    projectId: "p",
    filePath: over.filePath,
    anchor: {
      relStart: "A",
      relEnd: "B",
      slice: "x",
      startLine: over.startLine,
      endLine: over.startLine,
      prefixHash: "0".repeat(16),
    },
    anchorStatus: (over.anchorStatus as any) ?? "ok",
    createdBy: 1,
    createdAt: "",
    updatedAt: "",
    resolvedAt: over.resolvedAt ?? null,
    resolvedBy: null,
    root: {
      id: `c-${over.id}`,
      threadId: over.id,
      parentId: null,
      authorId: 1,
      body: "hi",
      createdAt: "",
      editedAt: null,
      deletedAt: over.deletedAt ?? null,
      reactions: [],
    },
    replies: [],
    mentions: [],
  } as CommentThreadDTO;
}

describe("M61-A comment navigation helpers", () => {
  it("navigableThreads skips stale, resolved, deleted and sorts by line", () => {
    const threads = [
      t({ id: "a", filePath: "a.ts", startLine: 10 }),
      t({ id: "b", filePath: "a.ts", startLine: 2, anchorStatus: "stale" }),
      t({ id: "c", filePath: "a.ts", startLine: 5, resolvedAt: "now" }),
      t({ id: "d", filePath: "a.ts", startLine: 3, deletedAt: "now" }),
      t({ id: "e", filePath: "a.ts", startLine: 7 }),
    ];
    const nav = navigableThreads(threads);
    expect(nav.map((x) => x.id)).toEqual(["e", "a"]); // 7 then 10? Wait e is 7, a is 10, sorted ascending => e then a
    // Actually a is 10, e is 7 => order e (7), a (10)
    expect(nav[0].id).toBe("e");
    expect(nav[1].id).toBe("a");
  });

  it("nextInFile cycles and previousInFile wraps", () => {
    const threads = [t({ id: "1", filePath: "a.ts", startLine: 1 }), t({ id: "2", filePath: "a.ts", startLine: 5 }), t({ id: "3", filePath: "a.ts", startLine: 10 })];
    expect(nextInFile(threads, null)!.id).toBe("1");
    expect(nextInFile(threads, "1")!.id).toBe("2");
    expect(nextInFile(threads, "3")!.id).toBe("1"); // wrap
    expect(previousInFile(threads, null)!.id).toBe("3");
    expect(previousInFile(threads, "1")!.id).toBe("3");
    expect(previousInFile(threads, "2")!.id).toBe("1");
  });

  it("nextInFile returns null when no navigable threads", () => {
    expect(nextInFile([t({ id: "x", filePath: "a.ts", startLine: 1, anchorStatus: "stale" })], null)).toBeNull();
  });

  it("nextUnresolved cycles through unresolved list", () => {
    const unresolved = [t({ id: "u1", filePath: "a.ts", startLine: 1 }), t({ id: "u2", filePath: "b.ts", startLine: 2 })];
    expect(nextUnresolved(unresolved, null)!.id).toBe("u1");
    expect(nextUnresolved(unresolved, "u1")!.id).toBe("u2");
    expect(nextUnresolved(unresolved, "u2")!.id).toBe("u1");
  });

  it("countsByFile groups active only, skips stale/deleted/resolved", () => {
    const unresolved = [
      t({ id: "1", filePath: "a.ts", startLine: 1 }),
      t({ id: "2", filePath: "a.ts", startLine: 2 }),
      t({ id: "3", filePath: "b.ts", startLine: 3 }),
      t({ id: "4", filePath: "a.ts", startLine: 4, anchorStatus: "stale" }),
      t({ id: "5", filePath: "b.ts", startLine: 5, deletedAt: "now" }),
      t({ id: "6", filePath: "c.ts", startLine: 6, resolvedAt: "now" }),
    ];
    const m = countsByFile(unresolved as any);
    expect(m.get("a.ts")).toBe(2);
    expect(m.get("b.ts")).toBe(1);
    expect(m.get("c.ts")).toBeUndefined();
    expect(m.get("auth/session.ts")).toBeUndefined();
  });

  it("countsByFile returns empty map when no unresolved", () => {
    expect(countsByFile([]).size).toBe(0);
  });
});
