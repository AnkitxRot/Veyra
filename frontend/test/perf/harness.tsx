/**
 * M71 Phase 0 — deterministic frontend render-measurement harness.
 *
 * NOT a test file (no `.test.` in the name, so vitest's
 * `test/**\/*.test.{ts,tsx}` include never picks it up).
 *
 * What this measures and what it does NOT:
 *  - MEASURES: React commit counts and React's own `actualDuration`
 *    (milliseconds of reconciliation+commit work, as reported by
 *    <Profiler>) for real components under a scripted state workload,
 *    plus rendered DOM node counts. All deterministic under fake timers.
 *  - DOES NOT measure: browser paint, layout, FPS, CPU, RSS. jsdom has no
 *    layout engine. `actualDuration` is React work only and is
 *    machine-relative — it is reported as min/median/max over repeats and
 *    only ever compared before/after on the same machine in the same run.
 *
 * The transport (WebSocket / Yjs) is never exercised here. The collaborator
 * scenario drives the exact state wiring `IDE.tsx` uses
 * (`throttleLatest(setCollaborators, 200)` fed a fresh presence array per
 * emit) against the real <Sidebar> / <Toolbar>; the fake emitter stands in
 * only for the socket, which is not what is being measured.
 */
import * as React from "react";
import { Profiler } from "react";
import type { CollaboratorPresence } from "../../src/collab/presence";
import type { TreeNode } from "../../src/types";

// --- commit counting --------------------------------------------------------

export interface CommitTally {
  count: number;
  durations: number[];
}

export class RenderRecorder {
  private tallies = new Map<string, CommitTally>();

  onRender = (
    id: string,
    _phase: "mount" | "update" | "nested-update",
    actualDuration: number,
  ): void => {
    const t = this.tallies.get(id) ?? { count: 0, durations: [] };
    t.count += 1;
    t.durations.push(actualDuration);
    this.tallies.set(id, t);
  };

  reset(): void {
    this.tallies.clear();
  }

  count(id: string): number {
    return this.tallies.get(id)?.count ?? 0;
  }

  /** Total React actualDuration (ms) attributed to `id` since the last reset. */
  totalDuration(id: string): number {
    return (this.tallies.get(id)?.durations ?? []).reduce((a, b) => a + b, 0);
  }

  ids(): string[] {
    return [...this.tallies.keys()];
  }
}

export function Probe({
  id,
  recorder,
  children,
}: React.PropsWithChildren<{ id: string; recorder: RenderRecorder }>) {
  return (
    <Profiler id={id} onRender={recorder.onRender}>
      {children}
    </Profiler>
  );
}

/**
 * A `React.memo` boundary with a <Profiler> attached, for measuring whether a
 * memoized child actually bails. Unlike <Probe>, this wrapper is itself
 * memoized on the SAME shallow prop comparison the component-under-test uses,
 * so when the parent re-renders with unchanged props NOTHING inside fires —
 * no Profiler self-render, no child render. `recorder` must be referentially
 * stable across the measured window.
 */
export function profiledMemo<P extends object>(
  Component: React.ComponentType<P>,
  id: string,
): React.ComponentType<P & { recorder: RenderRecorder }> {
  const Memoized = React.memo(function Profiled({
    recorder,
    ...rest
  }: P & { recorder: RenderRecorder }) {
    return (
      <Profiler id={id} onRender={recorder.onRender}>
        <Component {...(rest as P)} />
      </Profiler>
    );
  });
  Memoized.displayName = `profiledMemo(${id})`;
  return Memoized as unknown as React.ComponentType<
    P & { recorder: RenderRecorder }
  >;
}

// --- repeatability ---------------------------------------------------------

export interface Stat {
  min: number;
  median: number;
  max: number;
  runs: number[];
}

export function summarize(runs: number[]): Stat {
  const sorted = [...runs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  return { min: sorted[0], median, max: sorted[sorted.length - 1], runs };
}

/** Run `scenario` `repeats` times, collecting one number per run. */
export async function repeat(
  repeats: number,
  scenario: (runIndex: number) => Promise<number> | number,
): Promise<Stat> {
  const out: number[] = [];
  for (let i = 0; i < repeats; i++) {
    out.push(await scenario(i));
  }
  return summarize(out);
}

// --- synthetic workspace tree --------------------------------------------

/**
 * Build a synthetic tree with exactly `fileCount` files, laid out in a
 * realistic-ish shape: `dirs` top-level directories, each with nested
 * subdirectories, leaf files spread across them. Deterministic.
 */
export function buildTree(fileCount: number, opts?: { dirs?: number }): TreeNode[] {
  const dirs = opts?.dirs ?? Math.max(4, Math.round(Math.sqrt(fileCount) / 2));
  const perDir = Math.ceil(fileCount / dirs);
  let made = 0;
  const roots: TreeNode[] = [];
  for (let d = 0; d < dirs && made < fileCount; d++) {
    const dirPath = `src/mod${d}`;
    const children: TreeNode[] = [];
    // one nested sub-dir per top dir to exercise recursion depth
    const subChildren: TreeNode[] = [];
    for (let f = 0; f < perDir && made < fileCount; f++) {
      const target = f % 3 === 0 ? subChildren : children;
      const base = target === subChildren ? `${dirPath}/util` : dirPath;
      target.push({
        name: `file${f}.ts`,
        path: `${base}/file${f}.ts`,
        type: "file",
      } as TreeNode);
      made++;
    }
    if (subChildren.length) {
      children.unshift({
        name: "util",
        path: `${dirPath}/util`,
        type: "dir",
        children: subChildren,
      } as TreeNode);
    }
    roots.push({
      name: `mod${d}`,
      path: dirPath,
      type: "dir",
      children,
    } as TreeNode);
  }
  return roots;
}

/** Count the leaf files in a tree (sanity for buildTree). */
export function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n++;
    else if (node.children) n += countFiles(node.children);
  }
  return n;
}

// --- synthetic collaborator presence -----------------------------------

let clientSeq = 100;

export function makePresence(
  over: Partial<CollaboratorPresence> = {},
): CollaboratorPresence {
  const clientId = over.clientId ?? clientSeq++;
  const userId = over.userId ?? clientId;
  return {
    clientId,
    userId,
    name: over.name ?? `user${userId}`,
    role: over.role ?? "editor",
    color: over.color ?? "#89b4fa",
    status: over.status ?? "online",
    activity: over.activity ?? { type: "editing", timestamp: 0 },
    activeFile: over.activeFile ?? "src/mod0/file0.ts",
    workingFolder: over.workingFolder ?? "src/mod0",
    cursor: over.cursor ?? { line: 1, column: 1 },
    selection: over.selection ?? null,
    lastActive: over.lastActive ?? 0,
    ...over,
  };
}

/**
 * Re-project a presence list as the awareness `change` handler does: fresh
 * objects every time (this is `getOnlineCollaborators()`'s real behavior —
 * `readPresenceState` allocates a new object per state on every call). The
 * `bump` argument simulates the fields that churn on a remote peer's every
 * keystroke: `cursor` and `lastActive`.
 */
export function reproject(
  list: CollaboratorPresence[],
  bump: { cursorLine?: number; lastActive?: number } = {},
): CollaboratorPresence[] {
  return list.map((c) => ({
    ...c,
    cursor: bump.cursorLine != null ? { line: bump.cursorLine, column: 1 } : c.cursor,
    lastActive: bump.lastActive ?? c.lastActive,
  }));
}
