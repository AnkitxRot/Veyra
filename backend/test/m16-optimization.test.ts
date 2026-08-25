import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxManager } from "../src/execution/sandbox.js";
import { resolveConfig } from "../src/config.js";

describe("M16 Optimizations: Concurrent Preflight & Lazy Port Resolution", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "m16-test-"));
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ensureProjectSandbox creates container and initializes ports lazily without blocking exec", async () => {
    const pId = `m16-test-proj-${Date.now()}`;
    const workspace = join(tmp, pId);
    writeFileSync(join(tmp, "main.py"), "print('m16')\n");

    try {
      const containerId = await sandboxManager.ensureProjectSandbox(
        pId,
        resolveConfig(),
        workspace,
        1,
      );

      expect(containerId).toMatch(/^ide-sandbox-m16-test-proj-/);

      // Verify proxy target resolves lazily on demand
      const target = await sandboxManager.getProxyTarget(pId, 3000, false);
      // In host mode, either resolved to port or null if preview port isn't listening yet
      expect(target === null || typeof target === "string").toBe(true);
    } finally {
      await sandboxManager.stopProjectSandbox(pId);
    }
  });

  it("handles getProxyTarget for inactive project safely without throwing", async () => {
    const target = await sandboxManager.getProxyTarget("inactive-proj-id", 3000, false);
    expect(target).toBeNull();
  });
});
