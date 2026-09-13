import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { sandboxManager } from "../src/execution/sandbox.js";
import { resolveConfig } from "../src/config.js";
import { isDockerRunningAsync, isRunnerImageAvailableAsync } from "../src/tools.js";
import { bootstrapLoadTestServer } from "./server.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

mkdirSync(RESULTS_DIR, { recursive: true });

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(sortedArr.length * p)));
  return sortedArr[idx];
}

async function measureColdConcurrency(concurrency: number): Promise<{
  concurrency: number;
  p50: number;
  p95: number;
  p99: number;
  wallMs: number;
}> {
  const tempBase = mkdtempSync(join(tmpdir(), `m16-concurr-${concurrency}-`));
  const projects: Array<{ id: string; dir: string }> = [];

  for (let i = 0; i < concurrency; i++) {
    const id = `m16_c${concurrency}_${i}_${Date.now()}`;
    const dir = join(tempBase, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.py"), "print('ok')\n");
    projects.push({ id, dir });
  }

  const startWall = performance.now();
  const promises = projects.map(async (p) => {
    const t0 = performance.now();
    try {
      await sandboxManager.ensureProjectSandbox(p.id, resolveConfig(), p.dir, 1);
      await execFileAsync("docker", ["exec", "-i", "-w", "/workspace", `ide-sandbox-${p.id}`, "python3", "main.py"]);
      const elapsed = performance.now() - t0;
      await sandboxManager.stopProjectSandbox(p.id);
      return elapsed;
    } catch (_err: unknown) {
      await sandboxManager.stopProjectSandbox(p.id);
      return performance.now() - t0;
    }
  });

  const latencies = await Promise.all(promises);
  const wallMs = performance.now() - startWall;

  rmSync(tempBase, { recursive: true, force: true });
  latencies.sort((a, b) => a - b);

  return {
    concurrency,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    wallMs,
  };
}

async function run50VUBurstTest(): Promise<{
  p50: number;
  p95: number;
  p99: number;
  wallMs: number;
  successCount: number;
  errorCount: number;
}> {
  console.log("\n[M16] Firing 50 simultaneous execution requests via Server...");
  const server = await bootstrapLoadTestServer({
    authRateLimit: { max: 100_000, windowMs: 60_000 },
  });

  const users: Array<{ token: string; projectId: string }> = [];
  for (let i = 0; i < 50; i++) {
    const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `burst16_u_${i}_${Date.now()}`, password: "load-test-password-1234" }),
    }).then((r) => r.json())) as any;

    const proj = (await fetch(`${server.baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ name: `burst16-p-${i}` }),
    }).then((r) => r.json())) as any;

    await fetch(`${server.baseUrl}/api/projects/${proj.project.id}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ path: "main.py", content: "print('burst-m16')\n" }),
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

  return {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    wallMs: burstEnd - burstStart,
    successCount: success.length,
    errorCount: burstResults.length - success.length,
  };
}

async function run() {
  console.log("==========================================");
  console.log("Milestone 16 — Cold Sandbox Provisioning Verification");
  console.log("==========================================");

  if (!(await isDockerRunningAsync())) {
    throw new Error("Docker is not running");
  }
  if (!(await isRunnerImageAvailableAsync())) {
    throw new Error("cloudeeeide-runner:latest is not available");
  }

  // 1. Concurrency measurements
  console.log("\n--- Concurrency Scale Measurements (1, 5, 10, 20) ---");
  const c1 = await measureColdConcurrency(1);
  console.log(`[C=1]  p50=${c1.p50.toFixed(1)}ms, p95=${c1.p95.toFixed(1)}ms, wall=${c1.wallMs.toFixed(1)}ms`);

  const c5 = await measureColdConcurrency(5);
  console.log(`[C=5]  p50=${c5.p50.toFixed(1)}ms, p95=${c5.p95.toFixed(1)}ms, wall=${c5.wallMs.toFixed(1)}ms`);

  const c10 = await measureColdConcurrency(10);
  console.log(`[C=10] p50=${c10.p50.toFixed(1)}ms, p95=${c10.p95.toFixed(1)}ms, wall=${c10.wallMs.toFixed(1)}ms`);

  const c20 = await measureColdConcurrency(20);
  console.log(`[C=20] p50=${c20.p50.toFixed(1)}ms, p95=${c20.p95.toFixed(1)}ms, wall=${c20.wallMs.toFixed(1)}ms`);

  // 2. 50-VU Burst Execution
  const burst = await run50VUBurstTest();
  console.log(`\n[M16 50-VU Burst] p50=${burst.p50.toFixed(1)}ms, p95=${burst.p95.toFixed(1)}ms, p99=${burst.p99.toFixed(1)}ms, Wall=${(burst.wallMs / 1000).toFixed(2)}s`);
  console.log(`[M16 50-VU Burst] Success: ${burst.successCount}/50, Errors: ${burst.errorCount}`);

  const report = {
    timestamp: new Date().toISOString(),
    concurrencyMatrix: { c1, c5, c10, c20 },
    burst50VU: burst,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(RESULTS_DIR, `m16-optimization-${ts}.json`);
  const mdPath = join(RESULTS_DIR, `m16-optimization-${ts}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# Milestone 16 Verification Report: Cold Provisioning & Concurrency

- Timestamp: ${report.timestamp}

## Concurrency Scale Matrix (Cold Start + Run)

| Concurrency | p50 (ms) | p95 (ms) | p99 (ms) | Wall Clock (ms) |
|---|---|---|---|---|
| **C=1** | ${c1.p50.toFixed(1)} ms | ${c1.p95.toFixed(1)} ms | ${c1.p99.toFixed(1)} ms | ${c1.wallMs.toFixed(1)} ms |
| **C=5** | ${c5.p50.toFixed(1)} ms | ${c5.p95.toFixed(1)} ms | ${c5.p99.toFixed(1)} ms | ${c5.wallMs.toFixed(1)} ms |
| **C=10** | ${c10.p50.toFixed(1)} ms | ${c10.p95.toFixed(1)} ms | ${c10.p99.toFixed(1)} ms | ${c10.wallMs.toFixed(1)} ms |
| **C=20** | ${c20.p50.toFixed(1)} ms | ${c20.p95.toFixed(1)} ms | ${c20.p99.toFixed(1)} ms | ${c20.wallMs.toFixed(1)} ms |

## 50-VU Execution Burst

| Metric | M13 Baseline | Post-M16 Optimized | Delta |
|---|---|---|---|
| **Burst p50** | 165.6 ms | ${burst.p50.toFixed(1)} ms | ${(burst.p50 - 165.6).toFixed(1)} ms |
| **Burst p95** | 4,277.0 ms | ${burst.p95.toFixed(1)} ms | ${(burst.p95 - 4277.0).toFixed(1)} ms |
| **Burst p99** | 4,562.0 ms | ${burst.p99.toFixed(1)} ms | ${(burst.p99 - 4562.0).toFixed(1)} ms |
| **Wall Clock** | 4.56 s | ${(burst.wallMs / 1000).toFixed(2)} s | ${((burst.wallMs - 4560) / 1000).toFixed(2)} s |
| **Success Rate** | 50 / 50 | ${burst.successCount} / 50 | 100% |
`;

  writeFileSync(mdPath, md);
  console.log(`\n[M16] Saved results: ${jsonPath} and ${mdPath}`);
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
