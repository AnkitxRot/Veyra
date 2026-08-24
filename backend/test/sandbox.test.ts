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
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { userId: 1 });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15000);
    expect(r.type).toBe("success");
  });

  // uid check only makes sense on Linux with prlimit/setpriv
  it.skipIf(IS_WINDOWS)("does not run user code as root", async () => {
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "import os\nprint(os.getuid())\n");
    const r = await runProject(cfg, `test-${randomUUID()}`, ws, { userId: 1 });
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
      await runProject(cfg, projectId, ws, { userId: 1 });

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
  sandboxGate: import("../src/execution/runGate.js").RunGate;
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
    isDockerRunningAsync: async () => true,
    isRunnerImageAvailableAsync: async () => true,
  }));

  const mod = await import("../src/execution/sandbox.js");
  return {
    manager: new mod.SandboxManager(),
    calls,
    sandboxGate: mod.sandboxGate,
  };
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
    let created = false;
    const { manager } = await loadManagerWithFakeDocker(async (args) => {
      if (args[0] === "run") {
        runCount++;
        // keep the creation sequence open so both callers overlap
        await sleep(50);
        created = true;
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        throw new Error("no such network");
      }
      if (args[0] === "inspect") {
        // Matches a real daemon: once `docker run` has succeeded, the
        // container it created reports as running. Lifecycle operations for
        // the same project are now strictly serialized (see
        // SandboxManager.withProjectLock), so a second concurrent caller's
        // own inspect check must see this fast path, exactly like it would
        // against a real Docker daemon.
        return { stdout: created ? "true\n" : "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const projectId = `conc-${randomUUID()}`;
    const ws = makeWorkspace(cfg);

    const [a, b] = await Promise.all([
      manager.ensureProjectSandbox(projectId, cfg, ws, 1),
      manager.ensureProjectSandbox(projectId, cfg, ws, 1),
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
      manager.ensureProjectSandbox(first, cfg, ws, 1),
      manager.ensureProjectSandbox(second, cfg, ws, 1),
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
      manager.ensureProjectSandbox(projectId, cfg, ws, 1),
    ).rejects.toThrow(/docker run exploded/);

    // The failed attempt above must not have leaked the per-user slot it
    // acquired: this retry uses the same userId and must succeed.
    const id = await manager.ensureProjectSandbox(projectId, cfg, ws, 1);
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

    const creation = manager.ensureProjectSandbox(projectId, cfg, ws, 1);
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

/** A DockerHandler that answers every call generically, for tests that only
 *  care about admission behavior, not the specific docker command sequence. */
const genericDockerHandler: DockerHandler = async (args) => {
  if (args[0] === "run") return { stdout: "deadbeef\n", stderr: "" };
  if (args[0] === "port")
    return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
  if (args[0] === "network" && args[1] === "inspect")
    throw new Error("no such network");
  return { stdout: "", stderr: "" };
};

describe("sandboxGate — per-user live-sandbox quota", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/tools.js");
    vi.resetModules();
  });

  it("blocks a user from exceeding their per-user sandbox quota, independent of the global cap", async () => {
    const { manager, sandboxGate } =
      await loadManagerWithFakeDocker(genericDockerHandler);
    const perUserCfg = makeTestConfig({ maxSandboxesPerUser: 2 });
    const ws = makeWorkspace(cfg);

    await manager.ensureProjectSandbox(
      `u1-a-${randomUUID()}`,
      perUserCfg,
      ws,
      1,
    );
    await manager.ensureProjectSandbox(
      `u1-b-${randomUUID()}`,
      perUserCfg,
      ws,
      1,
    );
    expect(sandboxGate.activeCount(1)).toBe(2);

    await expect(
      manager.ensureProjectSandbox(`u1-c-${randomUUID()}`, perUserCfg, ws, 1),
    ).rejects.toThrow(/per-user sandbox limit reached/);
    // The rejected attempt must not have incremented the count either.
    expect(sandboxGate.activeCount(1)).toBe(2);
  });

  it("tracks different users' sandbox counts separately", async () => {
    const { manager, sandboxGate } =
      await loadManagerWithFakeDocker(genericDockerHandler);
    const perUserCfg = makeTestConfig({ maxSandboxesPerUser: 1 });
    const ws = makeWorkspace(cfg);

    await manager.ensureProjectSandbox(`u1-${randomUUID()}`, perUserCfg, ws, 1);
    // A second user is unaffected by the first user's quota being full.
    await manager.ensureProjectSandbox(`u2-${randomUUID()}`, perUserCfg, ws, 2);

    expect(sandboxGate.activeCount(1)).toBe(1);
    expect(sandboxGate.activeCount(2)).toBe(1);

    await expect(
      manager.ensureProjectSandbox(
        `u1-again-${randomUUID()}`,
        perUserCfg,
        ws,
        1,
      ),
    ).rejects.toThrow(/per-user sandbox limit reached/);
  });

  it("returns the slot to the pool once the sandbox is destroyed", async () => {
    const { manager, sandboxGate } =
      await loadManagerWithFakeDocker(genericDockerHandler);
    const perUserCfg = makeTestConfig({ maxSandboxesPerUser: 1 });
    const ws = makeWorkspace(cfg);
    const projectId = `destroy-${randomUUID()}`;

    await manager.ensureProjectSandbox(projectId, perUserCfg, ws, 1);
    expect(sandboxGate.activeCount(1)).toBe(1);

    await manager.stopProjectSandbox(projectId);
    expect(sandboxGate.activeCount(1)).toBe(0);

    // The freed slot is immediately usable again, by the same user.
    await manager.ensureProjectSandbox(
      `destroy-2-${randomUUID()}`,
      perUserCfg,
      ws,
      1,
    );
    expect(sandboxGate.activeCount(1)).toBe(1);
  });

  it("never leaks the per-user slot when container provisioning fails after it was acquired", async () => {
    let attempt = 0;
    const { manager, sandboxGate } = await loadManagerWithFakeDocker(
      async (args) => {
        if (args[0] === "run") {
          attempt++;
          // Every attempt fails: the per-user slot must be released every
          // single time, not just once, or repeated failures would
          // eventually exhaust the quota for a user who never has a single
          // live sandbox.
          throw new Error(`docker run exploded (attempt ${attempt})`);
        }
        if (args[0] === "network" && args[1] === "inspect") {
          throw new Error("no such network");
        }
        return { stdout: "", stderr: "" };
      },
    );
    const perUserCfg = makeTestConfig({ maxSandboxesPerUser: 1 });
    const ws = makeWorkspace(cfg);

    for (let i = 0; i < 3; i++) {
      await expect(
        manager.ensureProjectSandbox(`fail-${randomUUID()}`, perUserCfg, ws, 1),
      ).rejects.toThrow(/docker run exploded/);
      // If the slot leaked on failure, this would read 1 after the first
      // iteration and every subsequent attempt would fail with "per-user
      // sandbox limit reached" instead of "docker run exploded".
      expect(sandboxGate.activeCount(1)).toBe(0);
    }
    expect(attempt).toBe(3);
  });

  it("still enforces the global maxSandboxes cap even when per-user quota has room", async () => {
    const { manager } = await loadManagerWithFakeDocker(genericDockerHandler);
    const tightGlobalCfg = makeTestConfig({
      maxSandboxes: 1,
      maxSandboxesPerUser: 10,
      sandboxIdleTimeoutMs: 60_000,
    });
    const ws = makeWorkspace(cfg);

    // Different users, so the per-user gate has plenty of room — only the
    // global cap should be the blocker here.
    await manager.ensureProjectSandbox(
      `g1-${randomUUID()}`,
      tightGlobalCfg,
      ws,
      1,
    );
    await expect(
      manager.ensureProjectSandbox(`g2-${randomUUID()}`, tightGlobalCfg, ws, 2),
    ).rejects.toThrow(/sandbox limit reached/);
  });

  it("does not double-count concurrent duplicate creation calls for the same project", async () => {
    const { manager, sandboxGate } = await loadManagerWithFakeDocker(
      async (args) => {
        if (args[0] === "run") {
          await sleep(20);
          return { stdout: "deadbeef\n", stderr: "" };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          throw new Error("no such network");
        }
        if (args[0] === "port")
          return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    );
    const perUserCfg = makeTestConfig({ maxSandboxesPerUser: 1 });
    const ws = makeWorkspace(cfg);
    const projectId = `dup-${randomUUID()}`;

    // Both callers race into the same in-flight creation (see the dedup
    // suite above) — this must count as ONE sandbox against the quota, not
    // two, even though ensureProjectSandbox was called twice.
    await Promise.all([
      manager.ensureProjectSandbox(projectId, perUserCfg, ws, 1),
      manager.ensureProjectSandbox(projectId, perUserCfg, ws, 1),
    ]);

    expect(sandboxGate.activeCount(1)).toBe(1);
  });

  it("never double-releases a slot when stopProjectSandbox races a concurrent ensureProjectSandbox for the same project", async () => {
    // Deterministic barrier: performStop's second docker call (`network
    // rm`) pauses here until the test explicitly lets it through, giving
    // full control over the exact interleaving point — no sleep-based
    // timing guesses.
    let releaseNetworkRm!: () => void;
    const networkRmGate = new Promise<void>((resolve) => {
      releaseNetworkRm = resolve;
    });
    let containerRemoved = false;

    const { manager, sandboxGate } = await loadManagerWithFakeDocker(
      async (args) => {
        if (args[0] === "run") return { stdout: "deadbeef\n", stderr: "" };
        if (args[0] === "port")
          return { stdout: "3000/tcp -> 127.0.0.1:49153\n", stderr: "" };
        if (args[0] === "network" && args[1] === "inspect") {
          throw new Error("no such network");
        }
        if (args[0] === "rm") {
          // stopProjectSandbox's teardown `docker rm -f` for the project
          // under test: mark the container gone, matching a real daemon.
          containerRemoved = true;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "network" && args[1] === "rm") {
          // Pause performStop here — *after* the container has already
          // been removed (containerRemoved=true) but *before*
          // sandboxGate.release() runs. This is exactly the unguarded
          // window the security gate identified.
          await networkRmGate;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "inspect") {
          return { stdout: containerRemoved ? "" : "true\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    );
    const perUserCfg = makeTestConfig({ maxSandboxesPerUser: 5 });
    const ws = makeWorkspace(cfg);
    const ownerId = 1;
    const projectP = `race-p-${randomUUID()}`;
    const projectQ = `race-q-${randomUUID()}`;

    // ownerId holds two independent live sandboxes: P (about to be torn
    // down) and Q (untouched). A double-release of P's slot would corrupt
    // ownerId's count below the true value (1, for Q) rather than leaving
    // it exactly right — that corruption is what this test proves can't
    // happen.
    await manager.ensureProjectSandbox(projectP, perUserCfg, ws, ownerId);
    await manager.ensureProjectSandbox(projectQ, perUserCfg, ws, ownerId);
    expect(sandboxGate.activeCount(ownerId)).toBe(2);

    // Start teardown of P; it will pause at the network-rm barrier above,
    // i.e. mid-flight, after the container is gone but before the gate is
    // released.
    const stopPromise = manager.stopProjectSandbox(projectP);

    // While the stop is paused mid-flight, race a concurrent ensure for the
    // SAME project — without withProjectLock serializing them, this call
    // would independently see the container as gone (containerRemoved is
    // already true) and take the staleOwnerId release path, releasing
    // ownerId's slot a SECOND time before the paused stop releases it once.
    const otherOwnerId = 2;
    const ensurePromise = manager.ensureProjectSandbox(
      projectP,
      perUserCfg,
      ws,
      otherOwnerId,
    );

    // Let the paused teardown proceed only now — after the race window has
    // had a chance to be entered incorrectly, if it were going to be.
    releaseNetworkRm();

    await stopPromise;
    await ensurePromise;

    // Exactly one release for P: ownerId's count reflects only Q.
    expect(sandboxGate.activeCount(ownerId)).toBe(1);
    // The re-creation for the new owner succeeded and was counted once.
    expect(sandboxGate.activeCount(otherOwnerId)).toBe(1);
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
    isDockerRunningAsync: async () => true,
    isRunnerImageAvailableAsync: async () => true,
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
    userId: 1,
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

describe("M5a: sandboxRun's Docker-down check uses the async variant, not blocking execSync", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/tools.js");
    vi.resetModules();
  });

  it("returns the Docker-down error via isDockerRunningAsync without ever calling the blocking sync isDockerRunning", async () => {
    // No isDockerRunning export here: if sandboxRun's top-of-function check
    // still referenced the blocking sync variant, this import would throw
    // "is not a function" instead of silently shelling out synchronously.
    let asyncCalled = false;
    vi.doMock("../src/tools.js", () => ({
      isDockerRunningAsync: async () => {
        asyncCalled = true;
        return false;
      },
    }));

    const { sandboxRun } = await import("../src/execution/sandbox.js");
    const ws = makeWorkspace(cfg);
    const result = await sandboxRun(`docker-down-${randomUUID()}`, ws, {
      command: "python",
      args: ["-c", "print(1)"],
      cwd: ws,
      kind: "run" as const,
      timeoutMs: 5000,
      config: cfg,
      userId: 1,
    });

    expect(asyncCalled).toBe(true);
    expect(result.stderr).toContain("Docker daemon is not running");
    expect(result.exitCode).toBeNull();
  });
});
