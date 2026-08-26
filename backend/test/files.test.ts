import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  safeResolve,
  tree,
  listFiles,
  invalidateTreeCache,
} from "../src/files/service.js";
import { promises as fsPromises } from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("safeResolve", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sr-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeRoot(name: string): string {
    const root = join(tmp, name);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("resolves a simple relative path", () => {
    const root = makeRoot("r0");
    const result = safeResolve(root, "foo/bar.txt");
    expect(result).toBe(join(root, "foo/bar.txt"));
  });

  it("rejects empty path", () => {
    expect(() => safeResolve(makeRoot("r1"), "")).toThrow("path is required");
  });

  it("rejects absolute Unix path", () => {
    expect(() => safeResolve(makeRoot("r2"), "/etc/passwd")).toThrow(
      "path escapes the workspace",
    );
  });

  it("rejects Windows absolute path", () => {
    expect(() => safeResolve(makeRoot("r3"), "C:\\Windows\\System32")).toThrow(
      "path escapes the workspace",
    );
  });

  it("rejects UNC path", () => {
    expect(() => safeResolve(makeRoot("r4"), "\\\\server\\share")).toThrow(
      "path escapes the workspace",
    );
  });

  it("rejects null byte", () => {
    expect(() => safeResolve(makeRoot("r5"), "foo\0bar.txt")).toThrow(
      "path escapes the workspace",
    );
  });

  it("allows path traversal within workspace", () => {
    const root = makeRoot("r6");
    const result = safeResolve(root, "a/../b/c.txt");
    expect(result).toBe(join(root, "b/c.txt"));
  });

  it("rejects path that escapes workspace", () => {
    expect(() => safeResolve(makeRoot("r7"), "../outside.txt")).toThrow(
      "path escapes the workspace",
    );
  });
});

describe("tree", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tree-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array for non-existent directory", async () => {
    const nodes = await tree(join(tmp, "nonexistent"));
    expect(nodes).toEqual([]);
  });

  it("skips BUILD_PREFIX directories", async () => {
    const root = join(tmp, "tree-root");
    mkdirSync(join(root, ".cloudide-build-abc"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.js"), 'console.log("hi");');
    const files: string[] = [];
    await listFiles(root, "", files);
    expect(files).toContain("src/main.js");
    expect(files.filter((f) => f.startsWith(".cloudide-build-"))).toHaveLength(
      0,
    );
  });

  // M42: tree()'s in-memory cache (500ms TTL, single-flight) is a pure
  // read-side cache in front of a recursive real filesystem walk. A fetch
  // that is still in flight when invalidateTreeCache(root) runs (e.g. an
  // import/delete/restore replacing the directory contents underneath it —
  // all three call invalidateTreeCache after mutating the workspace) must
  // not resurrect its now-stale result into the cache once it completes;
  // otherwise every caller sees the pre-mutation listing for a fresh new
  // TTL window instead of the correctly-invalidated state prompting a
  // re-read.
  it("does not cache a stale result from a fetch that was in flight when invalidateTreeCache() ran for its root", async () => {
    const root = join(tmp, "race-root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "old.txt"), "old");

    // Snapshot what a read started before the mutation would have seen.
    const oldSnapshot = await fsPromises.readdir(root, { withFileTypes: true });

    let releaseGate: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const spy = vi.spyOn(fsPromises, "readdir").mockImplementation(async () => {
      await gate;
      return oldSnapshot as any;
    });

    try {
      // Kick off a fetch that hangs on the gated readdir — simulating
      // doTree() genuinely in flight when the destructive operation fires.
      const inFlightFetch = tree(root);

      // Simulate the import/delete/restore invalidating the cache for this
      // root WHILE the fetch above is still pending.
      invalidateTreeCache(root);

      // Simulate the destructive operation's own file mutation landing on
      // disk (old.txt is deliberately left in place so doTree's real
      // per-file fs.stat(), which is not mocked, still succeeds for it).
      writeFileSync(join(root, "new.txt"), "new");

      releaseGate!();
      await inFlightFetch;
      spy.mockRestore();

      // A correct implementation must re-read the directory (the cache was
      // invalidated) and see both files, not silently serve the stale
      // in-flight fetch's result.
      const result = await tree(root);
      expect(result.map((n) => n.name).sort()).toEqual(["new.txt", "old.txt"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listFiles", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "list-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns files in nested directories", async () => {
    const root = join(tmp, "list-root");
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "deep.txt"), "deep");
    writeFileSync(join(root, "top.txt"), "top");

    const files: string[] = [];
    await listFiles(root, "", files);
    expect(files.sort()).toEqual(["a/b/c/deep.txt", "top.txt"]);
  });

  it("skips node_modules, .venv, and .git", async () => {
    const root = join(tmp, "list-skip");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".venv", "lib"), { recursive: true });
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(root, ".venv", "lib", "run.py"), "");
    writeFileSync(join(root, ".git", "objects", "abc"), "");
    writeFileSync(join(root, "src", "main.ts"), "");

    const files: string[] = [];
    await listFiles(root, "", files);
    expect(files).toEqual(["src/main.ts"]);
  });
});
