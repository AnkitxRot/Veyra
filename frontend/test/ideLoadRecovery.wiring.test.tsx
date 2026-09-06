import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);

/**
 * M68 — IDE.tsx wiring for project/workspace load reliability & recovery.
 * Source-string guards (the ~3700-line component is not rendered in unit
 * tests — see IDE.connectionVisibility.test.tsx). The behaviour of the
 * extracted pieces is tested directly: useProjectRole.test.tsx,
 * Sidebar.treeLoadState.test.tsx, ideLoadRecovery.mediation.test.tsx,
 * plus the shared useNotices.test.tsx.
 */
describe("M68 — role fetch fails closed", () => {
  it("takes its role from useProjectRole, not a local useState default", () => {
    expect(src).toContain(
      'import { useProjectRole } from "../../hooks/useProjectRole"',
    );
    expect(src).toContain("} = useProjectRole(project?.id ?? null);");
    // the old fail-open path is gone: no local role state, no owner default
    expect(src).not.toContain("setProjectRole");
    expect(src).not.toMatch(/useState<"owner" \| "editor" \| "viewer">/);
  });

  it("no longer fetches the role inside the collab lifecycle effect", () => {
    expect(src).not.toContain("// Fetch project access role");
    expect(src).not.toContain(
      'api<{ project: Project; role?: "owner" | "editor" | "viewer" }>',
    );
  });

  it("surfaces a persistent, retryable notice while the role lookup is errored", () => {
    const at = src.indexOf('dedupeKey: "role-fetch"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 400, at + 200);
    expect(block).toContain('roleStatus === "error"');
    expect(block).toContain("ttl: null");
    expect(block).toContain('role: "alert"');
    expect(block).toContain("onClick: retryProjectRole");
  });

  it("clears the role notice on any non-error status (successful retry included)", () => {
    const at = src.indexOf('dedupeKey: "role-fetch"');
    const block = src.slice(at, at + 300);
    expect(block).toContain('dismissNoticeKey("role-fetch")');
  });

  it("read-only editor + owner-gated UI both key off the fail-closed role", () => {
    expect(src).toContain('isReadOnly={projectRole === "viewer"}');
    expect(src).toContain('projectRole === "owner"');
  });
});

describe("M68 — file tree load state & retry", () => {
  it("tracks the tree fetch lifecycle instead of swallowing failures", () => {
    expect(src).not.toMatch(/\/api\/projects\/\$\{pid\}\/tree`,\n\s*\);\n\s*setTree\(res\.tree\);\n\s*treeLoadedForRef\.current = pid;\n\s*\} catch \{\}/);
    expect(src).toContain(
      'const [treeStatus, setTreeStatus] = useState<"loading" | "ready" | "error">',
    );
    const block = src.slice(
      src.indexOf("const loadTree = useCallback"),
      src.indexOf("const loadTree = useCallback") + 900,
    );
    expect(block).toContain('setTreeStatus("loading")');
    expect(block).toContain('setTreeStatus("ready")');
    expect(block).toContain('setTreeStatus("error")');
  });

  it("a failed tree load is a persistent, retryable error notice", () => {
    const at = src.indexOf('dedupeKey: "tree-load"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 260, at + 160);
    expect(block).toContain('kind: "error"');
    expect(block).toContain("ttl: null");
    expect(block).toContain("onClick: () => loadTreeRef.current()");
  });

  it("a successful (re)load clears the standing tree-load notice", () => {
    const block = src.slice(
      src.indexOf("const loadTree = useCallback"),
      src.indexOf("const loadTree = useCallback") + 900,
    );
    expect(block).toContain('dismissNoticeKey("tree-load")');
  });

  it("feeds the tree status and a stable retry into the Sidebar", () => {
    expect(src).toContain("treeStatus={treeStatus}");
    expect(src).toContain("onRetryTree={() => loadTreeRef.current()}");
  });

  it("drops the previous project's tree on a project switch (no stale files under a failed load)", () => {
    const reset = src.slice(
      src.indexOf("setOpenFiles([]);"),
      src.indexOf("setOpenFiles([]);") + 500,
    );
    expect(reset).toContain("setTree([]);");
    expect(reset).toContain('setTreeStatus("loading");');
  });

  it("does not flash loading over an already-loaded tree on a background refresh", () => {
    const block = src.slice(
      src.indexOf("const loadTree = useCallback"),
      src.indexOf("const loadTree = useCallback") + 1100,
    );
    expect(block).toContain('if (treeLoadedForRef.current !== pid) setTreeStatus("loading")');
  });

  it("dedupes a same-project Retry but lets a project switch supersede the load", () => {
    const block = src.slice(
      src.indexOf("const loadTree = useCallback"),
      src.indexOf("const loadTree = useCallback") + 1400,
    );
    // same project already loading → drop the duplicate
    expect(block).toContain("if (treeLoadingPidRef.current === pid) return;");
    // a stale fetch's result is discarded by the generation check
    expect(block).toContain("const gen = ++treeLoadGenRef.current;");
    expect(block.match(/if \(gen !== treeLoadGenRef\.current\) return;/g) ?? []).toHaveLength(2);
    // only the current generation frees the in-flight marker
    expect(block).toContain("gen === treeLoadGenRef.current &&");
  });

  it("frees the tree in-flight marker and bumps the generation on a project switch", () => {
    const reset = src.slice(
      src.indexOf("setOpenFiles([]);"),
      src.indexOf("setOpenFiles([]);") + 900,
    );
    expect(reset).toContain("treeLoadingPidRef.current = null;");
    expect(reset).toContain("treeLoadGenRef.current++;");
  });

  it("timeline fetches drop their result when the project changed under them", () => {
    // render-time mirror of the open project id
    expect(src).toContain("activeProjectIdRef.current = project?.id ?? null;");
    // all three fetchCollabTimeline .then callbacks guard on it
    const guards = src.match(/!== activeProjectIdRef\.current\) return;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });
});

describe("M68 — project list load failure", () => {
  it("no longer swallows a total /api/projects failure", () => {
    const block = src.slice(
      src.indexOf("const loadProjects = useCallback"),
      src.indexOf("const loadProjects = useCallback") + 2600,
    );
    // the bare `} catch {}` is replaced by a notifying catch
    expect(block).not.toMatch(/\}\s*catch\s*\{\}\n\s*\/\/ routeProjectId is read/);
    expect(block).toContain('dedupeKey: "projects-load"');
  });

  it("a failed project list load is a persistent, retryable error notice", () => {
    const at = src.indexOf('dedupeKey: "projects-load"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 260, at + 160);
    expect(block).toContain('kind: "error"');
    expect(block).toContain("ttl: null");
    expect(block).toContain("onClick: () => loadProjectsRef.current()");
  });

  it("a successful project list load clears the standing notice", () => {
    const block = src.slice(
      src.indexOf("const loadProjects = useCallback"),
      src.indexOf("const loadProjects = useCallback") + 2600,
    );
    expect(block).toContain('dismissNoticeKey("projects-load")');
  });
});

describe("M68 — roster / timeline / while-away failures are visible & retryable", () => {
  it("no silent catches remain on the covered project/workspace load paths", () => {
    for (const key of ["roster-load", "whileaway-load", "timeline-load", "timeline-more"]) {
      expect(src).toContain(`dedupeKey: "${key}"`);
    }
  });

  it("the roster fetch failure keeps the last roster and offers a retry", () => {
    const at = src.indexOf('dedupeKey: "roster-load"');
    const block = src.slice(at - 300, at + 120);
    expect(block).toContain('kind: "warning"');
    expect(block).toContain("onClick: () => loadCommentRoster()");
    // success path clears it
    expect(src).toContain('dismissNoticeKey("roster-load")');
  });

  it("the while-away summary failure is retryable and leaves reconnect semantics alone", () => {
    const at = src.indexOf('dedupeKey: "whileaway-load"');
    const block = src.slice(at - 320, at + 120);
    expect(block).toContain("onClick: () => loadWhileAway()");
    expect(src).toContain('dismissNoticeKey("whileaway-load")');
    // the M63 threshold gate is unchanged
    expect(src).toContain("info.offlineMs < COLLAB_AWAY_THRESHOLD_MS");
  });

  it("the initial timeline failure does not spin — it waits for an explicit retry", () => {
    const at = src.indexOf('dedupeKey: "timeline-load"');
    const block = src.slice(at - 260, at + 160);
    expect(block).toContain("onClick: () => setTimelineLoaded(false)");
    // the old immediate `.catch(() => setTimelineLoaded(false))` retry loop is gone
    expect(src).not.toContain(".catch(() => setTimelineLoaded(false))");
    expect(src).toContain('dismissNoticeKey("timeline-load")');
  });

  it("the load-more failure is a transient notice (the Load more control is the retry)", () => {
    const at = src.indexOf('dedupeKey: "timeline-more"');
    const block = src.slice(at - 200, at + 60);
    expect(block).toContain("ttl: 6000");
  });
});
