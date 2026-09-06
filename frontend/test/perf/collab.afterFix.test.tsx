/**
 * M71 — before/after measurement for the collaborator-driven Sidebar hotspot.
 *
 * Same scripted cursor-churn workload as BASELINE A, run two ways against the
 * real memoized <Sidebar>:
 *   NAIVE      — collaborators passed straight through (pre-M71 wiring)
 *   STABILIZED — collaborators passed through useStableCollaborators (M71)
 *
 * Reports Sidebar commit count + React work (ms) for each. The STABILIZED
 * column is what IDE.tsx now ships.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import type { CollaboratorPresence } from "../../src/collab/presence";
import type { TreeNode } from "../../src/types";
import {
  RenderRecorder,
  profiledMemo,
  buildTree,
  makePresence,
  reproject,
  summarize,
} from "./harness";

vi.mock("../../src/api", () => ({
  api: vi.fn(() => new Promise(() => {})),
}));

import Sidebar from "../../src/components/Sidebar/Sidebar";
import { throttleLatest } from "../../src/utils/throttleLatest";
import { useStableCollaborators } from "../../src/utils/useStableCollaborators";

const ProfiledSidebar = profiledMemo(
  Sidebar as unknown as React.ComponentType<Record<string, unknown>>,
  "sidebar",
);

const user = { id: 1, username: "alice" };
const project = { id: "proj-1", name: "P" };
const projects = [project];
const noop = () => {};

let emit: ((l: CollaboratorPresence[]) => void) | null = null;

function Host({
  recorder,
  tree,
  stabilize,
}: {
  recorder: RenderRecorder;
  tree: TreeNode[];
  stabilize: boolean;
}) {
  const [collaborators, setCollaborators] = React.useState<
    CollaboratorPresence[]
  >([]);
  React.useEffect(() => {
    const t = throttleLatest<CollaboratorPresence[]>(setCollaborators, 200);
    emit = t;
    return () => {
      t.cancel();
      emit = null;
    };
  }, []);
  const stable = useStableCollaborators(collaborators, user.id);
  const forTree = stabilize ? stable : collaborators;

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
      activeFile="src/mod0/file0.ts"
      onLogout={noop}
      refreshTree={noop}
      collaborators={forTree}
      runStatuses={EMPTY_ARR}
      currentUserId={user.id}
      commentCountsByFile={EMPTY_MAP}
    />
  );
}
const EMPTY_MAP = new Map<string, number>();
const EMPTY_ARR: never[] = [];

const roster = [
  makePresence({ userId: 2, name: "bob", activeFile: "src/mod0/file0.ts" }),
  makePresence({ userId: 3, name: "carol", activeFile: "src/mod1/file1.ts" }),
];

const SIZES = [100, 2000];
const TICKS = 8;
const REPEATS = 2;

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
  emit = null;
});

function runChurn(tree: TreeNode[], stabilize: boolean) {
  const recorder = new RenderRecorder();
  let view: ReturnType<typeof render>;
  act(() => {
    view = render(
      <Host recorder={recorder} tree={tree} stabilize={stabilize} />,
    );
  });
  act(() => vi.advanceTimersByTime(1));
  // prime with the first real roster
  act(() => emit!(roster));
  act(() => vi.advanceTimersByTime(220));
  recorder.reset();

  for (let t = 0; t < TICKS; t++) {
    act(() => emit!(reproject(roster, { cursorLine: t + 5, lastActive: (t + 1) * 1000 })));
    act(() => vi.advanceTimersByTime(220));
  }

  const out = {
    commits: recorder.count("sidebar"),
    reactMs: Math.round(recorder.totalDuration("sidebar") * 100) / 100,
  };
  act(() => view!.unmount());
  return out;
}

describe("M71 — collaborator churn, before vs after", () => {
  it("stabilized wiring eliminates Sidebar re-renders on cursor-only churn", () => {
    const results: Record<string, unknown> = {};

    for (const size of SIZES) {
      const tree = buildTree(size);
      const naive = { commits: [] as number[], ms: [] as number[] };
      const stable = { commits: [] as number[], ms: [] as number[] };

      for (let r = 0; r < REPEATS; r++) {
        const n = runChurn(tree, false);
        naive.commits.push(n.commits);
        naive.ms.push(n.reactMs);
        const s = runChurn(tree, true);
        stable.commits.push(s.commits);
        stable.ms.push(s.reactMs);
      }

      results[size] = {
        ticks: TICKS,
        NAIVE: {
          sidebarCommits: summarize(naive.commits),
          sidebarReactMs: summarize(naive.ms),
        },
        STABILIZED: {
          sidebarCommits: summarize(stable.commits),
          sidebarReactMs: summarize(stable.ms),
        },
      };
    }

    console.log(
      `\n=== M71 collaborator cursor-churn: NAIVE vs STABILIZED (${TICKS} ticks, ${REPEATS} repeats) ===\n` +
        JSON.stringify(results, null, 2),
    );

    for (const size of SIZES) {
      const r = results[size] as {
        NAIVE: { sidebarCommits: { min: number } };
        STABILIZED: { sidebarCommits: { max: number } };
      };
      // Deterministic: churn drives >=1 Sidebar commit/tick naively, 0 stabilized.
      expect(r.NAIVE.sidebarCommits.min).toBeGreaterThanOrEqual(TICKS);
      expect(r.STABILIZED.sidebarCommits.max).toBe(0);
    }
  });
});
