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
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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

  // Resource limits are applied per-container via `docker run --memory
  // --cpus --pids-limit` (cgroup v2 delegated to Docker itself) — there is
  // no manually-managed cgroup directory tree to inspect. The real cleanup
  // contract is that the project's persistent sandbox container is removed
  // once cleanupAllSandboxes() runs.
  it.skipIf(IS_WINDOWS)(
    "removes the sandbox container once cleanupAllSandboxes() runs",
    async () => {
      const projectId = `test-${randomUUID()}`;
      const ws = makeWorkspace(cfg);
      writeFileSync(join(ws, "main.py"), 'print("cleanup check")\n');
      await runProject(cfg, projectId, ws, {});

      const containerName = `ide-sandbox-${projectId}`;
      const nameFilter = `name=^/${containerName}$`;
      const before = execFileSync(
        "docker",
        ["ps", "-a", "-q", "-f", nameFilter],
        { encoding: "utf8" },
      ).trim();
      expect(before.length).toBeGreaterThan(0);

      await sandboxManager.cleanupAllSandboxes();

      const after = execFileSync(
        "docker",
        ["ps", "-a", "-q", "-f", nameFilter],
        { encoding: "utf8" },
      ).trim();
      expect(after).toBe("");
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

  it("stopProjectSandbox waits for an in-flight creation, so the container is not resurrected afterward", async () => {
    const order: string[] = [];
    const { manager } = await loadManagerWithFakeDocker(async (args) => {
      if (args[0] === "run") {
        order.push("run:start");
        await sleep(50);
        order.push("run:end");
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args[0] === "rm") {
        order.push("rm");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        throw new Error("no such network");
      }
      if (args[0] === "network" && args[1] === "rm") {
        order.push("network:rm");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const projectId = `stop-race-${randomUUID()}`;
    const ws = makeWorkspace(cfg);

    const creation = manager.ensureProjectSandbox(projectId, cfg, ws);
    // Let creation actually enter `docker run` before racing the stop.
    await sleep(10);

    await Promise.all([creation, manager.stopProjectSandbox(projectId)]);

    // The stop must have been ordered after creation settled, not raced
    // ahead of it: otherwise creation completing afterward would silently
    // re-add the entry the caller just tore down. Creation itself issues a
    // pre-emptive `rm` before `run`, so look at the LAST `rm` — that's the
    // one from stopProjectSandbox's own teardown.
    expect(order.indexOf("run:end")).toBeLessThan(order.lastIndexOf("rm"));

    const active = await manager.getAllActiveSandboxes();
    expect(active.find((s) => s.projectId === projectId)).toBeUndefined();
  });
});

/**
 * Loads a fresh `sandboxRun` with both `docker` CLI boundaries stubbed:
 * `execFile` (used by ensureProjectSandbox) resolves instantly, and `spawn`
 * (the real `docker exec` process) is recorded instead of launched.
 */
async function loadSandboxRunWithFakeDocker(): Promise<{
  sandboxRun: typeof import("../src/execution/sandbox.js").sandboxRun;
  spawnCalls: DockerCall[];
}> {
  const spawnCalls: DockerCall[] = [];
  const { promisify } = await import("node:util");

  const handler: DockerHandler = async (args) => {
    if (args[0] === "run") return { stdout: "deadbeef\n", stderr: "" };
    if (args[0] === "port")
      return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect")
      throw new Error("no such network");
    return { stdout: "", stderr: "" };
  };

  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const execFile: any = (_file: string, args: string[], cb: any) => {
      handler(args).then(
        (res) => cb(null, res.stdout, res.stderr),
        (err) => cb(err),
      );
    };
    execFile[promisify.custom] = (_file: string, args: string[]) =>
      handler(args);
    const spawn: any = (file: string, args: string[]) => {
      spawnCalls.push({ file, args });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => true, end: () => {} };
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("ran\n"));
        child.emit("close", 0, null);
      });
      return child;
    };
    return { ...actual, execFile, spawn };
  });
  vi.doMock("../src/tools.js", () => ({
    isDockerRunning: () => true,
    isRunnerImageAvailable: () => true,
  }));

  const mod = await import("../src/execution/sandbox.js");
  return { sandboxRun: mod.sandboxRun, spawnCalls };
}

describe("sandboxRun cancellation before spawn", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/tools.js");
    vi.resetModules();
  });

  const baseOpts = (ws: string) => ({
    command: "python",
    args: ["-c", "print(1)"],
    cwd: ws,
    kind: "run" as const,
    timeoutMs: 5000,
    config: cfg,
  });

  it("does not spawn the process when the client disconnected during container startup", async () => {
    // `onController` is only handed out after the process exists, so a WS
    // close during ensureProjectSandbox has nothing to kill: without this
    // guard the run proceeds to completion for a client that is already gone.
    const { sandboxRun, spawnCalls } = await loadSandboxRunWithFakeDocker();
    const ws = makeWorkspace(cfg);

    const res = await sandboxRun(`cancel-${randomUUID()}`, ws, {
      ...baseOpts(ws),
      isCancelled: () => true,
    });

    expect(spawnCalls).toHaveLength(0);
    expect(res.exitCode).toBeNull();
    expect(res.signal).toBeNull();
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("execution cancelled");
  });

  it("still spawns the process when the client is connected", async () => {
    const { sandboxRun, spawnCalls } = await loadSandboxRunWithFakeDocker();
    const ws = makeWorkspace(cfg);

    const connected = await sandboxRun(`live-${randomUUID()}`, ws, {
      ...baseOpts(ws),
      isCancelled: () => false,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(connected.exitCode).toBe(0);
    expect(connected.stdout).toBe("ran\n");

    // omitting isCancelled entirely must behave identically
    const legacy = await sandboxRun(`legacy-${randomUUID()}`, ws, baseOpts(ws));
    expect(spawnCalls).toHaveLength(2);
    expect(legacy.exitCode).toBe(0);
  });
});
