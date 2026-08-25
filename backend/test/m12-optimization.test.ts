import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tree,
  writeProjectFile,
  deleteProjectPath,
  invalidateTreeCache,
} from "../src/files/service.js";
import { sandboxManager } from "../src/execution/sandbox.js";

describe("M12 Optimizations: Tree Single-Flight Caching & Invalidation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tree-m12-"));
    invalidateTreeCache();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    invalidateTreeCache();
  });

  it("coalesces concurrent tree() calls on the same root into a single flight", async () => {
    const root = join(tmp, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const a = 1;");
    writeFileSync(join(root, "README.md"), "# Hello");

    const tasks = Array.from({ length: 25 }, () => tree(root));
    const results = await Promise.all(tasks);

    expect(results).toHaveLength(25);
    const baseline = results[0];
    expect(baseline.map((n) => n.name)).toEqual(["src", "README.md"]);
    for (const r of results) {
      expect(r).toEqual(baseline);
    }
  });

  it("invalidates cache immediately on writeProjectFile", async () => {
    const root = join(tmp, "project-write");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "initial.txt"), "hello");

    const t1 = await tree(root);
    expect(t1.map((n) => n.name)).toEqual(["initial.txt"]);

    // Write a new file
    await writeProjectFile(root, "new_file.txt", "world");

    // Must immediately reflect new file without waiting for TTL
    const t2 = await tree(root);
    expect(t2.map((n) => n.name)).toEqual(["initial.txt", "new_file.txt"]);
  });

  it("invalidates cache immediately on deleteProjectPath", async () => {
    const root = join(tmp, "project-delete");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");

    const t1 = await tree(root);
    expect(t1.map((n) => n.name)).toEqual(["a.txt", "b.txt"]);

    await deleteProjectPath(root, "a.txt");

    const t2 = await tree(root);
    expect(t2.map((n) => n.name)).toEqual(["b.txt"]);
  });
});

describe("M12 Optimizations: Lazy Port Resolution & Sandbox Lifecycle", () => {
  it("getProxyTarget returns null for inactive project without throwing", async () => {
    const target = await sandboxManager.getProxyTarget("non-existent-proj", 3000, false);
    expect(target).toBeNull();
  });
});
