import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { bootstrapLoadTestServer } from "./server.js";
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
  parallelChecksMs: number;
  netSetupMs: number;
  dockerRunMs: number;
  execStartupMs: number;
  programExecMs: number;
  teardownMs: number;
  totalMs: number;
}

async function measureM13DockerPhases(projectId: string, workspaceDir: string): Promise<PhaseTimings> {
  const containerId = `test-opt13-${projectId}`;
  const netName = `test-net13-${projectId}`;

  // 1. Parallel availability checks
  const t0 = performance.now();
  await Promise.all([isDockerRunningAsync(), isRunnerImageAvailableAsync()]);
  const t1 = performance.now();

  // 2. Net setup (direct create with catch)
  try {
    await execFileAsync("docker", ["network", "create", netName]);
  } catch {}
  const t2 = performance.now();

  // 3. Docker run (Level 4 hardening)
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
  const t3 = performance.now();

  // 4 & 5. Exec startup and program execution
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

  // 6. Teardown
  const td0 = performance.now();
  try {
    await execFileAsync("docker", ["rm", "-f", containerId]);
    await execFileAsync("docker", ["network", "rm", netName]);
  } catch {}
  const td1 = performance.now();

  return {
    parallelChecksMs: t1 - t0,
    netSetupMs: t2 - t1,
    dockerRunMs: t3 - t2,
    execStartupMs: (firstByteTime || execEnd) - execStart,
    programExecMs: execEnd - (firstByteTime || execStart),
    teardownMs: td1 - td0,
    totalMs: td1 - t0,
  };
}

async function runExecutionBenchmarks() {
  console.log("[M13] Running Execution Benchmarks...");
  const tempDir = join(__dirname, "..", "tmp-m13-opt-" + Date.now());
  mkdirSync(tempDir, { recursive: true });

  try {
    // Single cold start
    const singlePhases = await measureM13DockerPhases(`single-${Date.now()}`, tempDir);

    // Warm execution (with liveness freshness optimization)
    const warmContainer = `test-warm-m13-${Date.now()}`;
    const warmNet = `test-warm-net13-${Date.now()}`;
    await execFileAsync("docker", ["network", "create", warmNet]);
    await execFileAsync("docker", ["run", "-d", "--name", warmContainer, "--network", warmNet, "-v", `${tempDir}:/workspace`, "-w", "/workspace", "cloudeeeide-runner:latest", "sleep", "infinity"]);

    const warmLatencies: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await execFileAsync("docker", ["exec", "-i", "-w", "/workspace", warmContainer, "python3", "-c", "print('hello')"]);
      warmLatencies.push(performance.now() - t0);
    }
    warmLatencies.sort((a, b) => a - b);

    // 50-VU Execution Burst via Server
    console.log("[M13] Firing 50 simultaneous execution requests via Server...");
    const server = await bootstrapLoadTestServer({
      authRateLimit: { max: 100_000, windowMs: 60_000 },
    });

    const users: Array<{ token: string; projectId: string }> = [];
    for (let i = 0; i < 50; i++) {
      const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: `burst13_u_${i}_${Date.now()}`, password: "load-test-password-1234" }),
      }).then((r) => r.json())) as any;

      const proj = (await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
        body: JSON.stringify({ name: `burst13-p-${i}` }),
      }).then((r) => r.json())) as any;

      await fetch(`${server.baseUrl}/api/projects/${proj.project.id}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
        body: JSON.stringify({ path: "main.py", content: "print('burst-m13')\n" }),
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
    const jsonPath = join(RESULTS_DIR, `m13-exec-optimization-${ts}.json`);
    const mdPath = join(RESULTS_DIR, `m13-exec-optimization-${ts}.md`);

    writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = `# M13 Execution Optimization Benchmark Report

- Timestamp: ${report.timestamp}

## Isolated Cold Single Execution (M10 vs M12 vs M13)

| Phase | M10 Baseline (ms) | M13 Optimized (ms) | Improvement vs M10 |
|---|---|---|---|
| Parallel Availability Checks | 241.6 ms | ${singlePhases.parallelChecksMs.toFixed(1)} ms | -${(241.6 - singlePhases.parallelChecksMs).toFixed(1)} ms |
| Network Setup | 118.0 ms | ${singlePhases.netSetupMs.toFixed(1)} ms | -${(118.0 - singlePhases.netSetupMs).toFixed(1)} ms |
| Container Creation (\`docker run\`) | 342.5 ms | ${singlePhases.dockerRunMs.toFixed(1)} ms | - |
| Exec Startup | 86.0 ms | ${singlePhases.execStartupMs.toFixed(1)} ms | - |
| Program Exec | 63.5 ms | ${singlePhases.programExecMs.toFixed(1)} ms | - |
| **Total Cold Creation + Exec** | **938.3 ms** | **${(singlePhases.totalMs - singlePhases.teardownMs).toFixed(1)} ms** | **${(((938.3 - (singlePhases.totalMs - singlePhases.teardownMs)) / 938.3) * 100).toFixed(1)}% reduction** |

## Warm Reused Sandbox Execution

- **Warm p50 / p95**: ${report.warmExecution.p50Ms.toFixed(1)} ms / ${report.warmExecution.p95Ms.toFixed(1)} ms

## 50-VU Execution Burst (M10 Baseline vs M13 Optimized)

| Metric | M10 Baseline (ms) | M12 Baseline (ms) | M13 Optimized (ms) | Improvement vs M10 | Improvement vs M12 |
|---|---|---|---|---|---|
| p50 | 9,189.7 ms | 448.4 ms | ${report.burst50.p50Ms.toFixed(1)} ms | ${(((9189.7 - report.burst50.p50Ms) / 9189.7) * 100).toFixed(1)}% | ${(((448.4 - report.burst50.p50Ms) / 448.4) * 100).toFixed(1)}% |
| p95 | 11,830.8 ms | 4,564.0 ms | ${report.burst50.p95Ms.toFixed(1)} ms | ${(((11830.8 - report.burst50.p95Ms) / 11830.8) * 100).toFixed(1)}% | ${(((4564.0 - report.burst50.p95Ms) / 4564.0) * 100).toFixed(1)}% |
| p99 | 12,112.9 ms | 4,833.3 ms | ${report.burst50.p99Ms.toFixed(1)} ms | ${(((12112.9 - report.burst50.p99Ms) / 12112.9) * 100).toFixed(1)}% | ${(((4833.3 - report.burst50.p99Ms) / 4833.3) * 100).toFixed(1)}% |
| Total Wall Clock | 12.12 s | 4.84 s | ${(report.burst50.totalWallMs / 1000).toFixed(2)} s | ${(((12.12 - report.burst50.totalWallMs / 1000) / 12.12) * 100).toFixed(1)}% | ${(((4.84 - report.burst50.totalWallMs / 1000) / 4.84) * 100).toFixed(1)}% |
`;

    writeFileSync(mdPath, md);
    console.log(`[M13] Wrote ${jsonPath} and ${mdPath}`);

    try {
      await execFileAsync("docker", ["rm", "-f", warmContainer]);
      await execFileAsync("docker", ["network", "rm", warmNet]);
    } catch {}
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await runExecutionBenchmarks();
  console.log("[M13] All execution benchmarks complete.");
}

main().catch(console.error);
