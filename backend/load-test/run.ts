// M5a load harness CLI. Boots a real in-process backend instance, ramps a
// weighted mix of virtual users per the Milestone 5 architecture report's
// §5 behavior model, holds steady state, ramps down, and writes a bounded
// JSON + Markdown evidence report to load-test/results/.
//
// Usage:
//   npx tsx load-test/run.ts --level 1  --users 1  --ramp 30 --steady 60  --rampdown 15
//   npx tsx load-test/run.ts --level 10 --users 10 --ramp 30 --steady 90  --rampdown 15
//   npx tsx load-test/run.ts --level 50 --users 50 --ramp 30 --steady 120 --rampdown 15
//   npx tsx load-test/run.ts --level 50-burst --users 50 --burst --steady 30
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapLoadTestServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import {
  runVirtualUser,
  runEditToPeerProbe,
  type BehaviorName,
  type VirtualUserContext,
} from "./virtualUser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Approximates the architecture report's §5 weighted behavior mix.
// "save_burst" / "project_startup_burst" are handled separately (--burst
// mode spawns everyone into execution_heavy/active_editor simultaneously
// with zero ramp, rather than being a steady-state weight).
const BEHAVIOR_WEIGHTS: [BehaviorName, number][] = [
  ["idle", 25],
  ["active_editor", 30],
  ["collab_pair", 10],
  ["busy_room", 5],
  ["many_rooms_thin", 15],
  ["execution_heavy", 5],
  ["preview_heavy", 3],
  ["reconnecting", 3],
  ["rapid_typing", 2],
];
const TOTAL_WEIGHT = BEHAVIOR_WEIGHTS.reduce((s, [, w]) => s + w, 0);

/**
 * Smooth weighted round-robin: at each slot, pick whichever behavior is
 * furthest behind its proportional share so far. This spreads behaviors
 * evenly through the sequence — unlike a "blocked" [25 idle, 30 active, ...]
 * array indexed by vuIndex % TOTAL_WEIGHT, which would make the first 25 VUs
 * of ANY run all "idle" regardless of total user count. Deterministic and
 * reproducible from (users, vuIndex) alone — no RNG.
 */
function buildWeightedPattern(): BehaviorName[] {
  const pattern: BehaviorName[] = [];
  const assigned = BEHAVIOR_WEIGHTS.map(() => 0);
  for (let slot = 1; slot <= TOTAL_WEIGHT; slot++) {
    let bestIdx = 0;
    let bestDeficit = -Infinity;
    for (let i = 0; i < BEHAVIOR_WEIGHTS.length; i++) {
      const weight = BEHAVIOR_WEIGHTS[i][1];
      const target = (weight / TOTAL_WEIGHT) * slot;
      const deficit = target - assigned[i];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIdx = i;
      }
    }
    assigned[bestIdx]++;
    pattern.push(BEHAVIOR_WEIGHTS[bestIdx][0]);
  }
  return pattern;
}
const WEIGHTED_PATTERN = buildWeightedPattern();

function pickBehavior(vuIndex: number): BehaviorName {
  return WEIGHTED_PATTERN[vuIndex % WEIGHTED_PATTERN.length];
}

interface Args {
  level: string;
  users: number;
  rampSec: number;
  steadySec: number;
  rampdownSec: number;
  burst: boolean;
  /**
   * Overrides the default per-IP auth rate limit (register/login share one
   * bucket keyed by req.ip). Only meaningful because this harness runs every
   * virtual user from one process on one host, so every VU shares the exact
   * same source IP — a same-IP burst the real production rate limiter is
   * correctly designed to reject, but which is a harness-topology artifact,
   * not evidence about how N users on N distinct real IPs would behave.
   * Defaults to unset (real production default), so the default run reports
   * genuine default-config behavior; pass --relax-auth-rate-limit to get a
   * second, explicitly-labeled data point isolating the other subsystems.
   */
  relaxAuthRateLimit: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    level: get("--level", "1"),
    users: Number(get("--users", "1")),
    rampSec: Number(get("--ramp", "30")),
    steadySec: Number(get("--steady", "60")),
    rampdownSec: Number(get("--rampdown", "15")),
    burst: argv.includes("--burst"),
    relaxAuthRateLimit: argv.includes("--relax-auth-rate-limit"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[load-test] level=${args.level} users=${args.users} burst=${args.burst} ` +
      `ramp=${args.rampSec}s steady=${args.steadySec}s rampdown=${args.rampdownSec}s`,
  );

  const server = await bootstrapLoadTestServer(
    args.relaxAuthRateLimit
      ? { authRateLimit: { max: 100_000, windowMs: 60_000 } }
      : {},
  );
  console.log(`[load-test] server up at ${server.baseUrl}`);

  const metrics = new MetricsCollector();
  const controller = new AbortController();

  // Pre-create a small pool of shared projects so "busy_room" and
  // "rapid_typing" VUs concentrate into the same rooms instead of each
  // getting their own — this is what actually produces O(n) fan-out
  // pressure rather than N trivial 1-person rooms.
  const sharedProjectIds: string[] = [];
  {
    const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `loadtest_seed_${Date.now()}`,
        password: "load-test-password-1234",
      }),
    }).then((r) => r.json())) as { token: string };
    for (
      let i = 0;
      i < Math.min(3, Math.max(1, Math.ceil(args.users / 20)));
      i++
    ) {
      const proj = (await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${reg.token}`,
        },
        body: JSON.stringify({ name: `shared-room-${i}` }),
      }).then((r) => r.json())) as { project?: { id: string } };
      if (proj?.project?.id) sharedProjectIds.push(proj.project.id);
    }

    // Dedicated edit-to-peer latency probe, running for the whole test.
    if (sharedProjectIds[0]) {
      const stopProbe = await runEditToPeerProbe(
        {
          baseUrl: server.baseUrl,
          wsBase: server.wsBase,
          metrics,
          signal: controller.signal,
          vuIndex: -1,
          sharedProjectIds,
        },
        reg.token,
        sharedProjectIds[0],
      );
      controller.signal.addEventListener("abort", stopProbe);
    }
  }

  const snapshots: {
    atSec: number;
    snapshot: ReturnType<typeof server.snapshot>;
  }[] = [];
  const snapshotTimer = setInterval(() => {
    snapshots.push({
      atSec: Math.round((Date.now() - startedAt) / 1000),
      snapshot: server.snapshot(),
    });
  }, 5000);

  const startedAt = Date.now();
  const vus: Promise<void>[] = [];

  if (args.burst) {
    // Zero ramp: every VU starts at once, targeting either a fresh project
    // create+run (project-startup burst) or a save (save-cluster burst) —
    // alternate so both burst scenarios from the report get real evidence
    // in one pass.
    for (let i = 0; i < args.users; i++) {
      const behavior: BehaviorName =
        i % 2 === 0 ? "execution_heavy" : "active_editor";
      const ctx: VirtualUserContext = {
        baseUrl: server.baseUrl,
        wsBase: server.wsBase,
        metrics,
        signal: controller.signal,
        vuIndex: i,
        sharedProjectIds,
      };
      vus.push(runVirtualUser(behavior, ctx).catch(() => {}));
    }
    await new Promise((r) => setTimeout(r, args.steadySec * 1000));
  } else {
    const rampMsPerUser = (args.rampSec * 1000) / Math.max(1, args.users);
    for (let i = 0; i < args.users; i++) {
      const behavior = pickBehavior(i);
      const ctx: VirtualUserContext = {
        baseUrl: server.baseUrl,
        wsBase: server.wsBase,
        metrics,
        signal: controller.signal,
        vuIndex: i,
        sharedProjectIds,
      };
      vus.push(runVirtualUser(behavior, ctx).catch(() => {}));
      await new Promise((r) => setTimeout(r, rampMsPerUser));
    }
    console.log(`[load-test] ramp-up complete, holding steady state`);
    await new Promise((r) => setTimeout(r, args.steadySec * 1000));
  }

  console.log(`[load-test] ramping down`);
  const rampdownStart = Date.now();
  controller.abort();
  await Promise.race([
    Promise.allSettled(vus),
    new Promise((r) => setTimeout(r, args.rampdownSec * 1000)),
  ]);
  clearInterval(snapshotTimer);
  const rampdownMs = Date.now() - rampdownStart;

  const finalSnapshot = server.snapshot();
  const report = {
    level: args.level,
    args,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    rampdownMs,
    metrics: metrics.report(),
    observabilitySnapshots: snapshots,
    finalObservabilitySnapshot: finalSnapshot,
  };

  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(resultsDir, `level-${args.level}-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const mdPath = join(resultsDir, `level-${args.level}-${stamp}.md`);
  writeFileSync(mdPath, renderMarkdown(report));

  console.log(`[load-test] wrote ${jsonPath}`);
  console.log(`[load-test] wrote ${mdPath}`);

  await server.close();
}

export function renderMarkdown(report: any): string {
  const lines: string[] = [];
  lines.push(`# Load test — level ${report.level}`);
  lines.push("");
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(
    `- Args: users=${report.args.users} ramp=${report.args.rampSec}s steady=${report.args.steadySec}s rampdown=${report.args.rampdownSec}s burst=${report.args.burst}`,
  );
  lines.push(`- Total duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Rampdown wall time: ${(report.rampdownMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## Per-endpoint-class latency and outcomes");
  lines.push("");
  lines.push(
    "| class | count | p50ms | p95ms | p99ms | success | quota_reject | timeout | conn_fail | crash |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const [cls, data] of Object.entries<any>(
    report.metrics.byEndpointClass,
  )) {
    const l = data.latency;
    const o = data.outcomes;
    lines.push(
      `| ${cls} | ${l.count} | ${l.p50Ms.toFixed(1)} | ${l.p95Ms.toFixed(1)} | ${l.p99Ms.toFixed(1)} | ${o.success} | ${o.clean_quota_rejection} | ${o.timeout} | ${o.connection_failure} | ${o.crash} |`,
    );
  }
  lines.push("");
  lines.push("## Save round-trip latency / collab edit-to-peer latency");
  lines.push("");
  lines.push("| metric | count | p50ms | p95ms | p99ms |");
  lines.push("|---|---|---|---|---|");
  const sl = report.metrics.saveLatency;
  const cl = report.metrics.collabEditToPeerLatency;
  lines.push(
    `| save round-trip | ${sl.count} | ${sl.p50Ms.toFixed(1)} | ${sl.p95Ms.toFixed(1)} | ${sl.p99Ms.toFixed(1)} |`,
  );
  lines.push(
    `| collab edit-to-peer | ${cl.count} | ${cl.p50Ms.toFixed(1)} | ${cl.p95Ms.toFixed(1)} | ${cl.p99Ms.toFixed(1)} |`,
  );
  lines.push("");
  lines.push("## Final observability snapshot");
  lines.push("");
  const fs = report.finalObservabilitySnapshot;
  lines.push(
    `- Event-loop lag: p50=${fs.eventLoopLagMs?.p50Ms.toFixed(1)}ms p95=${fs.eventLoopLagMs?.p95Ms.toFixed(1)}ms p99=${fs.eventLoopLagMs?.p99Ms.toFixed(1)}ms mean=${fs.eventLoopLagMs?.meanMs.toFixed(1)}ms`,
  );
  lines.push(
    `- DB calls overall: count=${fs.dbCalls.overall.count} p50=${fs.dbCalls.overall.p50Ms.toFixed(3)}ms p95=${fs.dbCalls.overall.p95Ms.toFixed(3)}ms p99=${fs.dbCalls.overall.p99Ms.toFixed(3)}ms`,
  );
  lines.push(`- Active WS connections: ${fs.activeWsConnections}`);
  lines.push(`- Active collab rooms: ${fs.activeCollabRooms}`);
  lines.push(`- Active sandboxes: ${fs.activeSandboxes}`);
  lines.push(`- Process RSS: ${(fs.memory.rssBytes / 1e6).toFixed(1)} MB`);
  lines.push("");
  lines.push("### DB calls by operation");
  lines.push("");
  lines.push("| operation | count | p50ms | p95ms | p99ms |");
  lines.push("|---|---|---|---|---|");
  for (const [op, data] of Object.entries<any>(fs.dbCalls.byOperation)) {
    lines.push(
      `| ${op} | ${data.count} | ${data.p50Ms.toFixed(3)} | ${data.p95Ms.toFixed(3)} | ${data.p99Ms.toFixed(3)} |`,
    );
  }
  lines.push("");
  lines.push(
    "## Observability over time (event-loop lag p99 / DB p99 / gauges, sampled every 5s)",
  );
  lines.push("");
  lines.push(
    "| t(s) | evloop p99ms | db p99ms | ws conns | rooms | sandboxes | rss MB |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const { atSec, snapshot } of report.observabilitySnapshots as any[]) {
    lines.push(
      `| ${atSec} | ${snapshot.eventLoopLagMs?.p99Ms.toFixed(1) ?? "-"} | ${snapshot.dbCalls.overall.p99Ms.toFixed(3)} | ${snapshot.activeWsConnections} | ${snapshot.activeCollabRooms} | ${snapshot.activeSandboxes} | ${(snapshot.memory.rssBytes / 1e6).toFixed(1)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Full raw per-sample data (including per-operation DB breakdowns at each sample point) is in the sibling `.json` file for this run.",
  );
  return lines.join("\n");
}

main().catch((err) => {
  console.error("[load-test] fatal error:", err);
  process.exit(1);
});
