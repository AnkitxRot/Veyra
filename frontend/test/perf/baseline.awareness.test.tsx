/**
 * M71 Phase 0 — BASELINE D: awareness computation cost.
 *
 * Spec target D: "measure getOnlineCollaborators / equivalent work under
 * repeated awareness changes; determine whether this is actually measurable
 * enough to matter."
 *
 * The per-change pure work is:
 *   1. readPresenceState() per peer  (client.getOnlineCollaborators)
 *   2. Sidebar's collaboratorsByPath / collaboratorsByFolder derivation
 *
 * Measured as raw ns/op over many iterations, to compare against the
 * ~5–90 ms/tick React render cost from BASELINE A.
 */
import { describe, it, expect } from "vitest";
import { readPresenceState } from "../../src/collab/presence";
import type { CollaboratorPresence } from "../../src/collab/presence";
import { makePresence, summarize } from "./harness";

function rawState(userId: number, file: string) {
  return {
    user: { id: userId, name: `user${userId}`, color: "#89b4fa", role: "editor" },
    status: "online",
    activity: { type: "editing", detail: null, timestamp: Date.now() },
    activeFile: file,
    workingFolder: file.split("/").slice(0, -1).join("/"),
    cursor: { line: 12, column: 3 },
    selection: null,
    lastActive: Date.now(),
  };
}

/** Sidebar's exact derivation (Sidebar.tsx:100-119). */
function deriveSidebarMaps(
  collaborators: CollaboratorPresence[],
  currentUserId: number,
) {
  const byPath = new Map<string, CollaboratorPresence[]>();
  const byFolder = new Map<string, CollaboratorPresence[]>();
  for (const c of collaborators) {
    if (c.userId === currentUserId || !c.activeFile) continue;
    const fileList = byPath.get(c.activeFile) || [];
    fileList.push(c);
    byPath.set(c.activeFile, fileList);
    const parts = c.activeFile.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      const arr = byFolder.get(folder) || [];
      if (!arr.some((x) => x.userId === c.userId)) arr.push(c);
      byFolder.set(folder, arr);
    }
  }
  return { byPath, byFolder };
}

describe("M71 BASELINE D — awareness computation", () => {
  it("measures pure per-change projection + derivation cost", () => {
    const ITER = 20000;
    const REPEATS = 5;

    for (const peers of [2, 8]) {
      const states = Array.from({ length: peers }, (_, i) =>
        rawState(i + 2, `src/mod${i % 4}/deep/file${i}.ts`),
      );

      const projMsRuns: number[] = [];
      const deriveMsRuns: number[] = [];

      for (let r = 0; r < REPEATS; r++) {
        // 1. getOnlineCollaborators projection
        let t0 = performance.now();
        for (let k = 0; k < ITER; k++) {
          const out: CollaboratorPresence[] = [];
          for (let ci = 0; ci < states.length; ci++) {
            const p = readPresenceState(ci, states[ci]);
            if (p) out.push(p);
          }
        }
        projMsRuns.push((performance.now() - t0) / ITER);

        // 2. Sidebar map derivation
        const roster = Array.from({ length: peers }, (_, i) =>
          makePresence({
            userId: i + 2,
            activeFile: `src/mod${i % 4}/deep/file${i}.ts`,
          }),
        );
        t0 = performance.now();
        for (let k = 0; k < ITER; k++) {
          deriveSidebarMaps(roster, 1);
        }
        deriveMsRuns.push((performance.now() - t0) / ITER);
      }

      const results = {
        peers,
        iterations: ITER,
        getOnlineCollaborators_ms_per_change: summarize(
          projMsRuns.map((n) => Math.round(n * 100000) / 100000),
        ),
        sidebarMapDerivation_ms_per_change: summarize(
          deriveMsRuns.map((n) => Math.round(n * 100000) / 100000),
        ),
      };
      console.log(
        `\n=== M71 BASELINE D: awareness computation (${peers} peers) ===\n` +
          JSON.stringify(results, null, 2),
      );

      // Pure computation is sub-millisecond per change — orders of magnitude
      // below the React render cost measured in BASELINE A.
      expect(summarize(projMsRuns).median).toBeLessThan(0.1);
      expect(summarize(deriveMsRuns).median).toBeLessThan(0.1);
    }
  });
});
