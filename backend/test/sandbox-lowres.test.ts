import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestConfig, makeWorkspace } from "./helpers.js";

// M111: two-tier idle, resume and admission. Docker is stubbed at the
// child_process boundary, so these run without a daemon.

type DockerHandler = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function loadManager(handler: DockerHandler) {
  const calls: string[][] = [];
  const { promisify } = await import("node:util");
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const execFile: any = (_f: string, args: string[], cb: any) => {
      calls.push(args);
      handler(args).then(
        (r) => cb(null, r.stdout, r.stderr),
        (e) => cb(e),
      );
    };
    execFile[promisify.custom] = (_f: string, args: string[]) => {
      calls.push(args);
      return handler(args);
    };
    return { ...actual, execFile };
  });
  vi.doMock("../src/tools.js", () => ({
    isDockerRunning: () => true,
    isDockerRunningAsync: async () => true,
    isRunnerImageAvailableAsync: async () => true,
  }));
  const mod = await import("../src/execution/sandbox.js");
  return { manager: new mod.SandboxManager(), calls, sandboxGate: mod.sandboxGate };
}

const generic =
  (opts: { failStart?: boolean } = {}): DockerHandler =>
  async (args) => {
    if (args[0] === "start" && opts.failStart) throw new Error("start failed");
    if (args[0] === "run") return { stdout: "deadbeef\n", stderr: "" };
    if (args[0] === "port") return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") throw new Error("no such network");
    return { stdout: "", stderr: "" };
  };

const MIN = 60_000;
const cfg = makeTestConfig();

describe("M111 two-tier idle, resume and admission", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/tools.js");
    vi.useRealTimers();
    vi.resetModules();
  });

  it("stops an idle sandbox (container kept), then resumes it with docker start", async () => {
    const { manager, calls, sandboxGate } = await loadManager(generic());
    const projectId = `soft-${randomUUID()}`;
    const ws = makeWorkspace(cfg);
    const id = await manager.ensureProjectSandbox(projectId, cfg, ws, 7);
    expect(sandboxGate.activeCount(7)).toBe(1);

    const reaped = await manager.reapIdleSandboxes(30 * MIN, Infinity, Date.now() + 5 * MIN, 3 * MIN);
    expect(reaped).toEqual([]); // stopped, not removed
    expect(calls.some((c) => c[0] === "stop" && c.includes(id))).toBe(true);
    expect(sandboxGate.activeCount(7)).toBe(0);
    expect(manager.getActiveSandboxCount()).toBe(0);
    expect(manager.getStoppedSandboxCount()).toBe(1);

    const runs = calls.filter((c) => c[0] === "run").length;
    const rms = calls.filter((c) => c[0] === "rm").length;
    expect(await manager.ensureProjectSandbox(projectId, cfg, ws, 7)).toBe(id);
    expect(calls.some((c) => c[0] === "start" && c.includes(id))).toBe(true);
    expect(calls.filter((c) => c[0] === "run").length).toBe(runs); // no recreate
    expect(calls.filter((c) => c[0] === "rm").length).toBe(rms);
    expect(sandboxGate.activeCount(7)).toBe(1);
    expect(manager.getActiveSandboxCount()).toBe(1);
  });

  it("removes a stopped sandbox after the full idle timeout", async () => {
    const { manager } = await loadManager(generic());
    const projectId = `tier2-${randomUUID()}`;
    await manager.ensureProjectSandbox(projectId, cfg, makeWorkspace(cfg), 1);
    await manager.reapIdleSandboxes(30 * MIN, Infinity, Date.now() + 4 * MIN, 3 * MIN);
    expect(manager.getStoppedSandboxCount()).toBe(1);
    const reaped = await manager.reapIdleSandboxes(30 * MIN, Infinity, Date.now() + 31 * MIN, 3 * MIN);
    expect(reaped).toEqual([projectId]);
    expect(manager.getStoppedSandboxCount()).toBe(0);
  });

  it("falls back to recreate when docker start fails, without leaking the quota slot", async () => {
    const { manager, calls, sandboxGate } = await loadManager(generic({ failStart: true }));
    const projectId = `fallback-${randomUUID()}`;
    const ws = makeWorkspace(cfg);
    await manager.ensureProjectSandbox(projectId, cfg, ws, 3);
    await manager.reapIdleSandboxes(30 * MIN, Infinity, Date.now() + 4 * MIN, 3 * MIN);
    const runs = calls.filter((c) => c[0] === "run").length;
    await manager.ensureProjectSandbox(projectId, cfg, ws, 3);
    expect(calls.filter((c) => c[0] === "run").length).toBe(runs + 1);
    expect(sandboxGate.activeCount(3)).toBe(1);
  });

  it("counts only running sandboxes against maxSandboxes and the per-user cap", async () => {
    const { manager, sandboxGate } = await loadManager(generic());
    const tight = makeTestConfig({ maxSandboxes: 1, maxSandboxesPerUser: 1 });
    const ws = makeWorkspace(cfg);
    const a = `cap-a-${randomUUID()}`;
    await manager.ensureProjectSandbox(a, tight, ws, 1);
    await manager.reapIdleSandboxes(30 * MIN, Infinity, Date.now() + 4 * MIN, 3 * MIN);
    expect(sandboxGate.activeCount(1)).toBe(0);
    // `a` is stopped, so a second project fits under both caps.
    await manager.ensureProjectSandbox(`cap-b-${randomUUID()}`, tight, ws, 1);
    // Resuming `a` would now exceed the cap: 503, and the entry stays stopped.
    await expect(manager.ensureProjectSandbox(a, tight, ws, 1)).rejects.toMatchObject({
      status: 503,
      code: "server_busy",
    });
    expect(manager.getStoppedSandboxCount()).toBe(1);
    expect(sandboxGate.activeCount(1)).toBe(1);
  });

  it("refuses with 503 server_busy when host RAM is short and nothing is evictable", async () => {
    const { manager } = await loadManager(generic());
    const low = makeTestConfig({ hostMemReserveBytes: 256 * 1024 * 1024 });
    manager.setFreeMemProvider(() => 100 * 1024 * 1024);
    await expect(
      manager.ensureProjectSandbox(`mem-${randomUUID()}`, low, makeWorkspace(cfg), 1),
    ).rejects.toMatchObject({ status: 503, code: "server_busy", retryAfterSeconds: 10 });
  });

  it("does not soft-stop a sandbox with a run in flight", async () => {
    const { manager, calls } = await loadManager(generic());
    const projectId = `busy-${randomUUID()}`;
    await manager.ensureProjectSandbox(projectId, cfg, makeWorkspace(cfg), 1);
    manager.beginExec(projectId);
    await manager.reapIdleSandboxes(30 * MIN, Infinity, Date.now() + 5 * MIN, 3 * MIN);
    expect(calls.some((c) => c[0] === "stop")).toBe(false);
    expect(manager.getActiveSandboxCount()).toBe(1);
    manager.endExec(projectId);
  });

  it("admits only one concurrent creation when free RAM fits just one", async () => {
    const { manager } = await loadManager(generic());
    const low = makeTestConfig({ hostMemReserveBytes: 256 * 1024 * 1024 });
    const need = low.limits.memoryBytes + low.hostMemReserveBytes;
    manager.setFreeMemProvider(() => need);
    const ws = makeWorkspace(cfg);
    const results = await Promise.allSettled([
      manager.ensureProjectSandbox(`race-a-${randomUUID()}`, low, ws, 1),
      manager.ensureProjectSandbox(`race-b-${randomUUID()}`, low, ws, 2),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
  });

  it("stops the LRU idle sandbox to make room when host RAM is short", async () => {
    const { manager, calls } = await loadManager(generic());
    const ws = makeWorkspace(cfg);
    await manager.ensureProjectSandbox(`lru-old-${randomUUID()}`, cfg, ws, 1);
    // Age it past the eviction idle floor.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MIN);
    // Free memory recovers once `docker stop` has been issued.
    manager.setFreeMemProvider(() =>
      calls.some((c) => c[0] === "stop") ? 4 * 1024 ** 3 : 100 * 1024 * 1024,
    );
    const low = makeTestConfig({ hostMemReserveBytes: 256 * 1024 * 1024 });
    await manager.ensureProjectSandbox(`lru-new-${randomUUID()}`, low, ws, 2);
    expect(calls.some((c) => c[0] === "stop")).toBe(true);
    expect(manager.getStoppedSandboxCount()).toBe(1);
    expect(manager.getActiveSandboxCount()).toBe(1);
  });
});
