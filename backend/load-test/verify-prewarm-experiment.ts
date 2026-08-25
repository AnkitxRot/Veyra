import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { isDockerRunningAsync, isRunnerImageAvailableAsync } from "../src/tools.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

mkdirSync(RESULTS_DIR, { recursive: true });

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(sortedArr.length * p)));
  return sortedArr[idx];
}

interface PrewarmContainer {
  id: string;
  state: "PREPARED" | "ASSIGNED" | "ACTIVE" | "DESTROYED";
  projectId: string | null;
  userId: number | null;
  createdAt: number;
}

class ExperimentalPrewarmPool {
  private poolSize: number;
  private maxSandboxes: number;
  private netName: string;
  private prewarmed: PrewarmContainer[] = [];
  private activeCount = 0;
  private reservedCount = 0;
  private peakGlobalLoad = 0;
  private disposed = false;
  private assignmentLog: Array<{ containerId: string; from: string; to: string; projectId: string; userId: number }> = [];

  constructor(poolSize: number, netName: string, maxSandboxes = 20) {
    this.poolSize = poolSize;
    this.netName = netName;
    this.maxSandboxes = maxSandboxes;
  }

  getCurrentGlobalLoad(): number {
    return this.activeCount + this.reservedCount + this.prewarmed.length;
  }

  getPeakGlobalLoad(): number {
    return this.peakGlobalLoad;
  }

  getAssignmentLog() {
    return this.assignmentLog;
  }

  async initialize() {
    await this.refill();
  }

  private updatePeak() {
    const load = this.getCurrentGlobalLoad();
    if (load > this.peakGlobalLoad) {
      this.peakGlobalLoad = load;
    }
  }

  private async createAnonymousContainer(): Promise<PrewarmContainer | null> {
    if (this.disposed) return null;
    if (this.getCurrentGlobalLoad() >= this.maxSandboxes) return null;

    const slotId = `exp-prewarm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const hardeningArgs = [
      "--read-only",
      "--tmpfs", "/tmp:rw,size=64m,mode=1777",
      "--tmpfs", "/run:rw,size=16m,mode=1777",
      "--tmpfs", "/home/ide/.cache:rw,size=64m,uid=1000,gid=1000,mode=0755",
      "--tmpfs", "/workspace:rw,size=256m,uid=1000,gid=1000,mode=0777",
    ];

    const dockerArgs = [
      "run", "-d",
      "--name", slotId,
      "--network", this.netName,
      "--label", "cloudeeeide.managed=true",
      "--label", "cloudeeeide.prewarmed=true",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--memory", "536870912b",
      "--cpus", "1.0",
      "--pids-limit", "100",
      ...hardeningArgs,
      "-w", "/workspace",
      "--user", "ide",
      "cloudeeeide-runner:latest",
      "sleep", "infinity",
    ];

    try {
      await execFileAsync("docker", dockerArgs);
      const item: PrewarmContainer = {
        id: slotId,
        state: "PREPARED",
        projectId: null,
        userId: null,
        createdAt: Date.now(),
      };
      this.updatePeak();
      return item;
    } catch {
      try {
        await execFileAsync("docker", ["rm", "-f", slotId]);
      } catch {}
      return null;
    }
  }

  async refill() {
    if (this.disposed) return;
    while (this.prewarmed.length < this.poolSize && this.getCurrentGlobalLoad() < this.maxSandboxes) {
      const c = await this.createAnonymousContainer();
      if (c) {
        this.prewarmed.push(c);
      } else {
        break;
      }
    }
    this.updatePeak();
  }

  async acquireForProject(projectId: string, userId: number, workspaceDir: string): Promise<{ containerId: string; wasPrewarmed: boolean }> {
    this.reservedCount++;
    this.updatePeak();

    try {
      // 1. Try prewarmed slot
      const prewarmed = this.prewarmed.shift();
      if (prewarmed) {
        prewarmed.state = "ASSIGNED";
        prewarmed.projectId = projectId;
        prewarmed.userId = userId;
        this.assignmentLog.push({
          containerId: prewarmed.id,
          from: "PREPARED",
          to: "ASSIGNED",
          projectId,
          userId,
        });

        // Sync workspace files into tmpfs workspace
        await this.syncWorkspaceFiles(prewarmed.id, workspaceDir);

        prewarmed.state = "ACTIVE";
        this.activeCount++;
        this.refill().catch(() => {});
        return { containerId: prewarmed.id, wasPrewarmed: true };
      }

      // 2. On-demand fallback cold creation
      const containerId = `exp-cold-${projectId}-${Date.now()}`;

      const hardeningArgs = [
        "--read-only",
        "--tmpfs", "/tmp:rw,size=64m,mode=1777",
        "--tmpfs", "/run:rw,size=16m,mode=1777",
        "--tmpfs", "/home/ide/.cache:rw,size=64m,uid=1000,gid=1000,mode=0755",
      ];

      const dockerArgs = [
        "run", "-d",
        "--name", containerId,
        "--network", this.netName,
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--memory", "536870912b",
        "--cpus", "1.0",
        "--pids-limit", "100",
        ...hardeningArgs,
        "-v", `${workspaceDir}:/workspace`,
        "-w", "/workspace",
        "--user", "ide",
        "cloudeeeide-runner:latest",
        "sleep", "infinity",
      ];

      await execFileAsync("docker", dockerArgs);
      this.activeCount++;
      this.updatePeak();
      return { containerId, wasPrewarmed: false };
    } finally {
      this.reservedCount--;
    }
  }

  private async syncWorkspaceFiles(containerId: string, workspaceDir: string) {
    const files = await fs.readdir(workspaceDir);
    for (const f of files) {
      const content = await fs.readFile(join(workspaceDir, f), "utf8");
      await execFileAsync("docker", [
        "exec", "-i", "-u", "ide", containerId,
        "sh", "-c", `cat << 'EOF' > /workspace/${f}\n${content}\nEOF`
      ]);
    }
  }

  async releaseContainer(containerId: string) {
    this.activeCount = Math.max(0, this.activeCount - 1);
    try {
      await execFileAsync("docker", ["rm", "-f", containerId]);
    } catch {}
    this.refill().catch(() => {});
  }

  async cleanupAll() {
    this.disposed = true;
    for (const c of this.prewarmed) {
      try {
        await execFileAsync("docker", ["rm", "-f", c.id]);
      } catch {}
    }
    this.prewarmed = [];
  }
}

async function run50VUBurstTest(poolSize: number, netName: string): Promise<{
  poolSize: number;
  burstP50: number;
  burstP95: number;
  burstP99: number;
  totalWallMs: number;
  prewarmedHitCount: number;
  coldCreationCount: number;
  peakGlobalLoad: number;
  warmExecP50: number;
  warmExecP95: number;
  isolationViolations: number;
  leftoverContainers: number;
}> {
  console.log(`\n--- Running 50-VU Burst Experiment for Pool Size P${poolSize} ---`);
  const pool = new ExperimentalPrewarmPool(poolSize, netName, 20);
  await pool.initialize();

  const baseDir = mkdtempSync(join(tmpdir(), `exp-prewarm-p${poolSize}-`));
  const projects: Array<{ id: string; userId: number; dir: string }> = [];

  for (let i = 0; i < 50; i++) {
    const pId = `p${poolSize}_${i}`;
    const dir = join(baseDir, pId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.py"), `print("BURST_RESULT_${i}")\n`);
    projects.push({ id: pId, userId: i + 1, dir });
  }

  let prewarmedHits = 0;
  let coldCreations = 0;

  const tStart = performance.now();
  const burstPromises = projects.map(async (p) => {
    const reqStart = performance.now();
    const sandbox = await pool.acquireForProject(p.id, p.userId, p.dir);
    if (sandbox.wasPrewarmed) prewarmedHits++;
    else coldCreations++;

    const { stdout } = await execFileAsync("docker", [
      "exec", "-i", "-w", "/workspace", sandbox.containerId, "python3", "main.py"
    ]);

    const elapsed = performance.now() - reqStart;

    await pool.releaseContainer(sandbox.containerId);

    return { elapsed, success: stdout.includes(`BURST_RESULT_`) };
  });

  const results = await Promise.all(burstPromises);
  const totalWallMs = performance.now() - tStart;

  const latencies = results.map((r) => r.elapsed).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);

  // Measure warm execution on a reused container
  const warmContainer = `test-warm-p${poolSize}-${Date.now()}`;
  await execFileAsync("docker", ["run", "-d", "--name", warmContainer, "--network", netName, "-v", `${baseDir}:/workspace`, "-w", "/workspace", "cloudeeeide-runner:latest", "sleep", "infinity"]);

  const warmLatencies: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await execFileAsync("docker", ["exec", "-i", "-w", "/workspace", warmContainer, "python3", "-c", "print('warm')"]);
    warmLatencies.push(performance.now() - t0);
  }
  warmLatencies.sort((a, b) => a - b);

  await execFileAsync("docker", ["rm", "-f", warmContainer]);

  await pool.cleanupAll();
  rmSync(baseDir, { recursive: true, force: true });

  const log = pool.getAssignmentLog();
  const seenContainers = new Set<string>();
  let isolationViolations = 0;
  for (const entry of log) {
    if (seenContainers.has(entry.containerId)) {
      isolationViolations++;
    }
    seenContainers.add(entry.containerId);
  }

  const { stdout: psOut } = await execFileAsync("docker", ["ps", "-a", "--filter", "name=exp-", "--format", "{{.ID}}"]);
  const leftoverContainers = psOut.trim() ? psOut.trim().split("\n").length : 0;

  console.log(`[P${poolSize}] Results: p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, p99=${p99.toFixed(1)}ms, Wall=${(totalWallMs / 1000).toFixed(2)}s`);
  console.log(`[P${poolSize}] Prewarmed hits: ${prewarmedHits}, Cold creations: ${coldCreations}, Peak global load: ${pool.getPeakGlobalLoad()}/20`);

  return {
    poolSize,
    burstP50: p50,
    burstP95: p95,
    burstP99: p99,
    totalWallMs,
    prewarmedHitCount: prewarmedHits,
    coldCreationCount: coldCreations,
    peakGlobalLoad: pool.getPeakGlobalLoad(),
    warmExecP50: percentile(warmLatencies, 0.5),
    warmExecP95: percentile(warmLatencies, 0.95),
    isolationViolations,
    leftoverContainers,
  };
}

async function runExperiment() {
  console.log("=================================================");
  console.log("M15 Bounded Cold-Sandbox Prewarming Experiment");
  console.log("=================================================");

  if (!(await isDockerRunningAsync())) {
    throw new Error("Docker daemon is not running");
  }
  if (!(await isRunnerImageAvailableAsync())) {
    throw new Error("cloudeeeide-runner:latest is not available");
  }

  const sharedNet = `exp-prewarm-shared-net`;
  try {
    await execFileAsync("docker", ["network", "create", "--subnet=172.28.0.0/16", sharedNet]);
  } catch {}

  try {
    // 1. Run P0 (Baseline, 0 prewarm slots)
    const resP0 = await run50VUBurstTest(0, sharedNet);

    // 2. Run P1 (1 prewarm slot)
    const resP1 = await run50VUBurstTest(1, sharedNet);

    // 3. Run P2 (2 prewarm slots)
    const resP2 = await run50VUBurstTest(2, sharedNet);

    // 4. Run P4 (4 prewarm slots)
    const resP4 = await run50VUBurstTest(4, sharedNet);

    // 5. Repeat best performing variant to confirm reproducibility
    const allVariants = [resP0, resP1, resP2, resP4];
    const bestVariant = allVariants.reduce((best, curr) => (curr.burstP95 < best.burstP95 ? curr : best), resP0);
    console.log(`\nBest variant identified: P${bestVariant.poolSize}. Running repeat validation...`);

    const repeatRes = await run50VUBurstTest(bestVariant.poolSize, sharedNet);

    const report = {
      timestamp: new Date().toISOString(),
      variants: {
        P0: resP0,
        P1: resP1,
        P2: resP2,
        P4: resP4,
      },
      bestVariant: `P${bestVariant.poolSize}`,
      repeatedValidation: repeatRes,
    };

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = join(RESULTS_DIR, `m15-prewarm-experiment-${ts}.json`);
    const mdPath = join(RESULTS_DIR, `m15-prewarm-experiment-${ts}.md`);

    writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = `# M15 Bounded Cold-Sandbox Prewarming Experiment Report

- Timestamp: ${report.timestamp}

## 50-VU Cold Execution Burst Comparison

| Variant | Prewarm Pool Size | Prewarmed Hits | Cold Creations | Burst p50 (ms) | Burst p95 (ms) | Burst p99 (ms) | Wall Clock (s) | Peak Load (/20) | Isolation Violations | Leftovers |
|---|---|---|---|---|---|---|---|---|---|---|
| **P0 (Baseline)** | 0 | 0 | 50 | ${resP0.burstP50.toFixed(1)} ms | ${resP0.burstP95.toFixed(1)} ms | ${resP0.burstP99.toFixed(1)} ms | ${(resP0.totalWallMs / 1000).toFixed(2)} s | ${resP0.peakGlobalLoad}/20 | ${resP0.isolationViolations} | ${resP0.leftoverContainers} |
| **P1** | 1 | ${resP1.prewarmedHitCount} | ${resP1.coldCreationCount} | ${resP1.burstP50.toFixed(1)} ms | ${resP1.burstP95.toFixed(1)} ms | ${resP1.burstP99.toFixed(1)} ms | ${(resP1.totalWallMs / 1000).toFixed(2)} s | ${resP1.peakGlobalLoad}/20 | ${resP1.isolationViolations} | ${resP1.leftoverContainers} |
| **P2** | 2 | ${resP2.prewarmedHitCount} | ${resP2.coldCreationCount} | ${resP2.burstP50.toFixed(1)} ms | ${resP2.burstP95.toFixed(1)} ms | ${resP2.burstP99.toFixed(1)} ms | ${(resP2.totalWallMs / 1000).toFixed(2)} s | ${resP2.peakGlobalLoad}/20 | ${resP2.isolationViolations} | ${resP2.leftoverContainers} |
| **P4** | 4 | ${resP4.prewarmedHitCount} | ${resP4.coldCreationCount} | ${resP4.burstP50.toFixed(1)} ms | ${resP4.burstP95.toFixed(1)} ms | ${resP4.burstP99.toFixed(1)} ms | ${(resP4.totalWallMs / 1000).toFixed(2)} s | ${resP4.peakGlobalLoad}/20 | ${resP4.isolationViolations} | ${resP4.leftoverContainers} |

## Repeated Validation of Best Variant (P${bestVariant.poolSize})

| Metric | First Run | Repeated Run | Difference |
|---|---|---|---|
| Burst p50 | ${bestVariant.burstP50.toFixed(1)} ms | ${repeatRes.burstP50.toFixed(1)} ms | ${(repeatRes.burstP50 - bestVariant.burstP50).toFixed(1)} ms |
| Burst p95 | ${bestVariant.burstP95.toFixed(1)} ms | ${repeatRes.burstP95.toFixed(1)} ms | ${(repeatRes.burstP95 - bestVariant.burstP95).toFixed(1)} ms |
| Burst p99 | ${bestVariant.burstP99.toFixed(1)} ms | ${repeatRes.burstP99.toFixed(1)} ms | ${(repeatRes.burstP99 - bestVariant.burstP99).toFixed(1)} ms |
| Total Wall Clock | ${(bestVariant.totalWallMs / 1000).toFixed(2)} s | ${(repeatRes.totalWallMs / 1000).toFixed(2)} s | ${((repeatRes.totalWallMs - bestVariant.totalWallMs) / 1000).toFixed(2)} s |

## Warm Execution Parity

- **Warm Exec p50 / p95**: ${resP0.warmExecP50.toFixed(1)} ms / ${resP0.warmExecP95.toFixed(1)} ms (P0) vs ${bestVariant.warmExecP50.toFixed(1)} ms / ${bestVariant.warmExecP95.toFixed(1)} ms (P${bestVariant.poolSize})
`;

    writeFileSync(mdPath, md);
    console.log(`\n[M15] Wrote ${jsonPath} and ${mdPath}`);
  } finally {
    try {
      await execFileAsync("docker", ["network", "rm", sharedNet]);
    } catch {}
  }
}

runExperiment().catch((err) => {
  console.error("Experiment failed:", err);
  process.exit(1);
});
