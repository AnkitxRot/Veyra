/**
 * M71 Phase 0 — BASELINE C: workspace tree.
 *
 * Synthetic trees of 100 / 500 / 1000 / 2000 files. Measures:
 *  - mount commit count + React work (ms) + rendered <li> count
 *  - the cost of ONE re-render triggered by an UNRELATED parent state change
 *    (this is what every `setStats` poll — every 2.5s — currently costs, and
 *    what any other IDE state change costs the tree)
 *
 * NO virtualization is introduced. This is measurement only.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import { RenderRecorder, Probe, buildTree, countFiles, summarize } from "./harness";

vi.mock("../../src/api", () => ({ api: vi.fn(() => new Promise(() => {})) }));

import Sidebar from "../../src/components/Sidebar/Sidebar";
import type { TreeNode } from "../../src/types";

const user = { id: 1, username: "alice" };
const project = { id: "proj-1", name: "P" };

function TreeHost({
  recorder,
  tree,
  bump,
}: {
  recorder: RenderRecorder;
  tree: TreeNode[];
  bump: number;
}) {
  // `bump` stands in for an unrelated IDE state change (e.g. setStats every
  // 2.5s). It is not consumed by Sidebar — a correctly-scoped Sidebar would
  // not re-render for it.
  void bump;
  return (
    <Probe id="sidebar" recorder={recorder}>
      <Sidebar
        user={user}
        projects={[project]}
        project={project}
        onSelectProject={() => {}}
        onCreateProject={() => {}}
        tree={tree}
        treeStatus="ready"
        onOpenFile={() => {}}
        activeFile={null}
        onLogout={() => {}}
        refreshTree={() => {}}
        collaborators={[]}
        runStatuses={[]}
        currentUserId={user.id}
        commentCountsByFile={new Map()}
      />
    </Probe>
  );
}

afterEach(cleanup);

const SIZES = [100, 500, 1000, 2000];
const REPEATS = 3;

describe("M71 BASELINE C — workspace tree", () => {
  it("records mount + unrelated-re-render cost per tree size", () => {
    const results: Record<string, any> = {};

    for (const size of SIZES) {
      const tree = buildTree(size);
      const actualFiles = countFiles(tree);
      const mountCommits: number[] = [];
      const mountMs: number[] = [];
      const rerenderMs: number[] = [];
      let liCount = 0;

      for (let r = 0; r < REPEATS; r++) {
        const recorder = new RenderRecorder();
        let view: ReturnType<typeof render>;
        act(() => {
          view = render(<TreeHost recorder={recorder} tree={tree} bump={0} />);
        });
        mountCommits.push(recorder.count("sidebar"));
        mountMs.push(Math.round(recorder.totalDuration("sidebar") * 100) / 100);
        liCount = view!.container.querySelectorAll('li[role="none"]').length;

        recorder.reset();
        // one unrelated parent re-render (same tree ref, changed bump)
        act(() => {
          view!.rerender(
            <TreeHost recorder={recorder} tree={tree} bump={1} />,
          );
        });
        rerenderMs.push(
          Math.round(recorder.totalDuration("sidebar") * 100) / 100,
        );

        act(() => view!.unmount());
      }

      results[size] = {
        syntheticFiles: actualFiles,
        renderedListItems: liCount,
        mountCommits: summarize(mountCommits),
        mountReactMs: summarize(mountMs),
        oneUnrelatedRerenderReactMs: summarize(rerenderMs),
      };
    }

    console.log(
      "\n=== M71 BASELINE C: workspace tree (5 repeats) ===\n" +
        JSON.stringify(results, null, 2),
    );

    // Deterministic invariants.
    expect(results["2000"].renderedListItems).toBeGreaterThan(2000);
    // The tree DOES fully re-render for an unrelated parent change — the
    // baseline M71 must not regress and may improve.
    expect(results["2000"].oneUnrelatedRerenderReactMs.median).toBeGreaterThan(0);
  });
});
