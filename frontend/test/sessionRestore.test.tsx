import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import * as React from "react";

// Behavioural coverage for the IDE session-restore wiring. The pure
// serialization / resolution / route helpers are exercised directly in
// sessionStore.test.ts; this harness reproduces IDE.tsx's *integration* of
// them (initial resolve, URL sync, Back/Forward, the tree-gated one-shot tab
// restore, and the per-project persistence-owner guard) using the REAL
// sessionStore module — mirroring the ideXMediation harness convention.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (p: string, id: string) => `ws://test${p}?projectId=${id}`,
}));

import {
  readProjectSession,
  writeProjectSession,
  getLastProjectId,
  setLastProjectId,
  resolveProjectSelection,
  parseProjectRoute,
  projectPath,
  type BottomPanelTab,
} from "../src/utils/sessionStore";

type Proj = { id: string; name: string };

/** Mirrors IDE.tsx's session wiring around a minimal editor surface. */
function SessionIDE({
  projects,
  fileTreePaths,
}: {
  projects: Proj[];
  fileTreePaths: Record<string, string[]>; // projectId -> existing file paths
}) {
  const [route, setRoute] = React.useState(window.location.pathname);
  const [project, setProject] = React.useState<Proj | null>(null);
  const [openTabs, setOpenTabs] = React.useState<string[]>([]);
  const [active, setActive] = React.useState<string | null>(null);
  const [bottomTab, setBottomTab] = React.useState<BottomPanelTab>("output");
  const [invalidRoute, setInvalidRoute] = React.useState<string | null>(null);

  const [treeTick, setTreeTick] = React.useState(0);
  const sessionOwnerRef = React.useRef<string | null>(null);
  const didInitialResolveRef = React.useRef(false);
  const treeLoadedForRef = React.useRef<string | null>(null);

  const routeProjectId = parseProjectRoute(route);
  const navigateProject = React.useCallback((id: string | null) => {
    const path = id ? projectPath(id) : "/";
    window.history.pushState({}, "", path);
    setRoute(path);
  }, []);

  React.useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // initial resolve (IDE.tsx loadProjects)
  React.useEffect(() => {
    if (didInitialResolveRef.current) return;
    didInitialResolveRef.current = true;
    const { projectId, invalidRoute: bad } = resolveProjectSelection({
      routeProjectId,
      lastProjectId: getLastProjectId(),
      projectIds: projects.map((p) => p.id),
    });
    if (bad) {
      setInvalidRoute("That project link isn't available.");
      navigateProject(null);
    } else if (projectId) {
      const t = projects.find((p) => p.id === projectId)!;
      setProject(t);
      setLastProjectId(t.id);
      navigateProject(t.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/Forward (IDE.tsx routeProjectId effect)
  React.useEffect(() => {
    if (!didInitialResolveRef.current) return;
    const rid = routeProjectId;
    if (!rid || rid === project?.id) return;
    const t = projects.find((p) => p.id === rid);
    if (t) {
      setProject(t);
      setLastProjectId(t.id);
      setInvalidRoute(null);
    } else if (projects.length > 0) {
      setInvalidRoute("That project link isn't available.");
      navigateProject(null);
    }
  }, [routeProjectId, project?.id, projects, navigateProject]);

  // project switch clears the previous project's tabs (IDE.tsx collab effect)
  React.useEffect(() => {
    if (!project) return;
    setOpenTabs([]);
    setActive(null);
  }, [project]);

  // "load tree" for the active project — ASYNC, like the real /tree fetch, so
  // the user has a real window to act before restore.
  React.useEffect(() => {
    if (!project) return;
    const pid = project.id;
    let done = false;
    Promise.resolve().then(() => {
      if (done) return;
      treeLoadedForRef.current = pid;
      setTreeTick((t) => t + 1);
    });
    return () => {
      done = true;
    };
  }, [project]);

  // one-shot tab restore (IDE.tsx restore effect)
  React.useEffect(() => {
    const pid = project?.id;
    if (!pid) return;
    if (sessionOwnerRef.current === pid) return;
    if (treeLoadedForRef.current !== pid) return;
    if (openTabs.length > 0) return; // pre-switch tabs not cleared yet / user acted
    sessionOwnerRef.current = pid;
    const sess = readProjectSession(pid);
    if (!sess) return;
    if (sess.bottomTab) setBottomTab(sess.bottomTab);
    if (sess.openTabs.length === 0) return;
    const existing = new Set(fileTreePaths[pid] ?? []);
    const wanted = sess.openTabs.filter((p) => existing.has(p));
    if (wanted.length === 0) return;
    setOpenTabs(wanted);
    setActive(
      sess.active && wanted.includes(sess.active)
        ? sess.active
        : wanted[wanted.length - 1],
    );
  }, [project?.id, fileTreePaths, openTabs, treeTick]);

  // persist (IDE.tsx persist effect)
  const openTabsKey = openTabs.join("\n");
  React.useEffect(() => {
    const pid = project?.id;
    if (!pid) return;
    if (sessionOwnerRef.current !== pid) return;
    writeProjectSession(pid, {
      openTabs: openTabsKey ? openTabsKey.split("\n") : [],
      active,
      bottomTab,
    });
  }, [project?.id, openTabsKey, active, bottomTab]);

  const selectProject = (p: Proj) => {
    setInvalidRoute(null);
    if (p.id === project?.id) return;
    setProject(p);
    setLastProjectId(p.id);
    navigateProject(p.id);
  };
  const openFile = (path: string) => {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActive(path);
  };
  const closeTab = (path: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((p) => p !== path);
      setActive((a) =>
        a === path ? (next.length ? next[next.length - 1] : null) : a,
      );
      return next;
    });
  };

  return (
    <div>
      <div data-testid="project">{project ? project.name : "(none)"}</div>
      <div data-testid="url">{route}</div>
      <div data-testid="tabs">{openTabs.join(",")}</div>
      <div data-testid="active">{active ?? "(none)"}</div>
      <div data-testid="bottom">{bottomTab}</div>
      {invalidRoute && <div role="alert">{invalidRoute}</div>}
      {projects.map((p) => (
        <button key={p.id} onClick={() => selectProject(p)}>
          open:{p.name}
        </button>
      ))}
      <button onClick={() => openFile("src/a.ts")}>tab:a</button>
      <button onClick={() => openFile("src/b.ts")}>tab:b</button>
      <button onClick={() => openFile("src/c.ts")}>tab:c</button>
      <button onClick={() => closeTab("src/b.ts")}>close:b</button>
      <button onClick={() => setBottomTab("terminal")}>panel:terminal</button>
      <button onClick={() => setBottomTab("git")}>panel:git</button>
    </div>
  );
}

const A: Proj = { id: "proj-A", name: "Alpha" };
const B: Proj = { id: "proj-B", name: "Beta" };
const treeAll = {
  "proj-A": ["src/a.ts", "src/b.ts", "src/c.ts"],
  "proj-B": ["src/a.ts", "src/b.ts", "src/c.ts"],
};

function goto(path: string) {
  window.history.replaceState({}, "", path);
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  apiMock.mockReset();
  goto("/");
});
afterEach(() => {
  cleanup();
  goto("/");
});

describe("session restore — routing", () => {
  it("1. /p/<validId> opens exactly that project (not projects[0])", async () => {
    goto("/p/proj-B");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Beta"),
    );
    expect(screen.getByTestId("url").textContent).toBe("/p/proj-B");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("2. /p/<foreignId> never silently opens another project", async () => {
    setLastProjectId("proj-A"); // a perfectly good fallback exists
    goto("/p/not-mine");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeTruthy(),
    );
    expect(screen.getByTestId("project").textContent).toBe("(none)");
    // URL is reset so a reload doesn't loop on the bad link
    expect(screen.getByTestId("url").textContent).toBe("/");
  });

  it("2b. navigating to a foreign /p/:id while already in a project keeps the current project + warns", async () => {
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    // simulate the user pasting a stale/shared link
    window.history.pushState({}, "", "/p/not-a-real-project");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByTestId("project").textContent).toBe("Alpha"); // unchanged
    expect(screen.getByTestId("url").textContent).toBe("/"); // recovered
  });

  it("3. no route falls back to the persisted last project", async () => {
    setLastProjectId("proj-B");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Beta"),
    );
  });

  it("4. no route + no last project falls back to the first project", async () => {
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
  });

  it("10. selecting a project updates the URL to /p/<id>", async () => {
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    fireEvent.click(screen.getByText("open:Beta"));
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toBe("/p/proj-B"),
    );
  });

  it("11. browser Back/Forward switches projects", async () => {
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    fireEvent.click(screen.getByText("open:Beta"));
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Beta"),
    );
    // Back -> Alpha
    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    // Forward -> Beta
    window.history.forward();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Beta"),
    );
  });

  it("13. normal project switching still works and isolates tab state", async () => {
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    fireEvent.click(screen.getByText("tab:a"));
    fireEvent.click(screen.getByText("tab:b"));
    await waitFor(() =>
      expect(screen.getByTestId("tabs").textContent).toBe("src/a.ts,src/b.ts"),
    );
    fireEvent.click(screen.getByText("open:Beta"));
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Beta"),
    );
    // Beta starts clean; Alpha's tabs did not leak
    expect(screen.getByTestId("tabs").textContent).toBe("");
    // ...and Alpha's session on disk still has exactly its own tabs
    expect(readProjectSession("proj-A")?.openTabs).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(readProjectSession("proj-B")?.openTabs ?? []).toEqual([]);
  });

  it("12. malformed localStorage never crashes initialization", async () => {
    localStorage.setItem("cloudeee_session_proj-A", "{{{corrupt");
    localStorage.setItem("cloudeee_last_project", "proj-A");
    expect(() =>
      render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />),
    ).not.toThrow();
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    expect(screen.getByTestId("tabs").textContent).toBe("");
  });
});

describe("session restore — tabs & panel", () => {
  it("5+6. reload restores tabs in order and the active tab", async () => {
    writeProjectSession("proj-A", {
      openTabs: ["src/c.ts", "src/a.ts", "src/b.ts"],
      active: "src/a.ts",
      bottomTab: null,
    });
    goto("/p/proj-A");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("tabs").textContent).toBe(
        "src/c.ts,src/a.ts,src/b.ts",
      ),
    );
    expect(screen.getByTestId("active").textContent).toBe("src/a.ts");
  });

  it("7. persisted files that no longer exist are skipped", async () => {
    writeProjectSession("proj-A", {
      openTabs: ["src/a.ts", "src/deleted.ts", "src/c.ts"],
      active: "src/deleted.ts",
      bottomTab: null,
    });
    goto("/p/proj-A");
    render(
      <SessionIDE
        projects={[A, B]}
        fileTreePaths={{ "proj-A": ["src/a.ts", "src/c.ts"] }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("tabs").textContent).toBe("src/a.ts,src/c.ts"),
    );
    // active pointed at a now-missing file -> falls back to a real remaining tab
    expect(screen.getByTestId("active").textContent).toBe("src/c.ts");
  });

  it("8. per-project tab state is isolated across a switch and reload", async () => {
    writeProjectSession("proj-A", {
      openTabs: ["src/a.ts"],
      active: "src/a.ts",
      bottomTab: "git",
    });
    writeProjectSession("proj-B", {
      openTabs: ["src/b.ts", "src/c.ts"],
      active: "src/c.ts",
      bottomTab: "terminal",
    });
    goto("/p/proj-A");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("tabs").textContent).toBe("src/a.ts"),
    );
    expect(screen.getByTestId("bottom").textContent).toBe("git");

    fireEvent.click(screen.getByText("open:Beta"));
    await waitFor(() =>
      expect(screen.getByTestId("tabs").textContent).toBe("src/b.ts,src/c.ts"),
    );
    expect(screen.getByTestId("active").textContent).toBe("src/c.ts");
    expect(screen.getByTestId("bottom").textContent).toBe("terminal");

    // Alpha's stored session is untouched by opening Beta
    expect(readProjectSession("proj-A")).toEqual({
      openTabs: ["src/a.ts"],
      active: "src/a.ts",
      bottomTab: "git",
    });
  });

  it("9. bottom-panel selection is restored", async () => {
    writeProjectSession("proj-A", {
      openTabs: [],
      active: null,
      bottomTab: "terminal",
    });
    goto("/p/proj-A");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("bottom").textContent).toBe("terminal"),
    );
  });

  it("persists tab open / close / active / panel transitions", async () => {
    goto("/p/proj-A");
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    fireEvent.click(screen.getByText("tab:a"));
    fireEvent.click(screen.getByText("tab:b"));
    fireEvent.click(screen.getByText("tab:c"));
    fireEvent.click(screen.getByText("close:b"));
    fireEvent.click(screen.getByText("panel:git"));
    await waitFor(() =>
      expect(readProjectSession("proj-A")).toEqual({
        openTabs: ["src/a.ts", "src/c.ts"],
        active: "src/c.ts",
        bottomTab: "git",
      }),
    );
  });

  it("14. does not restore over files the user opened before the tree loaded", async () => {
    writeProjectSession("proj-A", {
      openTabs: ["src/a.ts", "src/b.ts"],
      active: "src/a.ts",
      bottomTab: null,
    });
    goto("/p/proj-A");
    // Delay the "tree" so the user can act first: render then immediately open c
    render(<SessionIDE projects={[A, B]} fileTreePaths={treeAll} />);
    fireEvent.click(screen.getByText("tab:c"));
    await waitFor(() =>
      expect(screen.getByTestId("project").textContent).toBe("Alpha"),
    );
    // restore must not clobber the user's manual tab
    expect(screen.getByTestId("tabs").textContent).toContain("src/c.ts");
    expect(screen.getByTestId("active").textContent).toBe("src/c.ts");
  });
});
