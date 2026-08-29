import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  readProjectSession,
  writeProjectSession,
  clearProjectSession,
  getLastProjectId,
  setLastProjectId,
  resolveProjectSelection,
  resolvePendingEntryOpen,
  parseProjectRoute,
  projectPath,
  BOTTOM_PANEL_TABS,
} from "../src/utils/sessionStore";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("sessionStore — per-project session serialization", () => {
  it("round-trips openTabs / active / bottomTab keyed by project id", () => {
    writeProjectSession("proj-A", {
      openTabs: ["src/a.ts", "src/b.ts", "README.md"],
      active: "src/b.ts",
      bottomTab: "terminal",
    });
    expect(readProjectSession("proj-A")).toEqual({
      openTabs: ["src/a.ts", "src/b.ts", "README.md"],
      active: "src/b.ts",
      bottomTab: "terminal",
    });
  });

  it("isolates sessions between projects", () => {
    writeProjectSession("proj-A", {
      openTabs: ["a.ts"],
      active: "a.ts",
      bottomTab: "output",
    });
    writeProjectSession("proj-B", {
      openTabs: ["x.py", "y.py"],
      active: "y.py",
      bottomTab: "git",
    });
    expect(readProjectSession("proj-A")?.openTabs).toEqual(["a.ts"]);
    expect(readProjectSession("proj-B")?.openTabs).toEqual(["x.py", "y.py"]);
    expect(readProjectSession("proj-A")?.bottomTab).toBe("output");
    expect(readProjectSession("proj-B")?.bottomTab).toBe("git");
  });

  it("preserves tab ORDER", () => {
    writeProjectSession("p", {
      openTabs: ["z.ts", "a.ts", "m.ts"],
      active: null,
      bottomTab: null,
    });
    expect(readProjectSession("p")?.openTabs).toEqual(["z.ts", "a.ts", "m.ts"]);
  });

  it("returns null for an unknown project", () => {
    expect(readProjectSession("never-written")).toBeNull();
  });

  it("clearProjectSession removes only that project", () => {
    writeProjectSession("p1", { openTabs: ["a"], active: "a", bottomTab: null });
    writeProjectSession("p2", { openTabs: ["b"], active: "b", bottomTab: null });
    clearProjectSession("p1");
    expect(readProjectSession("p1")).toBeNull();
    expect(readProjectSession("p2")?.openTabs).toEqual(["b"]);
  });
});

describe("sessionStore — validation & corruption safety", () => {
  it("malformed JSON returns null, never throws", () => {
    localStorage.setItem("cloudeee_session_bad", "{not json");
    expect(() => readProjectSession("bad")).not.toThrow();
    expect(readProjectSession("bad")).toBeNull();
  });

  it("non-object payload returns null", () => {
    localStorage.setItem("cloudeee_session_bad2", '"a string"');
    expect(readProjectSession("bad2")).toBeNull();
    localStorage.setItem("cloudeee_session_bad3", "42");
    expect(readProjectSession("bad3")).toBeNull();
  });

  it("drops non-string / empty tab entries and de-duplicates", () => {
    localStorage.setItem(
      "cloudeee_session_dirty",
      JSON.stringify({
        openTabs: ["a.ts", 5, null, "", "a.ts", "b.ts", { x: 1 }],
        active: "a.ts",
        bottomTab: "output",
      }),
    );
    expect(readProjectSession("dirty")?.openTabs).toEqual(["a.ts", "b.ts"]);
  });

  it("nulls an active file that is not among openTabs", () => {
    localStorage.setItem(
      "cloudeee_session_stale-active",
      JSON.stringify({
        openTabs: ["a.ts"],
        active: "gone.ts",
        bottomTab: null,
      }),
    );
    expect(readProjectSession("stale-active")?.active).toBeNull();
  });

  it("rejects an unknown bottomTab value", () => {
    localStorage.setItem(
      "cloudeee_session_badtab",
      JSON.stringify({ openTabs: [], active: null, bottomTab: "wat" }),
    );
    expect(readProjectSession("badtab")?.bottomTab).toBeNull();
    for (const t of BOTTOM_PANEL_TABS) {
      localStorage.setItem(
        `cloudeee_session_t_${t}`,
        JSON.stringify({ openTabs: [], active: null, bottomTab: t }),
      );
      expect(readProjectSession(`t_${t}`)?.bottomTab).toBe(t);
    }
  });

  it("caps an absurdly long tab list", () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}.ts`);
    writeProjectSession("huge", {
      openTabs: many,
      active: null,
      bottomTab: null,
    });
    expect(readProjectSession("huge")!.openTabs.length).toBeLessThanOrEqual(50);
  });

  it("write survives localStorage.setItem throwing (quota / disabled)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    expect(() =>
      writeProjectSession("q", { openTabs: ["a"], active: "a", bottomTab: null }),
    ).not.toThrow();
    spy.mockRestore();
  });

  it("read survives localStorage.getItem throwing", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("SecurityError");
      });
    expect(() => readProjectSession("x")).not.toThrow();
    expect(readProjectSession("x")).toBeNull();
    spy.mockRestore();
  });

  it("writeProjectSession sanitizes an out-of-set bottomTab / stale active before storing", () => {
    writeProjectSession("sanitize", {
      openTabs: ["a.ts", "", "a.ts", "b.ts"],
      active: "not-open.ts",
      // @ts-expect-error deliberately invalid at runtime
      bottomTab: "nope",
    });
    const s = readProjectSession("sanitize");
    expect(s?.openTabs).toEqual(["a.ts", "b.ts"]);
    expect(s?.active).toBeNull();
    expect(s?.bottomTab).toBeNull();
  });
});

describe("sessionStore — last project", () => {
  it("round-trips the last project id", () => {
    expect(getLastProjectId()).toBeNull();
    setLastProjectId("proj-123");
    expect(getLastProjectId()).toBe("proj-123");
  });
  it("ignores empty and survives storage errors", () => {
    setLastProjectId("");
    expect(getLastProjectId()).toBeNull();
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("boom");
      });
    expect(getLastProjectId()).toBeNull();
    spy.mockRestore();
  });
});

describe("sessionStore — parseProjectRoute / projectPath", () => {
  it("extracts the id from /p/<id>", () => {
    expect(parseProjectRoute("/p/abc-123")).toBe("abc-123");
    expect(parseProjectRoute("/p/abc-123/")).toBe("abc-123");
  });
  it("returns null for non-project routes", () => {
    expect(parseProjectRoute("/")).toBeNull();
    expect(parseProjectRoute("/admin")).toBeNull();
    expect(parseProjectRoute("/admin/login")).toBeNull();
    expect(parseProjectRoute("/p")).toBeNull();
    expect(parseProjectRoute("/p/")).toBeNull();
    expect(parseProjectRoute("/projects/abc")).toBeNull();
    expect(parseProjectRoute("")).toBeNull();
  });
  it("decodes a percent-encoded id and round-trips with projectPath", () => {
    const id = "a b/c";
    expect(parseProjectRoute(projectPath(id))).toBe(id);
    expect(projectPath("abc")).toBe("/p/abc");
  });
});

describe("sessionStore — resolveProjectSelection (pure)", () => {
  const projectIds = ["A", "B", "C"];

  it("1. explicit valid /p/:id wins", () => {
    expect(
      resolveProjectSelection({
        routeProjectId: "B",
        lastProjectId: "A",
        projectIds,
      }),
    ).toEqual({ projectId: "B", invalidRoute: false });
  });

  it("2. explicit invalid/foreign /p/:id => invalidRoute, NEVER substitutes another project", () => {
    expect(
      resolveProjectSelection({
        routeProjectId: "ZZZ",
        lastProjectId: "A",
        projectIds,
      }),
    ).toEqual({ projectId: null, invalidRoute: true });
    // even with a perfectly good last project + non-empty list, it must not open one
    expect(
      resolveProjectSelection({
        routeProjectId: "foreign",
        lastProjectId: "C",
        projectIds,
      }).projectId,
    ).toBeNull();
  });

  it("3. no route => last project (when still accessible)", () => {
    expect(
      resolveProjectSelection({
        routeProjectId: null,
        lastProjectId: "C",
        projectIds,
      }),
    ).toEqual({ projectId: "C", invalidRoute: false });
  });

  it("4. no route + stale/absent last project => existing default (first project)", () => {
    expect(
      resolveProjectSelection({
        routeProjectId: null,
        lastProjectId: "gone",
        projectIds,
      }),
    ).toEqual({ projectId: "A", invalidRoute: false });
    expect(
      resolveProjectSelection({
        routeProjectId: null,
        lastProjectId: null,
        projectIds,
      }),
    ).toEqual({ projectId: "A", invalidRoute: false });
  });

  it("no projects at all => null, not invalidRoute (unless a route was given)", () => {
    expect(
      resolveProjectSelection({
        routeProjectId: null,
        lastProjectId: null,
        projectIds: [],
      }),
    ).toEqual({ projectId: null, invalidRoute: false });
    expect(
      resolveProjectSelection({
        routeProjectId: "A",
        lastProjectId: null,
        projectIds: [],
      }),
    ).toEqual({ projectId: null, invalidRoute: true });
  });
});

describe("sessionStore — resolvePendingEntryOpen (pure)", () => {
  const ready = {
    projectId: "P" as string | undefined,
    pending: { projectId: "P", path: "main.py" },
    treeLoadedFor: "P" as string | null,
    openFileCount: 0,
    hasSession: false,
  };

  it("opens the entry file when the project is active, tree is loaded, nothing open, no session", () => {
    expect(resolvePendingEntryOpen(ready)).toBe("main.py");
  });

  it("stands down when there is no pending hint", () => {
    expect(resolvePendingEntryOpen({ ...ready, pending: null })).toBeNull();
  });

  it("stands down when the hint targets a different project", () => {
    expect(
      resolvePendingEntryOpen({
        ...ready,
        pending: { projectId: "OTHER", path: "main.py" },
      }),
    ).toBeNull();
  });

  it("waits until the tree for this project has loaded", () => {
    expect(
      resolvePendingEntryOpen({ ...ready, treeLoadedFor: null }),
    ).toBeNull();
    expect(
      resolvePendingEntryOpen({ ...ready, treeLoadedFor: "P-old" }),
    ).toBeNull();
  });

  it("stands down once the user has opened a tab of their own", () => {
    expect(resolvePendingEntryOpen({ ...ready, openFileCount: 1 })).toBeNull();
  });

  it("never overrides a real restored session", () => {
    expect(resolvePendingEntryOpen({ ...ready, hasSession: true })).toBeNull();
  });

  it("stands down when no project is active", () => {
    expect(
      resolvePendingEntryOpen({ ...ready, projectId: undefined }),
    ).toBeNull();
  });
});
