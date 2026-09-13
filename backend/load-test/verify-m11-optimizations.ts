import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { bootstrapLoadTestServer } from "./server.js";
import { tree, listFiles } from "../src/files/service.js";
import { isDockerRunningAsync, isRunnerImageAvailableAsync } from "../src/tools.js";
import { sandboxManager } from "../src/execution/sandbox.js";

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
  dockerCheckMs: number;
  imageInspectMs: number;
  preRmMs: number;
  netSetupMs: number;
  dockerRunMs: number;
  portReadMs: number;
  execStartupMs: number;
  programExecMs: number;
  teardownMs: number;
  totalMs: number;
}

async function measureOptimizedDockerPhases(projectId: string, workspaceDir: string): Promise<PhaseTimings> {
  const containerId = `test-opt-${projectId}`;
  const netName = `test-net-${projectId}`;

  // 1. Docker check (optimized with cache + in-flight coalescing)
  const t0 = performance.now();
  await isDockerRunningAsync();
  const t1 = performance.now();

  // 2. Image inspect (optimized with cache + in-flight coalescing)
  await isRunnerImageAvailableAsync();
  const t2 = performance.now();

  // 3. Pre-rm
  try {
    await execFileAsync("docker", ["rm", "-f", containerId]);
  } catch {}
  const t3 = performance.now();

  // 4. Net setup (optimized: direct create with catch)
  try {
    await execFileAsync("docker", ["network", "create", netName]);
  } catch {}
  const t4 = performance.now();

  // 5. Docker run
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
  const t5 = performance.now();

  // 6. Port read
  await execFileAsync("docker", ["port", containerId]);
  const t6 = performance.now();

  // 7 & 8. Exec startup and program execution
  let firstByteTime = 0;
  const child = spawn("docker", ["exec", "-i", "-w", "/workspace", containerId, "python3", "-c", "import sys; sys.stdout.write('START\\n'); sys.stdout.flush(); import time; time.sleep(0.05); print('DONE')"]);
  const execStart = performance.now();

  await new Promise<void>((resolve) => {
    child.stdout.on("data", () => {
      if (!firstByteTime) firstByteTime = performance.now();
    });
    child.on("close", () => resolve());
  });
  const execEnd = performance.now();

  // 9. Teardown
  const td0 = performance.now();
  try {
    await execFileAsync("docker", ["rm", "-f", containerId]);
    await execFileAsync("docker", ["network", "rm", netName]);
  } catch {}
  const td1 = performance.now();

  return {
    dockerCheckMs: t1 - t0,
    imageInspectMs: t2 - t1,
    preRmMs: t3 - t2,
    netSetupMs: t4 - t3,
    dockerRunMs: t5 - t4,
    portReadMs: t6 - t5,
    execStartupMs: (firstByteTime || execEnd) - execStart,
    programExecMs: execEnd - (firstByteTime || execStart),
    teardownMs: td1 - td0,
    totalMs: td1 - t0,
  };
}

async function runExecutionBenchmarks() {
  console.log("[M11] Running Execution Benchmarks...");
  const tempDir = join(__dirname, "..", "tmp-opt-investigation-" + Date.now());
  mkdirSync(tempDir, { recursive: true });

  try {
    // Single cold start
    const singlePhases = await measureOptimizedDockerPhases(`single-${Date.now()}`, tempDir);

    // Warm execution
    const warmContainer = `test-warm-opt-${Date.now()}`;
    const warmNet = `test-warm-net-opt-${Date.now()}`;
    await execFileAsync("docker", ["network", "create", warmNet]);
    await execFileAsync("docker", ["run", "-d", "--name", warmContainer, "--network", warmNet, "-v", `${tempDir}:/workspace`, "-w", "/workspace", "cloudeeeide-runner:latest", "sleep", "infinity"]);

    const warmLatencies: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await execFileAsync("docker", ["exec", "-i", "-w", "/workspace", warmContainer, "python3", "-c", "print('hello')"]);
      warmLatencies.push(performance.now() - t0);
    }
    warmLatencies.sort((a, b) => a - b);

    // 20 simultaneous cold creations
    const concurrencyResults: Record<number, { p50Ms: number; p95Ms: number; maxMs: number; totalWallMs: number }> = {};
    for (const c of [1, 5, 20]) {
      const wallStart = performance.now();
      const tasks = Array.from({ length: c }, async (_, i) => {
        const p = `c${c}-${i}-${Date.now()}`;
        const start = performance.now();
        const phases = await measureOptimizedDockerPhases(p, tempDir);
        return { elapsed: performance.now() - start, phases };
      });
      const results = await Promise.all(tasks);
      const wallEnd = performance.now();
      const latencies = results.map((r) => r.elapsed).sort((a, b) => a - b);
      concurrencyResults[c] = {
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        maxMs: latencies[latencies.length - 1],
        totalWallMs: wallEnd - wallStart,
      };
    }

    // 50-VU Execution Burst via Server
    console.log("[M11] Firing 50 simultaneous execution requests via Server...");
    const server = await bootstrapLoadTestServer({
      authRateLimit: { max: 100_000, windowMs: 60_000 },
    });

    const users: Array<{ token: string; projectId: string }> = [];
    for (let i = 0; i < 50; i++) {
      const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `burst_u_${i}_${Date.now()}`, password: "load-test-password-1234" }),
      }).then((r) => r.json())) as any;

      const proj = (await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
        body: JSON.stringify({ name: `burst-p-${i}` }),
      }).then((r) => r.json())) as any;

      await fetch(`${server.baseUrl}/api/projects/${proj.project.id}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
        body: JSON.stringify({ path: "main.py", content: "print('burst-test')\n" }),
      });

      users.push({ token: reg.token, projectId: proj.project.id });
    }

    const burstStart = performance.now();
    const burstPromises = users.map(async (u, idx) => {
      const reqStart = performance.now();
      try {
        const res = await fetch(`${server.baseUrl}/api/projects/${u.projectId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${u.token}` },
          body: JSON.stringify({ path: "main.py" }),
        });
        const elapsed = performance.now() - reqStart;
        const text = await res.text();
        return { idx, status: res.status, elapsedMs: elapsed, body: text };
      } catch (err: any) {
        return { idx, status: 0, elapsedMs: performance.now() - reqStart, error: err.message };
      }
    });

    const burstResults = await Promise.all(burstPromises);
    const burstEnd = performance.now();
    await server.close();

    const success = burstResults.filter((r) => r.status === 200);
    const latencies = burstResults.map((r) => r.elapsedMs).sort((a, b) => a - b);

    const report = {
      timestamp: new Date().toISOString(),
      singlePhases,
      warmExecution: {
        count: warmLatencies.length,
        p50Ms: percentile(warmLatencies, 0.5),
        p95Ms: percentile(warmLatencies, 0.95),
        minMs: warmLatencies[0],
        maxMs: warmLatencies[warmLatencies.length - 1],
      },
      concurrencyResults,
      burst50: {
        totalWallMs: burstEnd - burstStart,
        successCount: success.length,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        p99Ms: percentile(latencies, 0.99),
        maxMs: latencies[latencies.length - 1] || 0,
      },
    };

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = join(RESULTS_DIR, `m11-exec-optimization-${ts}.json`);
    const mdPath = join(RESULTS_DIR, `m11-exec-optimization-${ts}.md`);

    writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = `# M11 Execution Optimization Benchmark Report

- Timestamp: ${report.timestamp}

## Isolated Cold Single Execution (Before vs After)

| Phase | M10 Baseline (ms) | M11 Optimized (ms) | Improvement |
|---|---|---|---|
| Docker check (\`docker info\`) | 177.8 ms | ${singlePhases.dockerCheckMs.toFixed(1)} ms | -${(177.8 - singlePhases.dockerCheckMs).toFixed(1)} ms |
| Image inspect | 63.8 ms | ${singlePhases.imageInspectMs.toFixed(1)} ms | -${(63.8 - singlePhases.imageInspectMs).toFixed(1)} ms |
| Pre-rm | 39.7 ms | ${singlePhases.preRmMs.toFixed(1)} ms | - |
| Network setup | 118.0 ms | ${singlePhases.netSetupMs.toFixed(1)} ms | -${(118.0 - singlePhases.netSetupMs).toFixed(1)} ms |
| Container creation (\`docker run\`) | 342.5 ms | ${singlePhases.dockerRunMs.toFixed(1)} ms | - |
| Port inspect | 44.7 ms | ${singlePhases.portReadMs.toFixed(1)} ms | - |
| Exec startup | 86.0 ms | ${singlePhases.execStartupMs.toFixed(1)} ms | - |
| Program exec | 63.5 ms | ${singlePhases.programExecMs.toFixed(1)} ms | - |
| **Total Cold Creation + Exec** | **938.3 ms** | **${(singlePhases.totalMs - singlePhases.teardownMs).toFixed(1)} ms** | **${(((938.3 - (singlePhases.totalMs - singlePhases.teardownMs)) / 938.3) * 100).toFixed(1)}% reduction** |

## Warm Reused Sandbox Execution

- **Warm p50 / p95**: ${report.warmExecution.p50Ms.toFixed(1)} ms / ${report.warmExecution.p95Ms.toFixed(1)} ms

## 50-VU Execution Burst (M10 Baseline vs M11 Optimized)

| Metric | M10 Baseline (ms) | M11 Optimized (ms) | Improvement |
|---|---|---|---|
| p50 | 9,189.7 ms | ${report.burst50.p50Ms.toFixed(1)} ms | ${(((9189.7 - report.burst50.p50Ms) / 9189.7) * 100).toFixed(1)}% |
| p95 | 11,830.8 ms | ${report.burst50.p95Ms.toFixed(1)} ms | ${(((11830.8 - report.burst50.p95Ms) / 11830.8) * 100).toFixed(1)}% |
| p99 | 12,112.9 ms | ${report.burst50.p99Ms.toFixed(1)} ms | ${(((12112.9 - report.burst50.p99Ms) / 12112.9) * 100).toFixed(1)}% |
| Total Wall Clock | 12.12 s | ${(report.burst50.totalWallMs / 1000).toFixed(2)} s | - |
`;

    writeFileSync(mdPath, md);
    console.log(`[M11] Wrote ${jsonPath} and ${mdPath}`);

    try {
      await execFileAsync("docker", ["rm", "-f", warmContainer]);
      await execFileAsync("docker", ["network", "rm", warmNet]);
    } catch {}
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createProjectFiles(workspaceDir: string, fileCount: number, depth: number) {
  mkdirSync(workspaceDir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const dirLevel = i % depth;
    let targetDir = workspaceDir;
    for (let d = 0; d < dirLevel; d++) {
      targetDir = join(targetDir, `dir_${d}`);
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, `file_${i}.txt`), `Sample file content ${i}\n`);
  }
}

async function runFilesystemBenchmarks() {
  console.log("[M11] Running Filesystem Benchmarks...");
  const baseTemp = join(__dirname, "..", "tmp-fs-opt-" + Date.now());
  mkdirSync(baseTemp, { recursive: true });

  const projectConfigs = [
    { name: "tiny", files: 5, depth: 1 },
    { name: "medium", files: 50, depth: 3 },
    { name: "large", files: 300, depth: 5 },
  ];

  const results: Record<string, { files: number; treeMs: number; listFilesMs: number }> = {};

  try {
    for (const p of projectConfigs) {
      const pDir = join(baseTemp, p.name);
      await createProjectFiles(pDir, p.files, p.depth);

      const t0 = performance.now();
      await tree(pDir);
      const t1 = performance.now();

      const t2 = performance.now();
      await listFiles(pDir);
      const t3 = performance.now();

      results[p.name] = {
        files: p.files,
        treeMs: t1 - t0,
        listFilesMs: t3 - t2,
      };
    }

    // Concurrent callers (10, 50, 100) on medium project
    const mediumDir = join(baseTemp, "medium");
    const concurrencyLevels = [10, 50, 100];
    const concurrencyFsResults: Record<number, { p50Ms: number; p95Ms: number; maxMs: number; totalWallMs: number }> = {};

    for (const c of concurrencyLevels) {
      const wallStart = performance.now();
      const tasks = Array.from({ length: c }, async () => {
        const start = performance.now();
        await tree(mediumDir);
        return performance.now() - start;
      });
      const latencies = (await Promise.all(tasks)).sort((a, b) => a - b);
      const wallEnd = performance.now();

      concurrencyFsResults[c] = {
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        maxMs: latencies[latencies.length - 1],
        totalWallMs: wallEnd - wallStart,
      };
    }

    // /stats repeated requests against an active sandbox & inactive project
    console.log("[M11] Testing /stats telemetry latency...");
    const inactiveStatsTime0 = performance.now();
    await sandboxManager.getContainerStats("inactive-project-sample");
    const inactiveStatsTime = performance.now() - inactiveStatsTime0;

    const report = {
      timestamp: new Date().toISOString(),
      projectSizeTree: results,
      concurrencyResults: concurrencyFsResults,
      inactiveStatsMs: inactiveStatsTime,
    };

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = join(RESULTS_DIR, `m11-fs-optimization-${ts}.json`);
    const mdPath = join(RESULTS_DIR, `m11-fs-optimization-${ts}.md`);

    writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = `# M11 Filesystem Optimization Benchmark Report

- Timestamp: ${report.timestamp}

## Project Size Scaling (M10 Baseline vs M11 Optimized \`tree()\`)

| Project Size | Files | M10 Baseline (ms) | M11 Optimized (ms) | Improvement |
|---|---|---|---|---|
| Tiny | 5 | 9.24 ms | ${results.tiny.treeMs.toFixed(2)} ms | ${(((9.24 - results.tiny.treeMs) / 9.24) * 100).toFixed(1)}% |
| Medium | 50 | 9.16 ms | ${results.medium.treeMs.toFixed(2)} ms | ${(((9.16 - results.medium.treeMs) / 9.16) * 100).toFixed(1)}% |
| Large | 300 | 20.70 ms | ${results.large.treeMs.toFixed(2)} ms | ${(((20.70 - results.large.treeMs) / 20.70) * 100).toFixed(1)}% |

## Concurrent Tree Requests (Medium 50-file Project, M10 vs M11)

| Concurrency | M10 Baseline p50 (ms) | M11 Optimized p50 (ms) | M10 Baseline p95 (ms) | M11 Optimized p95 (ms) | Improvement (p95) |
|---|---|---|---|---|---|
| 10 callers | 14.6 ms | ${concurrencyFsResults[10].p50Ms.toFixed(1)} ms | 14.7 ms | ${concurrencyFsResults[10].p95Ms.toFixed(1)} ms | ${(((14.7 - concurrencyFsResults[10].p95Ms) / 14.7) * 100).toFixed(1)}% |
| 50 callers | 54.1 ms | ${concurrencyFsResults[50].p50Ms.toFixed(1)} ms | 54.2 ms | ${concurrencyFsResults[50].p95Ms.toFixed(1)} ms | ${(((54.2 - concurrencyFsResults[50].p95Ms) / 54.2) * 100).toFixed(1)}% |
| 100 callers | 109.5 ms | ${concurrencyFsResults[100].p50Ms.toFixed(1)} ms | 109.6 ms | ${concurrencyFsResults[100].p95Ms.toFixed(1)} ms | ${(((109.6 - concurrencyFsResults[100].p95Ms) / 109.6) * 100).toFixed(1)}% |

## Inactive /stats Telemetry Latency

- **M10 Baseline (failed \`docker stats\` execution)**: ~50 ms
- **M11 Optimized (in-memory fast path)**: **${inactiveStatsTime.toFixed(2)} ms** (Speedup: ~${(50 / Math.max(0.1, inactiveStatsTime)).toFixed(1)}x)
`;

    writeFileSync(mdPath, md);
    console.log(`[M11] Wrote ${jsonPath} and ${mdPath}`);
  } finally {
    await fs.rm(baseTemp, { recursive: true, force: true });
  }
}

async function main() {
  await runExecutionBenchmarks();
  await runFilesystemBenchmarks();
  console.log("[M11] All optimization benchmarks complete.");
}

main().catch(console.error);
