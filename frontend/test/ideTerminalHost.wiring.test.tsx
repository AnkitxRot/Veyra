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
 * M79 — IDE.tsx wiring for the project-lifetime terminal session.
 * Source-string guards (rendering the ~4000-line component is not the house
 * style — see IDE.connectionVisibility.test.tsx). Behaviour is covered by
 * terminalSession.*.test.tsx.
 */
describe("M79 — IDE.tsx terminal host wiring", () => {
  it("renders <Terminal> with a `visible` prop, not gated by bottomTab === 'terminal'", () => {
    const at = src.indexOf("<Terminal");
    expect(at).toBeGreaterThan(-1);
    const jsx = src.slice(at, at + 320);
    expect(jsx).toMatch(/visible=\{/);
    expect(jsx).toMatch(/projectId=\{/);
    expect(jsx).toMatch(/userId=\{/);
    // The old kill-on-tab-switch guard must be gone.
    expect(src).not.toMatch(/\{bottomTab === "terminal" && \(\s*<Terminal/);
  });

  it("mounts the terminal host outside the `!isBottomCollapsed` content block", () => {
    // The other panels stay gated; the terminal host is a sibling that is
    // always rendered while a project is open (display-toggled by `visible`).
    const collapsedBlock = src.indexOf("{!isBottomCollapsed && (");
    const terminalAt = src.indexOf("<Terminal");
    expect(collapsedBlock).toBeGreaterThan(-1);
    expect(terminalAt).toBeGreaterThan(-1);
    // <Terminal> appears after the close of the collapsed block, or the
    // collapsed block explicitly excludes the terminal tab.
    const otherPanelsGate = src.match(
      /!isBottomCollapsed && bottomTab !== "terminal"/,
    );
    const terminalAfterBlock =
      src.indexOf("<Terminal") >
      src.indexOf("{bottomTab === \"git\" && (");
    expect(Boolean(otherPanelsGate) || terminalAfterBlock).toBe(true);
  });

  it("does not carry the stale 'Terminal ... never remount' comment", () => {
    expect(src).not.toMatch(/Terminal, which update Monaco \/ xterm in place \(never remount\)/);
  });

  it("M86: the terminal host receives the authenticated user id", () => {
    const at = src.indexOf("<Terminal");
    const jsx = src.slice(at, at + 400);
    expect(jsx).toContain("userId={user.id}");
  });
});
