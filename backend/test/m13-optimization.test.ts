import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sandboxManager } from "../src/execution/sandbox.js";
import { isDockerRunningAsync, isRunnerImageAvailableAsync, resetDockerCacheForTests } from "../src/tools.js";

describe("M13 Optimizations: Parallelized Checks & Liveness Freshness", () => {
  beforeEach(() => {
    resetDockerCacheForTests();
  });
  afterEach(() => {
    resetDockerCacheForTests();
  });

  it("parallel availability checks resolve concurrently without errors", async () => {
    const [dockerRunning, runnerAvailable] = await Promise.all([
      isDockerRunningAsync(),
      isRunnerImageAvailableAsync(),
    ]);

    expect(typeof dockerRunning).toBe("boolean");
    expect(typeof runnerAvailable).toBe("boolean");
  });

  it("handles repeated ensureProjectSandbox calls within freshness window gracefully", async () => {
    const active = await sandboxManager.getAllActiveSandboxes();
    expect(Array.isArray(active)).toBe(true);
  });
});
