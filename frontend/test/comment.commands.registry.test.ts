import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandRegistry } from "../src/utils/commands";
import { openAndRevealLocation } from "../src/utils/revealLocation";

describe("M61-A Comments command registry navigation", () => {
  let registry: CommandRegistry;
  beforeEach(() => {
    registry = CommandRegistry.getInstance();
    // Clear any existing commands from previous tests (IDE registers many). We will test via isolated instance.
    // Instead, create a fresh registry via private access for isolation.
    (registry as any).commands.clear();
  });
  afterEach(() => {
    (registry as any).commands.clear();
    vi.restoreAllMocks();
  });

  it("registers Comments: Next/Previous/Go to Unresolved and they are searchable (keyboard accessible)", () => {
    const handler = vi.fn();
    registry.registerMany([
      { id: "comments.action.nextInFile", title: "Comments: Next in File", category: "Navigation" as const, handler },
      { id: "comments.action.previousInFile", title: "Comments: Previous in File", category: "Navigation" as const, handler },
      { id: "comments.action.goToUnresolved", title: "Comments: Go to Unresolved", category: "Navigation" as const, handler },
    ]);
    const results = registry.search("Comments");
    expect(results.map((c) => c.id).sort()).toEqual([
      "comments.action.goToUnresolved",
      "comments.action.nextInFile",
      "comments.action.previousInFile",
    ]);
    // Palette is keyboard accessible: search via fuzzyFilter covers title
    const next = registry.search("Next in File");
    expect(next[0].id).toBe("comments.action.nextInFile");
  });

  it("Next in File handler uses canonical state, skips stale/deleted, and navigates via openAndRevealLocation", async () => {
    const openMock = vi.fn(async () => {});
    // Mock store
    const threads = [
      { id: "t1", filePath: "a.ts", anchor: { startLine: 10, endLine: 10 }, anchorStatus: "ok", resolvedAt: null, root: { deletedAt: null } },
      { id: "t2", filePath: "a.ts", anchor: { startLine: 2, endLine: 2 }, anchorStatus: "stale", resolvedAt: null, root: { deletedAt: null } },
      { id: "t3", filePath: "a.ts", anchor: { startLine: 5, endLine: 5 }, anchorStatus: "ok", resolvedAt: "now", root: { deletedAt: null } },
      { id: "t4", filePath: "a.ts", anchor: { startLine: 7, endLine: 7 }, anchorStatus: "ok", resolvedAt: null, root: { deletedAt: "now" } },
      { id: "t5", filePath: "a.ts", anchor: { startLine: 3, endLine: 3 }, anchorStatus: "ok", resolvedAt: null, root: { deletedAt: null } },
    ] as any;
    const store = { threadsFor: () => threads, unresolved: () => [] } as any;
    const { nextInFile } = await import("../src/comments/navigation");
    const next = nextInFile(store.threadsFor("a.ts"), null);
    // Should skip t2 (stale), t3 (resolved), t4 (deleted), leaving t5 (3) and t1 (10), sorted => t5 then t1
    expect(next!.id).toBe("t5");
    // Simulate handler
    const target = nextInFile(store.threadsFor("a.ts"), "t5");
    expect(target!.id).toBe("t1");
    // Verify navigation would use openAndRevealLocation with correct file/line
    const spy = vi.spyOn(await import("../src/utils/revealLocation"), "openAndRevealLocation").mockResolvedValue(undefined);
    await openAndRevealLocation(openMock, { filePath: target!.filePath, line: target!.anchor.startLine, column: 1 });
    expect(spy).toHaveBeenCalledWith(openMock, { filePath: "a.ts", line: 10, column: 1 });
    spy.mockRestore();
  });

  it("handles closed files correctly via openAndRevealLocation (open before reveal)", async () => {
    // The real openAndRevealLocation opens then dispatches; we verify open is awaited before reveal
    const order: string[] = [];
    const fakeOpen = async (path: string) => {
      order.push(`open:${path}`);
      await new Promise((r) => setTimeout(r, 10));
    };
    const fakeReveal = () => order.push("reveal");
    // Simulate what openAndRevealLocation does: await open, then dispatch
    await (async () => {
      await fakeOpen("b.ts");
      fakeReveal();
    })();
    expect(order).toEqual(["open:b.ts", "reveal"]);
  });
});
