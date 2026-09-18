import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/components/IDE/IDE.tsx"), "utf-8");

describe("M85 — project switch and git tree wiring", () => {
  it("clears Problems / LSP diagnostics on project switch", () => {
    const reset = src.slice(
      src.indexOf("setOpenFiles([]);"),
      src.indexOf("setOpenFiles([]);") + 1200,
    );
    expect(reset).toContain("setDiagnostics([])");
    expect(reset).toContain("setLspDiagnostics([])");
    expect(reset).toContain("setLspStatuses({})");
  });

  it("refreshes the file tree after authoritative git mutations (checkout and pull)", () => {
    expect(src).toContain("if (opts.authoritative)");
    expect(src).toContain("void loadTree()");
    expect(src).not.toContain('opts.noticeLabel === "Branch checkout"');
  });

  it("registers Go to Symbol in Workspace", () => {
    expect(src).toContain('id: "workbench.action.gotoSymbol"');
    expect(src).toContain("searchSymbols={searchWorkspaceSymbols}");
  });

  it("does not steal the Tests tab when a test run reports failures", () => {
    expect(src).toContain(
      "const testRun = Array.isArray(tests) && tests.length > 0",
    );
    expect(src).toContain("!testRun");
  });
});
