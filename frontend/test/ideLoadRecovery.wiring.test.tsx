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
 * FileTree.loadState.test.tsx, plus the shared useNotices.test.tsx.
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
