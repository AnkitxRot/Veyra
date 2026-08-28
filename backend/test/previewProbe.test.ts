import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  detectPreviewPorts,
  _clearPreviewDetectionCache,
} from "../src/execution/previewProbe.js";
import { ALLOWED_PREVIEW_PORTS } from "../src/execution/previewPorts.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import type { AppConfig } from "../src/config.js";

const cfg = { containerized: false } as AppConfig;

beforeEach(() => {
  _clearPreviewDetectionCache();
  vi.restoreAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("detectPreviewPorts — pure detection logic", () => {
  it("no active sandbox => { ports: [], sandbox: false }, no probing attempted", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(false);
    const resolveTarget = vi.fn();
    const probe = vi.fn();
    const out = await detectPreviewPorts("p1", cfg, { resolveTarget, probe });
    expect(out).toEqual({ ports: [], sandbox: false });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("an allowed HTTP server that responds is detected", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (port: number) => `http://127.0.0.1:5${port}`);
    const probe = vi
      .fn()
      .mockImplementation(async (url: string) => url.endsWith("55173"));
    const out = await detectPreviewPorts("p1", cfg, { resolveTarget, probe });
    expect(out.sandbox).toBe(true);
    expect(out.ports).toEqual([5173]);
  });

  it("only probes ALLOWED_PREVIEW_PORTS — never any other port", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const probedPorts: number[] = [];
    const resolveTarget = vi.fn().mockImplementation(async (port: number) => {
      probedPorts.push(port);
      return `http://sandbox:${port}`;
    });
    const probe = vi.fn().mockResolvedValue(false);
    await detectPreviewPorts("p1", cfg, { resolveTarget, probe });
    expect([...probedPorts].sort((a, b) => a - b)).toEqual(
      [...ALLOWED_PREVIEW_PORTS].sort((a, b) => a - b),
    );
    // a would-be disallowed port (22, 80, 443, 6379, ...) is never requested
    for (const bad of [22, 80, 443, 5432, 6379, 9229, 169]) {
      expect(probedPorts).not.toContain(bad);
    }
  });

  it("a disallowed port that happens to be up is never surfaced", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    // resolver + probe say "everything is up", including a bogus 9999
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (port: number) => `http://x:${port}`);
    const probe = vi.fn().mockResolvedValue(true);
    const out = await detectPreviewPorts("p1", cfg, { resolveTarget, probe });
    expect(out.ports).toEqual([...ALLOWED_PREVIEW_PORTS]);
    expect(out.ports).not.toContain(9999);
    expect(out.ports.every((p) => (ALLOWED_PREVIEW_PORTS as readonly number[]).includes(p))).toBe(true);
  });

  it("multiple listening servers are returned in ALLOWED_PREVIEW_PORTS order (deterministic)", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const up = new Set([8080, 3000, 5173]);
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (port: number) => `http://x:${port}`);
    const probe = vi
      .fn()
      .mockImplementation(async (url: string) =>
        up.has(Number(url.split(":").pop())),
      );
    const out = await detectPreviewPorts("p1", cfg, { resolveTarget, probe });
    // allowlist order is [3000, 4173, 5173, 8000, 8080]
    expect(out.ports).toEqual([3000, 5173, 8080]);
  });

  it("a mapped-but-dead port (target resolves, HTTP refused) is NOT reported as listening", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (port: number) => `http://x:${port}`); // docker mapping exists
    const probe = vi.fn().mockResolvedValue(false); // but nothing answers
    const out = await detectPreviewPorts("p1", cfg, { resolveTarget, probe });
    expect(out).toEqual({ ports: [], sandbox: true });
  });

  it("a stopped server disappears from a fresh detection (no stale cache across TTL)", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (port: number) => `http://x:${port}`);
    let serverUp = true;
    const probe = vi
      .fn()
      .mockImplementation(async (url: string) =>
        serverUp && url.endsWith(":8000"),
      );
    let clock = 1_000_000;
    const now = () => clock;

    const first = await detectPreviewPorts("p1", cfg, {
      resolveTarget,
      probe,
      now,
    });
    expect(first.ports).toEqual([8000]);

    serverUp = false;
    // within the cache TTL: still the cached (stale) answer
    clock += 1000;
    expect(
      (await detectPreviewPorts("p1", cfg, { resolveTarget, probe, now })).ports,
    ).toEqual([8000]);

    // past the TTL: re-probed, server is gone
    clock += 5000;
    expect(
      (await detectPreviewPorts("p1", cfg, { resolveTarget, probe, now })).ports,
    ).toEqual([]);
  });

  it("caches per project — one project's result never bleeds into another", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (port: number) => `http://x:${port}`);
    const probe = vi
      .fn()
      .mockImplementation(async (url: string) => url.endsWith(":3000"));
    const now = () => 5_000_000;
    const a = await detectPreviewPorts("projA", cfg, { resolveTarget, probe, now });
    const b = await detectPreviewPorts(
      "projB",
      cfg,
      { resolveTarget: async () => null, probe: async () => true, now },
    );
    expect(a.ports).toEqual([3000]);
    expect(b.ports).toEqual([]); // projB resolved no targets -> nothing detected
  });

  it("short-TTL cache prevents a fast poller from hammering internal probes", async () => {
    vi.spyOn(sandboxManager, "hasActiveSandbox").mockReturnValue(true);
    const probe = vi.fn().mockResolvedValue(false);
    const resolveTarget = vi
      .fn()
      .mockImplementation(async (p: number) => `http://x:${p}`);
    let clock = 2_000_000;
    const now = () => clock;
    for (let i = 0; i < 10; i++) {
      await detectPreviewPorts("p1", cfg, { resolveTarget, probe, now });
      clock += 100; // 10 calls within ~1s
    }
    // 5 allowed ports probed once, not 50 times
    expect(probe).toHaveBeenCalledTimes(ALLOWED_PREVIEW_PORTS.length);
  });
});
