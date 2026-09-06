/**
 * M71 Phase 0 — BASELINE A: collaborator-awareness tick.
 *
 * Measures the render blast radius of the collaborator-presence state slice
 * exactly as `IDE.tsx` wires it: `throttleLatest(setCollaborators, 200)` fed a
 * fresh presence array on every awareness `change` (remote cursor / keystroke).
 *
 * The host component stands in for `IDE.tsx`'s collaborators slice (the full
 * god-component cannot be mounted in jsdom — see STATUS.md). The children are
 * the REAL <Sidebar>, <Toolbar> and <Editor>.
 *
 * This test asserts only cheap invariants (so it never flakes on timing); the
 * measured numbers are printed to the console and captured in STATUS.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import type { CollaboratorPresence } from "../../src/collab/presence";
import { monaco } from "../mocks/monaco";
import {
  RenderRecorder,
  Probe,
  buildTree,
  makePresence,
  reproject,
  summarize,
} from "./harness";

vi.mock("../../src/api", () => ({
  api: vi.fn(() => new Promise(() => {})),
  getWebSocketUrl: (p: string) => `ws://test${p}`,
}));
vi.mock("../../src/monacoSetup", () => ({ monaco }));

import Sidebar from "../../src/components/Sidebar/Sidebar";
import Toolbar from "../../src/components/Toolbar/Toolbar";
import Editor from "../../src/components/Editor/Editor";
import { throttleLatest } from "../../src/utils/throttleLatest";
import type { TreeNode } from "../../src/types";

Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

const user = { id: 1, username: "alice" };
const project = { id: "proj-1", name: "P" };

let emit: ((list: CollaboratorPresence[]) => void) | null = null;

function CollabHost({
  recorder,
  tree,
}: {
  recorder: RenderRecorder;
  tree: TreeNode[];
}) {
  const [collaborators, setCollaborators] = React.useState<
    CollaboratorPresence[]
  >([]);

  React.useEffect(() => {
    // Exactly IDE.tsx's wiring.
    const throttled = throttleLatest<CollaboratorPresence[]>(
      setCollaborators,
      200,
    );
    emit = throttled;
    return () => {
      throttled.cancel();
      emit = null;
    };
  }, []);

  return (
    <Probe id="ide-host" recorder={recorder}>
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
          activeFile="src/mod0/file0.ts"
          onLogout={() => {}}
          refreshTree={() => {}}
          collaborators={collaborators}
          runStatuses={[]}
          currentUserId={user.id}
          commentCountsByFile={new Map()}
        />
      </Probe>
      <Probe id="toolbar" recorder={recorder}>
        <Toolbar
          project={project}
          activeFile="src/mod0/file0.ts"
          capabilities={{
            docker: true,
            runnerImage: true,
            languages: {
              python: true,
              node: true,
              typescript: true,
              c: true,
              cpp: true,
              java: true,
            },
          }}
          stats={null}
          user={user}
          collaborators={collaborators}
          runStatuses={[]}
          collabStatus="connected"
          attention={[]}
          incomingRequestCount={0}
        />
      </Probe>
      <Probe id="editor" recorder={recorder}>
        <Editor
          project={project}
          openFiles={[
            { path: "src/mod0/file0.ts", content: "x", dirty: false },
          ]}
          setOpenFiles={() => {}}
          activeFile="src/mod0/file0.ts"
          setActiveFile={() => {}}
          liveApiRef={{ current: null }}
          isReadOnly={false}
          collaborators={collaborators}
          currentUserId={user.id}
          attention={[]}
        />
      </Probe>
    </Probe>
  );
}

// The full Phase-0 record (sizes 100/500/1000/2000, 20 ticks, 5 repeats) is
// captured in STATUS.md. The committed test runs a lighter living baseline.
const TREE_SIZES = [100, 500, 1000, 2000];
const TICKS = 8; // simulated remote keystrokes within a run
const REPEATS = 3;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  emit = null;
});

describe("M71 BASELINE A — collaborator-awareness tick", () => {
  it("records render blast radius for cursor-only awareness churn (2 collaborators)", async () => {
    const results: Record<string, any> = {};

    for (const size of TREE_SIZES) {
      const tree = buildTree(size);
      const perComponent: Record<string, number[]> = {
        "ide-host": [],
        sidebar: [],
        toolbar: [],
        editor: [],
      };
      const durByComponent: Record<string, number[]> = {
        "ide-host": [],
        sidebar: [],
        toolbar: [],
        editor: [],
      };
      const liLast: number[] = [];

      for (let r = 0; r < REPEATS; r++) {
        const recorder = new RenderRecorder();
        const roster = [
          makePresence({ userId: 2, name: "bob", activeFile: "src/mod0/file0.ts" }),
          makePresence({ userId: 3, name: "carol", activeFile: "src/mod1/file1.ts" }),
        ];

        let view: ReturnType<typeof render>;
        act(() => {
          view = render(<CollabHost recorder={recorder} tree={tree} />);
        });
        // flush mount effects (throttle wiring)
        act(() => {
          vi.advanceTimersByTime(1);
        });

        recorder.reset(); // ignore mount cost; measure only the churn

        for (let t = 0; t < TICKS; t++) {
          act(() => {
            emit!(reproject(roster, { cursorLine: t + 2, lastActive: (t + 1) * 1000 }));
          });
          act(() => {
            vi.advanceTimersByTime(200); // one throttle window per tick
          });
        }
        // settle any trailing rAF (editor decoration effects)
        act(() => {
          vi.advanceTimersByTime(50);
        });

        for (const id of Object.keys(perComponent)) {
          perComponent[id].push(recorder.count(id));
          durByComponent[id].push(
            Math.round(recorder.totalDuration(id) * 100) / 100,
          );
        }
        liLast.push(
          view!.container.querySelectorAll('li[role="none"]').length,
        );

        act(() => {
          view!.unmount();
        });
      }

      results[size] = {
        renderedListItems: liLast[0],
        commitsOverTicks: Object.fromEntries(
          Object.entries(perComponent).map(([k, v]) => [k, summarize(v)]),
        ),
        reactWorkMsOverTicks: Object.fromEntries(
          Object.entries(durByComponent).map(([k, v]) => [k, summarize(v)]),
        ),
      };
    }

    console.log(
      `\n=== M71 BASELINE A: collaborator cursor-churn (${TICKS} throttled ticks, ${REPEATS} repeats) ===\n` +
        JSON.stringify(results, null, 2),
    );

    // Invariant only (deterministic, timing-independent): the collaborator
    // slice DOES drive Sidebar + Toolbar re-renders on cursor-only churn — this
    // is the baseline the M71 optimization must reduce. One Sidebar commit per
    // throttled tick.
    for (const size of TREE_SIZES) {
      expect(
        results[size].commitsOverTicks["sidebar"].min,
      ).toBeGreaterThanOrEqual(TICKS);
      expect(
        results[size].commitsOverTicks["toolbar"].min,
      ).toBeGreaterThanOrEqual(TICKS);
    }
  });
});
