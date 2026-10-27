import { describe, it, expect } from "vitest";
import {
  parseHostProfileSetting,
  resolveHostProfile,
  selectProfileName,
} from "../src/resourceProfile";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe("resourceProfile", () => {
  it("auto picks low under 4 GiB RAM or <=2 cores, else standard", () => {
    expect(selectProfileName("auto", { totalMemBytes: 2 * GiB, cpuCount: 8 })).toBe("low");
    expect(selectProfileName("auto", { totalMemBytes: 16 * GiB, cpuCount: 2 })).toBe("low");
    expect(selectProfileName("auto", { totalMemBytes: 4 * GiB, cpuCount: 4 })).toBe("standard");
    expect(selectProfileName("auto", { totalMemBytes: 16 * GiB, cpuCount: 8 })).toBe("standard");
  });

  it("an explicit setting overrides detection; junk falls back to auto", () => {
    expect(selectProfileName("standard", { totalMemBytes: GiB, cpuCount: 1 })).toBe("standard");
    expect(selectProfileName("low", { totalMemBytes: 64 * GiB, cpuCount: 64 })).toBe("low");
    expect(parseHostProfileSetting("LOW")).toBe("low");
    expect(parseHostProfileSetting("bogus")).toBe("auto");
    expect(parseHostProfileSetting(undefined)).toBe("auto");
  });

  it("derives low-profile caps for 2 GiB", () => {
    const p = resolveHostProfile("auto", { totalMemBytes: 2 * GiB, cpuCount: 2 });
    expect(p.name).toBe("low");
    expect(p.memoryBytes).toBe(256 * MiB);
    expect(p.cpuQuota).toBe(50_000);
    expect(p.pidsLimit).toBe(128);
    expect(p.tmpfsTmpMb).toBe(32);
    expect(p.maxSandboxes).toBe(4); // floor((2 GiB - 1 GiB) / 256 MiB)
    expect([p.maxLspServers, p.maxLspServersPerProject, p.maxDebugSessions]).toEqual([2, 1, 1]);
    expect(p.maxConcurrentRuns).toBe(1);
    expect(p.maxGlobalRuns).toBe(2);
    expect(p.telemetrySampleIntervalMs).toBe(15_000);
    expect(p.lspIdleTimeoutMs).toBe(60_000);
    expect(p.sandboxStopAfterMs).toBe(3 * 60_000);
  });

  it("clamps maxSandboxes to [1, 20] for low", () => {
    expect(resolveHostProfile("low", { totalMemBytes: 512 * MiB, cpuCount: 1 }).maxSandboxes).toBe(1);
    expect(resolveHostProfile("low", { totalMemBytes: 4 * GiB, cpuCount: 2 }).maxSandboxes).toBe(12);
    expect(resolveHostProfile("low", { totalMemBytes: 64 * GiB, cpuCount: 2 }).maxSandboxes).toBe(20);
  });

  it("keeps the historical defaults on standard hosts", () => {
    const p = resolveHostProfile("auto", { totalMemBytes: 16 * GiB, cpuCount: 8 });
    expect(p.name).toBe("standard");
    expect(p.memoryBytes).toBe(512 * MiB);
    expect(p.cpuQuota).toBe(100_000);
    expect(p.pidsLimit).toBe(256);
    expect(p.maxSandboxes).toBe(20);
    expect([p.maxLspServers, p.maxLspServersPerProject, p.maxDebugSessions]).toEqual([8, 2, 4]);
    expect(p.maxConcurrentRuns).toBe(3);
    expect(p.telemetrySampleIntervalMs).toBe(2_000);
    expect(p.sandboxStopAfterMs).toBe(10 * 60_000);
    expect(p.maxGlobalRuns).toBe(8);
  });
});
