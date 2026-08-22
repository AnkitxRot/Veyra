import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runProject } from "../src/execution/pipeline.js";
import { DEFAULT_LIMITS, IS_WINDOWS } from "../src/config.js";
import { isDockerRunning } from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { makeTestConfig, makeWorkspace } from "./helpers.js";

const cfg = makeTestConfig();

describe.skipIf(!isDockerRunning())("sandbox", () => {
  afterAll(async () => {
    await sandboxManager.cleanupAllSandboxes();
  });

  it("terminates an infinite loop via the wall-clock timeout", async () => {
    const cfg = makeTestConfig({
      runTimeoutMs: 3000,
      limits: { ...DEFAULT_LIMITS, cpuSeconds: 120 },
    });
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "while True:\n    pass\n");
    const start = Date.now();
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15000);
    expect(r.type).toBe("success");
  });

  // uid check only makes sense on Linux with prlimit/setpriv
  it.skipIf(IS_WINDOWS)("does not run user code as root", async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "import os\nprint(os.getuid())\n");
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, {});
    expect(r.type).toBe("success");
    const uid = Number(r.stdout.trim());
    expect(uid).not.toBe(0);
    expect(uid).toBe(cfg.runUser.uid);
  });

  // cgroup cleanup only on Linux
  it.skipIf(IS_WINDOWS)(
    "cleans up cgroup directories after a run",
    async () => {
      const { readdirSync } = await import("node:fs");
      const cfg = makeTestConfig({
        cgroupRoot: "/sys/fs/cgroup/cloudide-test-cleanup",
      });
      const ws = makeWorkspace(cfg);
      writeFileSync(join(ws, "main.py"), 'print("cleanup check")\n');
      await runProject(cfg, `test-${randomUUID()}`, ws, {});
      const uuid = /^[0-9a-f-]{36}$/;
      const leftoverRunDirs = readdirSync(cfg.cgroupRoot).filter((d) =>
        uuid.test(d),
      );
      expect(leftoverRunDirs).toHaveLength(0);
    },
  );
});

type DockerCall = { file: string; args: string[] };
type DockerHandler = (
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Loads a fresh SandboxManager with the `docker` CLI boundary stubbed out, so
 * container-creation concurrency can be asserted without a Docker daemon.
 */
async function loadManagerWithFakeDocker(handler: DockerHandler): Promise<{
  manager: import("../src/execution/sandbox.js").SandboxManager;
  calls: DockerCall[];
}> {
  const calls: DockerCall[] = [];
  const { promisify } = await import("node:util");

  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const execFile: any = (file: string, args: string[], cb: any) => {
      calls.push({ file, args });
      handler(args).then(
        (res) => cb(null, res.stdout, res.stderr),
        (err) => cb(err),
      );
    };
    execFile[promisify.custom] = (file: string, args: string[]) => {
      calls.push({ file, args });
      return handler(args);
    };
    return { ...actual, execFile };
  });
  vi.doMock("../src/tools.js", () => ({
    isDockerRunning: () => true,
    isRunnerImageAvailable: () => true,
  }));

  const mod = await import("../src/execution/sandbox.js");
  return { manager: new mod.SandboxManager(), calls };
}

describe("ensureProjectSandbox in-flight deduplication", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/tools.js");
    vi.resetModules();
  });

  it("runs a single creation sequence for concurrent same-project calls", async () => {
    let runCount = 0;
    const { manager } = await loadManagerWithFakeDocker(async (args) => {
      if (args[0] === "run") {
        runCount++;
        // keep the creation sequence open so both callers overlap
        await sleep(50);
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        throw new Error("no such network");
      }
      return { stdout: "", stderr: "" };
    });

    const projectId = `conc-${randomUUID()}`;
    const ws = makeWorkspace(cfg);

    const [a, b] = await Promise.all([
      manager.ensureProjectSandbox(projectId, cfg, ws),
      manager.ensureProjectSandbox(projectId, cfg, ws),
    ]);

    expect(runCount).toBe(1);
    expect(a).toBe(`ide-sandbox-${projectId}`);
    expect(b).toBe(a);
  });

  it("does not serialize creation across different projects", async () => {
    const started: string[] = [];
    let release: (() => void) | null = null;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { manager } = await loadManagerWithFakeDocker(async (args) => {
      if (args[0] === "run") {
        const nameIdx = args.indexOf("--name");
        started.push(args[nameIdx + 1]);
        if (started.length === 2) release?.();
        // resolves only once both projects are mid-creation: a shared lock
        // would deadlock here instead of completing
        await bothStarted;
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        throw new Error("no such network");
      }
      return { stdout: "", stderr: "" };
    });

    const ws = makeWorkspace(cfg);
    const first = `alpha-${randomUUID()}`;
    const second = `beta-${randomUUID()}`;

    const ids = await Promise.all([
      manager.ensureProjectSandbox(first, cfg, ws),
      manager.ensureProjectSandbox(second, cfg, ws),
    ]);

    expect(ids).toEqual([`ide-sandbox-${first}`, `ide-sandbox-${second}`]);
    expect(started).toHaveLength(2);
  });

  it("clears the in-flight entry after a failure so the next call can retry", async () => {
    let attempts = 0;
    const { manager } = await loadManagerWithFakeDocker(async (args) => {
      if (args[0] === "run") {
        attempts++;
        if (attempts === 1) throw new Error("docker run exploded");
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        throw new Error("no such network");
      }
      return { stdout: "", stderr: "" };
    });

    const projectId = `retry-${randomUUID()}`;
    const ws = makeWorkspace(cfg);

    await expect(
      manager.ensureProjectSandbox(projectId, cfg, ws),
    ).rejects.toThrow(/docker run exploded/);

    const id = await manager.ensureProjectSandbox(projectId, cfg, ws);
    expect(id).toBe(`ide-sandbox-${projectId}`);
    expect(attempts).toBe(2);
  });
});
