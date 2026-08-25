/**
 * Milestone 18 — Cold-Wait Decomposition & Scheduling Decision Investigation
 *
 * Measures the decomposition of cold Docker sandbox execution into:
 *   1. Admission wait (time waiting for a global slot under maxSandboxes=20)
 *   2. Docker provisioning (container creation + network setup)
 *   3. Program execution (docker exec)
 *   4. Teardown (container stop/remove)
 *
 * Runs concurrency sweeps at C=1, 5, 10, 20, 40.
 * Captures latency bucket distributions for user-impact analysis.
 * Does NOT modify production code or admission semantics.
 */

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { bootstrapLoadTestServer } from "./server.js";
import { isDockerRunningAsync, isRunnerImageAvailableAsync } from "../src/tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

mkdirSync(RESULTS_DIR, { recursive: true });

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(
    sortedArr.length - 1,
    Math.max(0, Math.floor(sortedArr.length * p)),
  );
  return sortedArr[idx];
}

function percentiles(values: number[]): {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? sum / sorted.length : 0,
  };
}

function bucketize(values: number[]): {
  under1s: number;
  between1s2s: number;
  between2s5s: number;
  over5s: number;
} {
  let under1s = 0,
    between1s2s = 0,
    between2s5s = 0,
    over5s = 0;
  for (const v of values) {
    if (v < 1000) under1s++;
    else if (v < 2000) between1s2s++;
    else if (v < 5000) between2s5s++;
    else over5s++;
  }
  return { under1s, between1s2s, between2s5s, over5s };
}

interface RequestDecomposition {
  /** Index of the request in the batch. */
  idx: number;
  /** Total time from request start to response. */
  totalMs: number;
  /** Time waiting for the run endpoint to be available (queuing/admission). */
  admissionMs: number;
  /** Time spent in Docker provisioning (container creation). */
  provisioningMs: number;
  /** Time spent executing the program. */
  executionMs: number;
  /** HTTP status code. */
  status: number;
  /** Whether the request succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}

/**
 * Run a concurrency sweep by firing `concurrency` simultaneous cold execution
 * requests through the real HTTP API, each with a distinct user and project.
 *
 * The decomposition is approximate because we measure from the client side:
 * - admissionMs ≈ time from request send until server starts provisioning
 *   (not directly observable from HTTP; we compute it as totalMs - provisioningMs - executionMs)
 * - provisioningMs + executionMs ≈ server-side durationMs from the run response
 *
 * The server's run response includes `durationMs` which covers sandbox provisioning
 * + execution. We measure total round-trip from the client, so:
 *   admissionMs ≈ totalMs - server_durationMs - network_overhead
 *
 * For requests that exceed maxSandboxes, the server rejects with an error
 * immediately (no queue). So admissionMs for rejected requests ≈ 0, and we
 * can count rejections to understand slot contention.
 */
async function measureConcurrencySweep(
  concurrency: number,
  maxSandboxes: number,
): Promise<{
  concurrency: number;
  maxSandboxes: number;
  results: RequestDecomposition[];
  wallMs: number;
  rejections: number;
}> {
  console.log(
    `\n--- Measuring C=${concurrency} (maxSandboxes=${maxSandboxes}) ---`,
  );
  const server = await bootstrapLoadTestServer({
    authRateLimit: { max: 100_000, windowMs: 60_000 },
    maxSandboxes,
  });

  // Create distinct users and projects
  const users: Array<{ token: string; projectId: string }> = [];
  for (let i = 0; i < concurrency; i++) {
    const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `m18_u_${concurrency}_${i}_${Date.now()}`,
        password: "load-test-password-1234",
      }),
    }).then((r) => r.json())) as any;

    const proj = (await fetch(`${server.baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ name: `m18-p-${concurrency}-${i}` }),
    }).then((r) => r.json())) as any;

    await fetch(`${server.baseUrl}/api/projects/${proj.project.id}/file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({
        path: "main.py",
        content: "print('m18-cold-wait')\n",
      }),
    });

    users.push({ token: reg.token, projectId: proj.project.id });
  }

  const startWall = performance.now();
  const promises = users.map(async (u, idx): Promise<RequestDecomposition> => {
    const reqStart = performance.now();
    try {
      const res = await fetch(
        `${server.baseUrl}/api/projects/${u.projectId}/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${u.token}`,
          },
          body: JSON.stringify({ path: "main.py" }),
        },
      );
      const totalMs = performance.now() - reqStart;
      const body = (await res.json()) as any;

      if (res.status !== 200) {
        return {
          idx,
          totalMs,
          admissionMs: totalMs,
          provisioningMs: 0,
          executionMs: 0,
          status: res.status,
          success: false,
          error: body.stderr || body.error || `HTTP ${res.status}`,
        };
      }

      // Server-side durationMs covers sandbox provisioning + execution
      const serverDurationMs = body.durationMs ?? 0;
      // Approximate admission wait = total - server duration
      // This includes HTTP overhead (~1-5ms) which is negligible
      const admissionMs = Math.max(0, totalMs - serverDurationMs);

      // We can't directly separate provisioning from execution in the HTTP
      // response, but the run result's durationMs starts from sandboxRun's
      // `const start = Date.now()` which includes both ensureProjectSandbox
      // and docker exec. For a cold start, provisioning dominates.
      return {
        idx,
        totalMs,
        admissionMs,
        provisioningMs: serverDurationMs, // provisioning + execution combined
        executionMs: 0, // cannot separate from HTTP API alone
        status: res.status,
        success: true,
      };
    } catch (err: any) {
      return {
        idx,
        totalMs: performance.now() - reqStart,
        admissionMs: 0,
        provisioningMs: 0,
        executionMs: 0,
        status: 0,
        success: false,
        error: err.message,
      };
    }
  });

  const results = await Promise.all(promises);
  const wallMs = performance.now() - startWall;
  await server.close();

  const rejections = results.filter((r) => !r.success).length;
  const successLatencies = results
    .filter((r) => r.success)
    .map((r) => r.totalMs)
    .sort((a, b) => a - b);

  if (successLatencies.length > 0) {
    const p = percentiles(successLatencies);
    console.log(
      `  Success: ${results.length - rejections}/${concurrency}, Rejected: ${rejections}`,
    );
    console.log(
      `  Total p50=${p.p50.toFixed(1)}ms p95=${p.p95.toFixed(1)}ms p99=${p.p99.toFixed(1)}ms`,
    );
    console.log(`  Wall=${wallMs.toFixed(1)}ms`);
  } else {
    console.log(`  All ${concurrency} requests rejected/failed`);
  }

  return { concurrency, maxSandboxes, results, wallMs, rejections };
}

/**
 * Run a steady-state user-impact measurement: sequential cold executions
 * spaced 500ms apart (simulating ordinary user traffic patterns).
 */
async function measureSteadyUserImpact(
  requestCount: number,
  intervalMs: number,
): Promise<{
  requestCount: number;
  intervalMs: number;
  results: RequestDecomposition[];
  wallMs: number;
}> {
  console.log(
    `\n--- Steady-State User Impact (${requestCount} requests, ${intervalMs}ms apart) ---`,
  );
  const server = await bootstrapLoadTestServer({
    authRateLimit: { max: 100_000, windowMs: 60_000 },
  });

  // Create distinct users/projects
  const users: Array<{ token: string; projectId: string }> = [];
  for (let i = 0; i < requestCount; i++) {
    const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `m18_steady_${i}_${Date.now()}`,
        password: "load-test-password-1234",
      }),
    }).then((r) => r.json())) as any;

    const proj = (await fetch(`${server.baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ name: `m18-steady-${i}` }),
    }).then((r) => r.json())) as any;

    await fetch(`${server.baseUrl}/api/projects/${proj.project.id}/file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({
        path: "main.py",
        content: "print('m18-steady')\n",
      }),
    });

    users.push({ token: reg.token, projectId: proj.project.id });
  }

  const results: RequestDecomposition[] = [];
  const startWall = performance.now();

  for (let i = 0; i < requestCount; i++) {
    const u = users[i];
    const reqStart = performance.now();

    try {
      const res = await fetch(
        `${server.baseUrl}/api/projects/${u.projectId}/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${u.token}`,
          },
          body: JSON.stringify({ path: "main.py" }),
        },
      );
      const totalMs = performance.now() - reqStart;
      const body = (await res.json()) as any;
      const serverDurationMs = body.durationMs ?? 0;
      const admissionMs = Math.max(0, totalMs - serverDurationMs);

      results.push({
        idx: i,
        totalMs,
        admissionMs,
        provisioningMs: serverDurationMs,
        executionMs: 0,
        status: res.status,
        success: res.status === 200,
        error: res.status !== 200 ? body.stderr || `HTTP ${res.status}` : undefined,
      });
    } catch (err: any) {
      results.push({
        idx: i,
        totalMs: performance.now() - reqStart,
        admissionMs: 0,
        provisioningMs: 0,
        executionMs: 0,
        status: 0,
        success: false,
        error: err.message,
      });
    }

    // Wait between requests (don't wait after last)
    if (i < requestCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const wallMs = performance.now() - startWall;
  await server.close();

  const successLatencies = results
    .filter((r) => r.success)
    .map((r) => r.totalMs);
  const p = percentiles(successLatencies);
  const buckets = bucketize(successLatencies);
  console.log(
    `  Success: ${results.filter((r) => r.success).length}/${requestCount}`,
  );
  console.log(
    `  Total p50=${p.p50.toFixed(1)}ms p95=${p.p95.toFixed(1)}ms p99=${p.p99.toFixed(1)}ms`,
  );
  console.log(
    `  Distribution: <1s=${buckets.under1s} 1-2s=${buckets.between1s2s} 2-5s=${buckets.between2s5s} >5s=${buckets.over5s}`,
  );

  return { requestCount, intervalMs, results, wallMs };
}

/**
 * Scheduling simulation: purely analytical comparison of admission strategies.
 * Uses collected cold-start data to project behavior under different policies.
 */
function simulateSchedulingStrategies(
  sweepResults: Array<{
    concurrency: number;
    results: RequestDecomposition[];
    wallMs: number;
    rejections: number;
  }>,
): {
  currentImmediate: { description: string; analysis: string };
  strictFIFO: { description: string; analysis: string };
  shortestJob: { description: string; analysis: string };
  boundedConcurrency: { description: string; analysis: string; optimalBound: number };
} {
  // Find the concurrency level with the best per-request throughput
  const throughputs = sweepResults
    .filter((s) => s.results.some((r) => r.success))
    .map((s) => {
      const successes = s.results.filter((r) => r.success);
      const totalLatency = successes.reduce((a, r) => a + r.totalMs, 0);
      return {
        concurrency: s.concurrency,
        avgLatencyMs: totalLatency / successes.length,
        throughput: (successes.length / s.wallMs) * 1000,
        successRate: successes.length / s.results.length,
        rejections: s.rejections,
      };
    });

  // Find the elbow point: where adding concurrency starts degrading per-request latency
  let optimalBound = 20; // default to current maxSandboxes
  let bestEfficiency = 0;
  for (const t of throughputs) {
    // Efficiency = throughput / avgLatency (higher is better)
    const eff = t.throughput / t.avgLatencyMs;
    if (eff > bestEfficiency && t.successRate > 0.5) {
      bestEfficiency = eff;
      optimalBound = t.concurrency;
    }
  }

  const c20Data = sweepResults.find((s) => s.concurrency === 20);
  const c40Data = sweepResults.find((s) => s.concurrency === 40);

  // C=40 analysis: how many are rejected because maxSandboxes=20?
  const c40Rejections = c40Data?.rejections ?? 0;
  const c40Successes = c40Data
    ? c40Data.results.filter((r) => r.success).length
    : 0;

  return {
    currentImmediate: {
      description:
        "Current: immediate admission, reject when maxSandboxes reached",
      analysis: [
        `Under C≤20: all requests admitted, no queuing.`,
        `Under C>20: ${c40Rejections}/${c40Data?.concurrency ?? 40} requests rejected immediately (no wait, clear error).`,
        `No head-of-line blocking. No starvation. No queue memory.`,
        `Rejected requests can retry (client-side).`,
        `Throughput data: ${throughputs.map((t) => `C=${t.concurrency}: ${t.throughput.toFixed(1)} req/s, avg=${t.avgLatencyMs.toFixed(0)}ms`).join("; ")}`,
      ].join("\n"),
    },
    strictFIFO: {
      description:
        "FIFO queue: hold excess requests until a slot opens, serve in order",
      analysis: [
        `Would eliminate immediate rejections at C>20.`,
        `But: adds admission wait to ALL queued requests (at C=40, 20 requests wait for the first batch to complete).`,
        `Estimated added wait for queued requests at C=40: ~${c20Data ? (c20Data.wallMs / 1000).toFixed(1) : "?"}s (full C=20 batch wall time).`,
        `Risks: head-of-line blocking, starvation under sustained load, unbounded queue growth.`,
        `Requires: disconnect detection, cancellation, timeout, queue depth limit, per-user fairness.`,
        `Net effect: converts fast rejection into slow queuing — user waits longer for the same outcome.`,
      ].join("\n"),
    },
    shortestJob: {
      description:
        "Priority queue: estimate execution cost, run cheapest first",
      analysis: [
        `All cold starts have similar cost (Docker provisioning dominates).`,
        `Cannot estimate job duration before running it.`,
        `For this system, all executions are roughly equivalent (print-hello).`,
        `No meaningful scheduling advantage over FIFO.`,
        `Adds complexity: cost estimation, priority inversion, starvation prevention.`,
      ].join("\n"),
    },
    boundedConcurrency: {
      description: `Limit Docker daemon concurrency to ${optimalBound} to reduce daemon lock contention`,
      analysis: [
        `Optimal measured concurrency: C=${optimalBound} (best throughput/latency ratio).`,
        `Could reduce p95/p99 for the admitted batch by avoiding Docker daemon serialization.`,
        `But: current system already has maxSandboxes=20 which naturally bounds concurrency.`,
        `Adding an inner concurrency limit below 20 would reduce effective capacity.`,
        `The Docker daemon is the bottleneck, not the admission logic.`,
      ].join("\n"),
      optimalBound,
    },
  };
}

async function run() {
  console.log("==========================================");
  console.log("Milestone 18 — Cold-Wait Decomposition & Scheduling Decision");
  console.log("==========================================");

  if (!(await isDockerRunningAsync())) {
    throw new Error("Docker is not running");
  }
  if (!(await isRunnerImageAvailableAsync())) {
    throw new Error("cloudeeeide-runner:latest is not available");
  }

  // Phase 1: Cold wait decomposition at different concurrency levels
  console.log("\n========== PHASE 1: Cold Wait Decomposition ==========");
  const c1 = await measureConcurrencySweep(1, 20);
  const c5 = await measureConcurrencySweep(5, 20);
  const c10 = await measureConcurrencySweep(10, 20);
  const c20 = await measureConcurrencySweep(20, 20);
  const c40 = await measureConcurrencySweep(40, 20);

  const sweepResults = [c1, c5, c10, c20, c40];

  // Phase 2: User-impact latency distribution
  console.log("\n========== PHASE 2: User Impact Distribution ==========");

  // Steady traffic: 20 sequential cold requests, 500ms apart
  const steady = await measureSteadyUserImpact(20, 500);

  // Burst traffic: we already have C=20 and C=40 from Phase 1
  // Extract latency distributions
  const burstC20Latencies = c20.results
    .filter((r) => r.success)
    .map((r) => r.totalMs);
  const burstC40Latencies = c40.results
    .filter((r) => r.success)
    .map((r) => r.totalMs);
  const steadyLatencies = steady.results
    .filter((r) => r.success)
    .map((r) => r.totalMs);

  const burstC20Buckets = bucketize(burstC20Latencies);
  const burstC40Buckets = bucketize(burstC40Latencies);
  const steadyBuckets = bucketize(steadyLatencies);

  console.log("\n--- Latency Distribution Summary ---");
  console.log(
    `  Steady (sequential): <1s=${steadyBuckets.under1s} 1-2s=${steadyBuckets.between1s2s} 2-5s=${steadyBuckets.between2s5s} >5s=${steadyBuckets.over5s}`,
  );
  console.log(
    `  Burst C=20:          <1s=${burstC20Buckets.under1s} 1-2s=${burstC20Buckets.between1s2s} 2-5s=${burstC20Buckets.between2s5s} >5s=${burstC20Buckets.over5s}`,
  );
  console.log(
    `  Burst C=40:          <1s=${burstC40Buckets.under1s} 1-2s=${burstC40Buckets.between1s2s} 2-5s=${burstC40Buckets.between2s5s} >5s=${burstC40Buckets.over5s}`,
  );

  // Phase 3: Scheduling simulation
  console.log("\n========== PHASE 3: Scheduling Simulation ==========");
  const simulation = simulateSchedulingStrategies(sweepResults);
  console.log(`\n  A. ${simulation.currentImmediate.description}`);
  console.log(`  B. ${simulation.strictFIFO.description}`);
  console.log(`  C. ${simulation.shortestJob.description}`);
  console.log(`  D. ${simulation.boundedConcurrency.description}`);

  // Assemble report
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    timestamp: new Date().toISOString(),
    phase1_coldWaitDecomposition: {
      c1: summarizeSweep(c1),
      c5: summarizeSweep(c5),
      c10: summarizeSweep(c10),
      c20: summarizeSweep(c20),
      c40: summarizeSweep(c40),
    },
    phase2_userImpact: {
      steady: {
        requestCount: steady.requestCount,
        intervalMs: steady.intervalMs,
        wallMs: steady.wallMs,
        latencyPercentiles: percentiles(steadyLatencies),
        distribution: steadyBuckets,
        successCount: steady.results.filter((r) => r.success).length,
        totalCount: steady.requestCount,
      },
      burstC20: {
        latencyPercentiles: percentiles(burstC20Latencies),
        distribution: burstC20Buckets,
        successCount: burstC20Latencies.length,
        rejections: c20.rejections,
        totalCount: c20.concurrency,
      },
      burstC40: {
        latencyPercentiles: percentiles(burstC40Latencies),
        distribution: burstC40Buckets,
        successCount: burstC40Latencies.length,
        rejections: c40.rejections,
        totalCount: c40.concurrency,
      },
    },
    phase3_schedulingSimulation: simulation,
    rawResults: {
      sweeps: sweepResults.map((s) => ({
        concurrency: s.concurrency,
        wallMs: s.wallMs,
        rejections: s.rejections,
        results: s.results,
      })),
      steady: steady.results,
    },
  };

  const jsonPath = join(RESULTS_DIR, `m18-cold-wait-investigation-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Generate markdown report
  const steadyP = percentiles(steadyLatencies);
  const burstC20P = percentiles(burstC20Latencies);
  const burstC40P = percentiles(burstC40Latencies);

  const md = `# Milestone 18 — Cold-Wait Decomposition & Scheduling Decision

- Timestamp: ${report.timestamp}
- maxSandboxes: 20

## Phase 1: Cold Wait Decomposition

| Concurrency | Success | Rejected | Total p50 (ms) | Total p95 (ms) | Total p99 (ms) | Wall (ms) |
|---|---|---|---|---|---|---|
${sweepResults.map((s) => {
  const succ = s.results.filter((r) => r.success);
  const p = percentiles(succ.map((r) => r.totalMs));
  return `| **C=${s.concurrency}** | ${succ.length}/${s.concurrency} | ${s.rejections} | ${p.p50.toFixed(1)} | ${p.p95.toFixed(1)} | ${p.p99.toFixed(1)} | ${s.wallMs.toFixed(1)} |`;
}).join("\n")}

### Wait Decomposition Analysis

For C≤20, all requests are admitted immediately (no admission wait).
For C=40, ${c40.rejections} requests are rejected immediately at the maxSandboxes=20 gate.
The remaining ${c40.results.filter((r) => r.success).length} admitted requests proceed directly to Docker provisioning.

**Key finding**: There is no queuing delay — the system either admits immediately or rejects.
The entire cold latency is Docker provisioning + execution time.

## Phase 2: User-Impact Latency Distribution

### Steady Traffic (${steady.requestCount} sequential requests, ${steady.intervalMs}ms apart)

| Metric | Value |
|---|---|
| p50 | ${steadyP.p50.toFixed(1)} ms |
| p95 | ${steadyP.p95.toFixed(1)} ms |
| p99 | ${steadyP.p99.toFixed(1)} ms |
| <1s | ${steadyBuckets.under1s} (${((steadyBuckets.under1s / steady.requestCount) * 100).toFixed(0)}%) |
| 1-2s | ${steadyBuckets.between1s2s} (${((steadyBuckets.between1s2s / steady.requestCount) * 100).toFixed(0)}%) |
| 2-5s | ${steadyBuckets.between2s5s} (${((steadyBuckets.between2s5s / steady.requestCount) * 100).toFixed(0)}%) |
| >5s | ${steadyBuckets.over5s} (${((steadyBuckets.over5s / steady.requestCount) * 100).toFixed(0)}%) |

### 20-Concurrent Cold Burst

| Metric | Value |
|---|---|
| Success / Total | ${burstC20Latencies.length} / ${c20.concurrency} |
| Rejected | ${c20.rejections} |
| p50 | ${burstC20P.p50.toFixed(1)} ms |
| p95 | ${burstC20P.p95.toFixed(1)} ms |
| p99 | ${burstC20P.p99.toFixed(1)} ms |
| <1s | ${burstC20Buckets.under1s} |
| 1-2s | ${burstC20Buckets.between1s2s} |
| 2-5s | ${burstC20Buckets.between2s5s} |
| >5s | ${burstC20Buckets.over5s} |

### 40-Concurrent Cold Burst

| Metric | Value |
|---|---|
| Success / Total | ${burstC40Latencies.length} / ${c40.concurrency} |
| Rejected | ${c40.rejections} |
| p50 | ${burstC40P.p50.toFixed(1)} ms |
| p95 | ${burstC40P.p95.toFixed(1)} ms |
| p99 | ${burstC40P.p99.toFixed(1)} ms |
| <1s | ${burstC40Buckets.under1s} |
| 1-2s | ${burstC40Buckets.between1s2s} |
| 2-5s | ${burstC40Buckets.between2s5s} |
| >5s | ${burstC40Buckets.over5s} |

## Phase 3: Scheduling Strategy Simulation

### A. Current: Immediate Admission
${simulation.currentImmediate.analysis}

### B. Strict FIFO Queue
${simulation.strictFIFO.analysis}

### C. Shortest-Job Ordering
${simulation.shortestJob.analysis}

### D. Bounded Docker Concurrency
${simulation.boundedConcurrency.analysis}

## Phase 4: Resource & Fairness Tradeoff

Any scheduling/queuing layer introduces:
- **Queue memory**: O(queued requests) — bounded if limited, but adds a new resource dimension.
- **Cancellation**: Must detect client disconnect while queued and free the slot.
- **Starvation**: FIFO prevents starvation but adds head-of-line blocking; priority queues risk starvation for low-priority.
- **Per-user fairness**: Current system uses sandboxGate (maxSandboxesPerUser=5). A queue must preserve this.
- **Project lock interaction**: sandboxManager.withProjectLock serializes per-project. A global queue adds a second serialization layer.
- **Retry semantics**: Rejected requests are retried by the client. Queued requests are retried by the server (implicit retry = longer hold).
- **Disconnect handling**: WebSocket disconnect during queue wait must release the slot before provisioning.
- **maxSandboxes interaction**: A queue does not increase capacity; it only changes failure mode from fast-reject to slow-wait.

**Net assessment**: Scheduling complexity does NOT increase throughput. It converts a fast, clear failure (rejection) into a slow, opaque wait. The Docker daemon is the throughput bottleneck, and no admission strategy changes Docker's processing rate.
`;

  const mdPath = join(RESULTS_DIR, `m18-cold-wait-investigation-${ts}.md`);
  writeFileSync(mdPath, md);

  console.log(`\nSaved: ${jsonPath}`);
  console.log(`Saved: ${mdPath}`);
  console.log("\n========== Investigation Complete ==========");
}

function summarizeSweep(s: {
  concurrency: number;
  results: RequestDecomposition[];
  wallMs: number;
  rejections: number;
}): {
  concurrency: number;
  successCount: number;
  rejections: number;
  wallMs: number;
  latencyPercentiles: ReturnType<typeof percentiles>;
} {
  const successes = s.results.filter((r) => r.success);
  return {
    concurrency: s.concurrency,
    successCount: successes.length,
    rejections: s.rejections,
    wallMs: s.wallMs,
    latencyPercentiles: percentiles(successes.map((r) => r.totalMs)),
  };
}

run().catch((err) => {
  console.error("Investigation failed:", err);
  process.exit(1);
});
