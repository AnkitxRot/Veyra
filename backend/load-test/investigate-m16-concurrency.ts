import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
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

interface PhaseTimings {
  daemonCheckMs: number;
  imageCheckMs: number;
  networkCreateMs: number;
  dockerRunMs: number;
  portLookupMs: number;
  execStartupMs: number;
  totalMs: number;
}

async function measureColdStartPhases(projectId: string, workspaceDir: string): Promise<PhaseTimings> {
  const containerId = `m16-phase-${projectId}-${Date.now()}`;
  const netName = `m16-net-${projectId}-${Date.now()}`;

  const t0 = performance.now();
  await isDockerRunningAsync();
  const t1 = performance.now();

  await isRunnerImageAvailableAsync();
  const t2 = performance.now();

  await execFileAsync("docker", ["network", "create", netName]);
  const t3 = performance.now();

  const hardeningArgs = [
    "--read-only",
    "--tmpfs", "/tmp:rw,size=64m,mode=1777",
    "--tmpfs", "/run:rw,size=16m,mode=1777",
    "--tmpfs", "/home/ide/.cache:rw,size=64m,uid=1000,gid=1000,mode=0755",
  ];
  const portArgs = [3000, 4173, 5173, 8000, 8080].flatMap((p) => ["-p", `127.0.0.1::${p}`]);

  const dockerArgs = [
    "run", "-d",
    "--name", containerId,
    "--network", netName,
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--memory", "536870912b",
    "--cpus", "1.0",
    "--pids-limit", "100",
    ...hardeningArgs,
    ...portArgs,
    "-v", `${workspaceDir}:/workspace`,
    "-w", "/workspace",
    "--user", "ide",
    "cloudeeeide-runner:latest",
    "sleep", "infinity",
  ];

  await execFileAsync("docker", dockerArgs);
  const t4 = performance.now();

  await execFileAsync("docker", ["port", containerId]);
  const t5 = performance.now();

  await execFileAsync("docker", ["exec", "-i", "-w", "/workspace", containerId, "python3", "-c", "print('hello')"]);
  const t6 = performance.now();

  await execFileAsync("docker", ["rm", "-f", containerId]);
  await execFileAsync("docker", ["network", "rm", netName]);

  return {
    daemonCheckMs: t1 - t0,
    imageCheckMs: t2 - t1,
    networkCreateMs: t3 - t2,
    dockerRunMs: t4 - t3,
    portLookupMs: t5 - t4,
    execStartupMs: t6 - t5,
    totalMs: t6 - t0,
  };
}

async function measureConcurrency(concurrency: number): Promise<{
  concurrency: number;
  p50: number;
  p95: number;
  p99: number;
  wallMs: number;
  avgDockerRunMs: number;
  avgPortLookupMs: number;
  avgNetCreateMs: number;
}> {
  const tempBase = mkdtempSync(join(tmpdir(), `m16-c${concurrency}-`));
  const projects: Array<{ id: string; dir: string }> = [];

  for (let i = 0; i < concurrency; i++) {
    const id = `c${concurrency}_${i}_${Date.now()}`;
    const dir = join(tempBase, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.py"), "print('ok')\n");
    projects.push({ id, dir });
  }

  const startWall = performance.now();
  const promises = projects.map(async (p) => {
    const timings = await measureColdStartPhases(p.id, p.dir);
    return timings;
  });

  const results = await Promise.all(promises);
  const wallMs = performance.now() - startWall;

  rmSync(tempBase, { recursive: true, force: true });

  const latencies = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const avgDockerRunMs = results.reduce((acc, r) => acc + r.dockerRunMs, 0) / results.length;
  const avgPortLookupMs = results.reduce((acc, r) => acc + r.portLookupMs, 0) / results.length;
  const avgNetCreateMs = results.reduce((acc, r) => acc + r.networkCreateMs, 0) / results.length;

  return {
    concurrency,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    wallMs,
    avgDockerRunMs,
    avgPortLookupMs,
    avgNetCreateMs,
  };
}

async function run() {
  console.log("==========================================");
  console.log("Milestone 16 — Cold Provisioning Concurrency Investigation");
  console.log("==========================================");

  // 1. Single cold start phase breakdown
  const tempDir = mkdtempSync(join(tmpdir(), "m16-single-"));
  writeFileSync(join(tempDir, "main.py"), "print('ok')\n");
  const single = await measureColdStartPhases("single", tempDir);
  rmSync(tempDir, { recursive: true, force: true });

  console.log("\n--- Phase Breakdown (1 Cold Start) ---");
  console.log(`Daemon check:    ${single.daemonCheckMs.toFixed(2)} ms`);
  console.log(`Image check:     ${single.imageCheckMs.toFixed(2)} ms`);
  console.log(`Network create:  ${single.networkCreateMs.toFixed(2)} ms`);
  console.log(`Docker run:      ${single.dockerRunMs.toFixed(2)} ms`);
  console.log(`Port lookup:     ${single.portLookupMs.toFixed(2)} ms`);
  console.log(`Exec startup:    ${single.execStartupMs.toFixed(2)} ms`);
  console.log(`Total:           ${single.totalMs.toFixed(2)} ms`);

  // 2. Concurrency matrix: 1, 5, 10, 20
  console.log("\n--- Measuring Concurrency Scale (1, 5, 10, 20) ---");
  const c1 = await measureConcurrency(1);
  console.log(`[C=1]  p50=${c1.p50.toFixed(1)}ms, p95=${c1.p95.toFixed(1)}ms, wall=${c1.wallMs.toFixed(1)}ms, runAvg=${c1.avgDockerRunMs.toFixed(1)}ms, portAvg=${c1.avgPortLookupMs.toFixed(1)}ms, netAvg=${c1.avgNetCreateMs.toFixed(1)}ms`);

  const c5 = await measureConcurrency(5);
  console.log(`[C=5]  p50=${c5.p50.toFixed(1)}ms, p95=${c5.p95.toFixed(1)}ms, wall=${c5.wallMs.toFixed(1)}ms, runAvg=${c5.avgDockerRunMs.toFixed(1)}ms, portAvg=${c5.avgPortLookupMs.toFixed(1)}ms, netAvg=${c5.avgNetCreateMs.toFixed(1)}ms`);

  const c10 = await measureConcurrency(10);
  console.log(`[C=10] p50=${c10.p50.toFixed(1)}ms, p95=${c10.p95.toFixed(1)}ms, wall=${c10.wallMs.toFixed(1)}ms, runAvg=${c10.avgDockerRunMs.toFixed(1)}ms, portAvg=${c10.avgPortLookupMs.toFixed(1)}ms, netAvg=${c10.avgNetCreateMs.toFixed(1)}ms`);

  const c20 = await measureConcurrency(20);
  console.log(`[C=20] p50=${c20.p50.toFixed(1)}ms, p95=${c20.p95.toFixed(1)}ms, wall=${c20.wallMs.toFixed(1)}ms, runAvg=${c20.avgDockerRunMs.toFixed(1)}ms, portAvg=${c20.avgPortLookupMs.toFixed(1)}ms, netAvg=${c20.avgNetCreateMs.toFixed(1)}ms`);

  const report = {
    single,
    concurrencyMatrix: { c1, c5, c10, c20 },
  };

  const jsonPath = join(RESULTS_DIR, `m16-concurrency-investigation-${Date.now()}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nSaved investigation report: ${jsonPath}`);
}

run().catch((err) => {
  console.error("Investigation failed:", err);
  process.exit(1);
});
