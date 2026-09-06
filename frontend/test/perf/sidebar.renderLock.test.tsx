/**
 * M71 — regression lock for the collaborator-driven Sidebar render hotspot
 * (BASELINE A / C, both PROVEN HOT).
 *
 * Wires <Sidebar> exactly as IDE.tsx does after the fix:
 *   collaborators (full)  ->  useStableCollaborators(...)  ->  <Sidebar>
 * and asserts DETERMINISTIC commit counts:
 *   - cursor-only awareness churn                 => 0 Sidebar commits
 *   - an unrelated IDE state change (stats poll)  => 0 Sidebar commits
 *   - a collaborator actually changing file       => 1 Sidebar commit
 *   - the file tree changing                      => 1 Sidebar commit
 *   - activeFile changing                         => 1 Sidebar commit
 *   - runStatuses changing                        => 1 Sidebar commit
 *   - comment counts changing                     => 1 Sidebar commit
 *
 * The last five prove the memo does not swallow real updates (behavior
 * preserved).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import type { CollaboratorPresence } from "../../src/collab/presence";
import type { TreeNode, RunStatusEntry } from "../../src/types";
import {
  RenderRecorder,
  profiledMemo,
  buildTree,
  makePresence,
} from "./harness";

vi.mock("../../src/api", () => ({
  api: vi.fn(() => new Promise(() => {})),
}));

import Sidebar from "../../src/components/Sidebar/Sidebar";
import { throttleLatest } from "../../src/utils/throttleLatest";
import { useStableCollaborators } from "../../src/utils/useStableCollaborators";

// Instrumented memo boundary over the REAL (already-memoized) Sidebar default
// export. `profiledMemo` bails on the exact same shallow prop comparison
// Sidebar's own `React.memo` uses, so its commit count == Sidebar's real
// render count with no <Profiler> self-render noise.
const ProfiledSidebar = profiledMemo(
  Sidebar as unknown as React.ComponentType<Record<string, unknown>>,
  "sidebar",
);

const user = { id: 1, username: "alice" };
const project = { id: "proj-1", name: "P" };

// Stable handler identities — like IDE.tsx's useCallback-wrapped Sidebar props.
const noop = () => {};
const projects = [project]; // IDE holds this in state (stable ref)

let emitCollab: ((l: CollaboratorPresence[]) => void) | null = null;
let setBumpExternal: ((n: number) => void) | null = null;
let setTreeExternal: ((t: TreeNode[]) => void) | null = null;
let setActiveFileExternal: ((f: string | null) => void) | null = null;
let setRunStatusesExternal: ((r: RunStatusEntry[]) => void) | null = null;
let setCommentCountsExternal: ((m: Map<string, number>) => void) | null = null;

function Host({
  recorder,
  initialTree,
}: {
  recorder: RenderRecorder;
  initialTree: TreeNode[];
}) {
  const [collaborators, setCollaborators] = React.useState<
    CollaboratorPresence[]
  >([]);
  const [bump, setBump] = React.useState(0); // stands in for setStats
  const [tree, setTree] = React.useState(initialTree);
  const [activeFile, setActiveFile] = React.useState<string | null>(
    "src/mod0/file0.ts",
  );
  const [runStatuses, setRunStatuses] = React.useState<RunStatusEntry[]>([]);
  const [commentCounts, setCommentCounts] = React.useState<Map<string, number>>(
    new Map(),
  );

  React.useEffect(() => {
    const t = throttleLatest<CollaboratorPresence[]>(setCollaborators, 200);
    emitCollab = t;
    setBumpExternal = setBump;
    setTreeExternal = setTree;
    setActiveFileExternal = setActiveFile;
    setRunStatusesExternal = setRunStatuses;
    setCommentCountsExternal = setCommentCounts;
    return () => {
      t.cancel();
      emitCollab = null;
    };
  }, []);

  const collaboratorsForTree = useStableCollaborators(collaborators, user.id);

  // `bump` is read here (like IDE reads `stats`) but is NOT a Sidebar prop.
  void bump;

  return (
    <ProfiledSidebar
      recorder={recorder}
      user={user}
      projects={projects}
      project={project}
      onSelectProject={noop}
      onCreateProject={noop}
      tree={tree}
      treeStatus="ready"
      onOpenFile={noop}
      activeFile={activeFile}
      onLogout={noop}
      refreshTree={noop}
      collaborators={collaboratorsForTree}
      runStatuses={runStatuses}
      currentUserId={user.id}
      commentCountsByFile={commentCounts}
    />
  );
}

function reproject(
  list: CollaboratorPresence[],
  cursorLine: number,
): CollaboratorPresence[] {
  return list.map((c) => ({
    ...c,
    cursor: { line: cursorLine, column: 1 },
    lastActive: cursorLine * 1000,
  }));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  emitCollab = null;
});

function mount(recorder: RenderRecorder) {
  let view: ReturnType<typeof render>;
  act(() => {
    view = render(<Host recorder={recorder} initialTree={buildTree(500)} />);
  });
  act(() => {
    vi.advanceTimersByTime(1);
  });
  recorder.reset();
  return view!;
}

const roster = [
  makePresence({ userId: 2, name: "bob", activeFile: "src/mod0/file0.ts" }),
  makePresence({ userId: 3, name: "carol", activeFile: "src/mod1/file1.ts" }),
];

function pushCollab(list: CollaboratorPresence[]) {
  act(() => {
    emitCollab!(list);
  });
  act(() => {
    vi.advanceTimersByTime(220);
  });
}

describe("M71 — Sidebar render lock", () => {
  it("the Sidebar default export is a React.memo boundary", () => {
    // If this regresses, `profiledMemo`'s outer bail would mask a missing
    // inner memo — so assert the real thing directly.
    expect((Sidebar as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("cursor-only awareness churn does NOT re-render Sidebar", () => {
    const recorder = new RenderRecorder();
    mount(recorder);
    // prime with a first real roster (1 commit, expected)
    pushCollab(roster);
    expect(recorder.count("sidebar")).toBe(1);

    for (let t = 0; t < 8; t++) {
      pushCollab(reproject(roster, t + 5));
    }
    // no further commits — the projection Sidebar cares about never changed
    expect(recorder.count("sidebar")).toBe(1);
  });

  it("an unrelated IDE state change (stats poll) does NOT re-render Sidebar", () => {
    const recorder = new RenderRecorder();
    mount(recorder);
    for (let i = 0; i < 5; i++) {
      act(() => setBumpExternal!(i + 1));
    }
    expect(recorder.count("sidebar")).toBe(0);
  });

  it("a collaborator changing file DOES re-render Sidebar exactly once", () => {
    const recorder = new RenderRecorder();
    mount(recorder);
    pushCollab(roster);
    expect(recorder.count("sidebar")).toBe(1);

    const moved = [
      roster[0],
      makePresence({
        userId: 3,
        name: "carol",
        activeFile: "src/mod2/file2.ts",
      }),
    ];
    pushCollab(moved);
    expect(recorder.count("sidebar")).toBe(2);
  });

  it("tree / activeFile / runStatuses / commentCounts changes each re-render Sidebar", () => {
    const recorder = new RenderRecorder();
    mount(recorder);

    act(() => setTreeExternal!(buildTree(600)));
    expect(recorder.count("sidebar")).toBe(1);

    act(() => setActiveFileExternal!("src/mod3/file3.ts"));
    expect(recorder.count("sidebar")).toBe(2);

    act(() =>
      setRunStatusesExternal!([
        {
          executionId: "e1",
          userId: 3,
          username: "carol",
          state: "running",
          file: "src/mod1/file1.ts",
          language: "python",
          startedAt: 0,
          endedAt: null,
          exitCode: null,
        } as RunStatusEntry,
      ]),
    );
    expect(recorder.count("sidebar")).toBe(3);

    act(() => setCommentCountsExternal!(new Map([["src/mod0/file0.ts", 2]])));
    expect(recorder.count("sidebar")).toBe(4);
  });
});
