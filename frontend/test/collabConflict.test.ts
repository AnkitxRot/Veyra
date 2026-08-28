import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isCollabSaveConflict,
  collabSaveConflictMessage,
  bulkConflictSummary,
  handleSaveError,
  COLLAB_SAVE_CONFLICT_CODE,
} from "../src/utils/collabConflict";

describe("collabConflict — direct save", () => {
  it("isCollabSaveConflict matches only the collab_external_conflict code", () => {
    expect(isCollabSaveConflict({ code: COLLAB_SAVE_CONFLICT_CODE })).toBe(true);
    expect(
      isCollabSaveConflict(
        Object.assign(new Error("x"), { code: "collab_external_conflict" }),
      ),
    ).toBe(true);
  });

  it("isCollabSaveConflict rejects other errors, non-objects, and nullish", () => {
    expect(isCollabSaveConflict({ code: "stale_patch" })).toBe(false);
    expect(isCollabSaveConflict(new Error("boom"))).toBe(false);
    expect(isCollabSaveConflict("collab_external_conflict")).toBe(false);
    expect(isCollabSaveConflict(null)).toBe(false);
    expect(isCollabSaveConflict(undefined)).toBe(false);
  });

  it("collabSaveConflictMessage is truthful: names the file, says it was not applied, never claims a merge", () => {
    const msg = collabSaveConflictMessage("src/app/main.ts");
    expect(msg).toContain("main.ts");
    expect(msg).toMatch(/not applied/i);
    expect(msg).toMatch(/their version was kept/i);
    expect(msg.toLowerCase()).not.toContain("merge");
    expect(msg.toLowerCase()).not.toContain("merged");
  });

  it("collabSaveConflictMessage falls back to the raw path when there is no slash", () => {
    expect(collabSaveConflictMessage("notes.txt")).toContain("notes.txt");
  });
});

describe("collabConflict — handleSaveError routing", () => {
  it("routes a collab conflict to onCollabConflict (never onFailure) with a truthful message", () => {
    const onCollabConflict = vi.fn();
    const onFailure = vi.fn();
    handleSaveError(
      Object.assign(new Error("server text"), {
        code: COLLAB_SAVE_CONFLICT_CODE,
      }),
      "src/x.ts",
      { onCollabConflict, onFailure },
    );
    expect(onFailure).not.toHaveBeenCalled();
    expect(onCollabConflict).toHaveBeenCalledTimes(1);
    const msg = onCollabConflict.mock.calls[0][0];
    expect(msg).toContain("x.ts");
    expect(msg.toLowerCase()).not.toContain("merge");
  });

  it("routes every other error to onFailure with its message", () => {
    const onCollabConflict = vi.fn();
    const onFailure = vi.fn();
    handleSaveError(new Error("disk full"), "src/x.ts", {
      onCollabConflict,
      onFailure,
    });
    expect(onCollabConflict).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith("disk full");
  });
});

describe("collabConflict — bulk summary", () => {
  it("returns null when nothing conflicted", () => {
    expect(bulkConflictSummary(undefined, "Snapshot restore")).toBeNull();
    expect(bulkConflictSummary([], "Snapshot restore")).toBeNull();
  });

  it("names the operation and the conflicted file(s), and never claims they were changed", () => {
    const s = bulkConflictSummary(["src/a.ts"], "Snapshot restore");
    expect(s).toContain("Snapshot restore");
    expect(s).toContain("a.ts");
    expect(s).toMatch(/1 file/);
    expect(s).toMatch(/kept at a collaborator's unsaved version/i);
    expect(s).toMatch(/not changed/i);
  });

  it("truncates a long list with 'and N more'", () => {
    const s = bulkConflictSummary(
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      "Checkout",
    );
    expect(s).toContain("a.ts, b.ts, c.ts");
    expect(s).toContain("and 2 more");
    expect(s).toMatch(/5 files/);
  });
});

describe("collabConflict — integration with the api() wrapper", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("a real api() rejection from a 409 collab_external_conflict body is recognised", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 409,
      ok: false,
      json: async () => ({
        error: {
          code: "collab_external_conflict",
          message: "This file has unsaved changes from another collaborator.",
        },
      }),
    }) as unknown as typeof fetch;

    const { api } = await import("../src/api");
    let caught: unknown;
    try {
      await api("/api/projects/p1/file", {
        method: "POST",
        body: JSON.stringify({ path: "a.ts", content: "x" }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isCollabSaveConflict(caught)).toBe(true);
  });
});
