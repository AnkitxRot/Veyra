import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { treeListing, setTreeLimitsForTests, invalidateTreeCache } from "../src/files/service.js";
import { searchProjectContent } from "../src/projects/search.js";
import { discoverWorkflow } from "../src/workflow/discover.js";

/**
 * M85 — project-scale tree/search/discovery against a deterministic fixture:
 * nested source, ignored generated trees, binary + large files, and a
 * node_modules/.venv/.git-shaped layout. No invented timings.
 */
function writeLargeFixture(root: string): void {
  mkdirSync(join(root, "src", "pkg"), { recursive: true });
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(root, ".venv", "lib"), { recursive: true });
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, "__pycache__"), { recursive: true });
  mkdirSync(join(root, ".cloudide-build-debug", "9"), { recursive: true });
  mkdirSync(join(root, "vendor", "deep", "a", "b"), { recursive: true });

  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "scale-fixture",
    scripts: { test: "node --test", build: "echo ok" },
  }));
  writeFileSync(join(root, "src", "main.ts"), "export const SCALE_MARKER = 1;\n");
  writeFileSync(join(root, "src", "pkg", "util.ts"), "export function util() { return SCALE_MARKER_UTIL; }\n");
  writeFileSync(join(root, "tests", "unit", "math_test.py"), "def test_ok():\n    assert True\n");
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "SCALE_MARKER_NODE_MODULES\n");
  writeFileSync(join(root, ".venv", "lib", "site.py"), "SCALE_MARKER_VENV\n");
  writeFileSync(join(root, ".git", "objects", "pack"), "SCALE_MARKER_GIT\n");
  writeFileSync(join(root, "__pycache__", "x.pyc"), "SCALE_MARKER_PYC\n");
  writeFileSync(
    join(root, ".cloudide-build-debug", "9", "main.js"),
    "SCALE_MARKER_BUILD\n",
  );
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(join(root, "big.log"), "x".repeat(200_000) + "SCALE_MARKER_BIG\n");

  for (let i = 0; i < 250; i++) {
    const dir = join(root, "src", "gen", String(Math.floor(i / 50)));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.ts`), `export const n${i} = ${i};\n`);
  }
}

describe("M85 workspace scale", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "m85-scale-"));
    writeLargeFixture(root);
    invalidateTreeCache(root);
    setTreeLimitsForTests(null);
  });

  afterEach(() => {
    setTreeLimitsForTests(null);
    invalidateTreeCache(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("tree listing skips ignored trees and still returns nested source", async () => {
    const listing = await treeListing(root);
    const names = listing.tree.map((n) => n.name);
    expect(names).toContain("src");
    expect(names).toContain("tests");
    expect(names).toContain("package.json");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".venv");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("__pycache__");
    expect(names).not.toContain(".cloudide-build-debug");
    expect(listing.truncated).toBe(false);

    const src = listing.tree.find((n) => n.name === "src");
    expect(src?.children?.some((c) => c.name === "gen")).toBe(true);
  });

  it("search finds source markers and skips generated / dependency trees", async () => {
    const found = await searchProjectContent(root, { query: "SCALE_MARKER" });
    const paths = found.groups.map((g) => g.filePath);
    expect(paths.some((p) => p.replace(/\\/g, "/") === "src/main.ts")).toBe(true);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".venv"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
    expect(paths.some((p) => p.includes(".cloudide-build-"))).toBe(false);
    expect(paths.some((p) => p.includes("__pycache__"))).toBe(false);
  });

  it("search stays bounded on a large generated log", async () => {
    const res = await searchProjectContent(root, {
      query: "SCALE_MARKER_BIG",
      maxResults: 20,
    });
    expect(res.totalMatches).toBeLessThanOrEqual(20);
    expect(res.groups.every((g) => !g.filePath.endsWith("logo.png"))).toBe(true);
  });

  it("discovers npm test/build and nested pytest from the same workspace", async () => {
    const manifest = await discoverWorkflow(root);
    const ids = manifest.tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["npm:build", "npm:test", "pytest:all"]);
  });

  it("tree truncation is reported instead of walking forever", async () => {
    setTreeLimitsForTests({ maxEntries: 30, maxDepth: 8 });
    invalidateTreeCache(root);
    const listing = await treeListing(root);
    expect(listing.truncated).toBe(true);
    expect(listing.scanned).toBeLessThanOrEqual(30);
  });
});
