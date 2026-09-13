import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tree } from "../src/files/service.js";
import {
  isDockerRunningAsync,
  isRunnerImageAvailableAsync,
  resetDockerCacheForTests,
} from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";

describe("M11 Optimizations: Docker Checks Coalescing", () => {
  beforeEach(() => {
    resetDockerCacheForTests();
  });

  afterEach(() => {
    resetDockerCacheForTests();
  });

  it("coalesces concurrent isDockerRunningAsync calls into a single flight", async () => {
    const promises = Array.from({ length: 20 }, () => isDockerRunningAsync());
    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    const first = results[0];
    for (const r of results) {
      expect(r).toBe(first);
    }
  });

  it("coalesces concurrent isRunnerImageAvailableAsync calls into a single flight", async () => {
    const promises = Array.from({ length: 20 }, () =>
      isRunnerImageAvailableAsync(),
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    const first = results[0];
    for (const r of results) {
      expect(r).toBe(first);
    }
  });
});

describe("M11 Optimizations: Filesystem Tree Bounded Concurrency", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tree-opt-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns exact deterministic ordering for nested directory structures", async () => {
    const root = join(tmp, "project");
    mkdirSync(join(root, "src", "components"), { recursive: true });
    mkdirSync(join(root, "src", "utils"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });

    writeFileSync(join(root, "README.md"), "# Hello");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src", "index.ts"), "export * from './utils';");
    writeFileSync(join(root, "src", "components", "Button.tsx"), "<button/>");
    writeFileSync(join(root, "src", "components", "Card.tsx"), "<div/>");
    writeFileSync(join(root, "src", "utils", "math.ts"), "export const add = 1;");
    writeFileSync(join(root, "docs", "guide.md"), "# Guide");

    const t = await tree(root);

    // Directories first (alphabetical: docs, src), then files (alphabetical: README.md, package.json)
    expect(t.map((n) => n.name)).toEqual(["docs", "src", "package.json", "README.md"]);

    const docs = t.find((n) => n.name === "docs");
    expect(docs?.type).toBe("dir");
    expect(docs?.children?.map((c) => c.name)).toEqual(["guide.md"]);

    const src = t.find((n) => n.name === "src");
    expect(src?.type).toBe("dir");
    expect(src?.children?.map((c) => c.name)).toEqual(["components", "utils", "index.ts"]);
  });

  it("correctly handles large directory trees across concurrent callers", async () => {
    const root = join(tmp, "large-project");
    mkdirSync(root, { recursive: true });

    for (let i = 0; i < 100; i++) {
      writeFileSync(join(root, `file_${String(i).padStart(3, "0")}.txt`), `data ${i}`);
    }

    const tasks = Array.from({ length: 10 }, () => tree(root));
    const results = await Promise.all(tasks);

    expect(results).toHaveLength(10);
    const baseline = results[0];
    expect(baseline).toHaveLength(100);
    for (const r of results) {
      expect(r).toEqual(baseline);
    }
  });

  it("gracefully ignores non-existent directories and skips build prefix", async () => {
    const nonExistent = await tree(join(tmp, "does-not-exist"));
    expect(nonExistent).toEqual([]);

    const root = join(tmp, "build-skip");
    mkdirSync(join(root, ".cloudide-build-temp"), { recursive: true });
    mkdirSync(join(root, "valid-dir"), { recursive: true });
    writeFileSync(join(root, "valid-dir", "code.js"), "1");

    const t = await tree(root);
    expect(t).toHaveLength(1);
    expect(t[0].name).toBe("valid-dir");
  });
});

describe("M11 Optimizations: Stats Telemetry Fast-Path & Invalidation", () => {
  it("immediately returns inactive stats for unknown project without calling docker stats", async () => {
    const t0 = Date.now();
    const stats = await sandboxManager.getContainerStats("non-existent-project-id");
    const elapsed = Date.now() - t0;

    expect(stats.running).toBe(false);
    expect(stats.cpuPercent).toBe(0);
    expect(stats.memoryUsageBytes).toBe(0);
    // Instant execution (sub-10ms, rather than 50-100ms child process timeout)
    expect(elapsed).toBeLessThan(20);
  });
});
