import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "../src/components/Admin/AdminDashboard.tsx"),
  "utf-8",
);

/**
 * M76 — AdminDashboard wiring for the canonical M64 notice system.
 *
 * The /admin route mounts AdminDashboard standalone (App.tsx) — no IDE, so no
 * access to the IDE's single useNotices owner. It gets its OWN instance of the
 * same hook + NoticeStack (not a second notification mechanism). Source-string
 * guards, matching ideNotices.wiring.test.tsx: rendering the 2500-line
 * component in a unit test is not the house style; useNotices.test.tsx /
 * NoticeStack.test.tsx cover the behaviour of the pieces.
 */
describe("M76 — AdminDashboard notice wiring", () => {
  it("instantiates the canonical notice hook once and renders one NoticeStack", () => {
    expect(src).toContain(
      'import { useNotices } from "../../hooks/useNotices"',
    );
    expect(src).toContain('import NoticeStack from "../common/NoticeStack"');
    expect(src.match(/useNotices\(\)/g) ?? []).toHaveLength(1);
    expect(src.match(/<NoticeStack/g) ?? []).toHaveLength(1);
    const at = src.indexOf("<NoticeStack");
    const jsx = src.slice(at, at + 200);
    expect(jsx).toMatch(
      /notices=\{adminNotices\.filter\(\(n\) => n\.surface === "stack"\)\}/,
    );
    expect(jsx).toContain("onDismiss={dismissAdminNotice}");
  });

  it("has no blocking alert() / confirm() left — every async failure is a notice", () => {
    expect(src).not.toContain("alert(");
    expect(src).not.toContain("window.confirm");
  });

  it("both former alert() sites now raise an error notice", () => {
    // inspect-user load failure
    const inspectAt = src.indexOf("Failed to load user details");
    expect(inspectAt).toBeGreaterThan(-1);
    expect(src.slice(inspectAt - 120, inspectAt)).toContain(
      'notifyAdmin({\n        kind: "error"',
    );
    // sandbox termination failure — and the confirm modal stays open for retry
    const termAt = src.indexOf("Sandbox termination failed");
    expect(termAt).toBeGreaterThan(-1);
    expect(src.slice(termAt - 200, termAt)).toContain('kind: "error"');
    const termHandler = src.slice(
      src.indexOf("const handleTerminateConfirm"),
      src.indexOf("const handleTerminateConfirm") + 700,
    );
    // no setTerminatingSandbox(null) in the catch — modal must not close on error
    const catchBlock = termHandler.slice(termHandler.indexOf("catch"));
    expect(catchBlock).not.toContain("setTerminatingSandbox(null)");
  });
});
