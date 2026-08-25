// Memory-investigation milestone: bounded diagnostic script. Reuses the
// same in-process server + virtual-user harness as run.ts (real HTTP/WS,
// real SQLite, real Docker where applicable), extended with heap
// snapshots, external/arrayBuffers/GC/CPU sampling, and a post-rampdown
// observation window — none of which run.ts needed for M5/M6. Kept as a
// separate script (rather than adding flags to run.ts) so the
// already-verified M5/M6 harness file is not touched at all. Writes its
// own `memprofile-*` evidence files under load-test/results/ — never
// overlaps with or alters existing `level-*` M5/M6 evidence.
//
// Usage:
//   npx tsx load-test/memory-profile.ts --workload collab-heavy --users 40 --ramp 45 --steady 90 --rampdown 20 --observe 300 --label collab-heavy-40
//   npx tsx load-test/memory-profile.ts --workload normal       --users 40 --ramp 45 --steady 90 --rampdown 20 --observe 90  --label normal-40
//   npx tsx load-test/memory-profile.ts --workload non-collab   --users 40 --ramp 45 --steady 90 --rampdown 20 --observe 90  --label non-collab-40
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { bootstrapLoadTestServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import {
  runVirtualUser,
  runEditToPeerProbe,
  type BehaviorName,
  type VirtualUserContext,
} from "./virtualUser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Workload = "normal" | "collab-heavy" | "non-collab";

// Deliberately duplicated from run.ts's BEHAVIOR_WEIGHTS (not imported) so
// this diagnostic script can never perturb the already-verified M5/M6
// harness file.
const NORMAL_WEIGHTS: [BehaviorName, number][] = [
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

// Same shape with every collaboration behavior (anything that opens a
// /ws/collab socket: collab_pair, busy_room, many_rooms_thin, rapid_typing,
// reconnecting) removed and its weight redistributed proportionally across
// the remaining behaviors — "representative backend traffic" while
// deliberately minimizing Yjs/awareness activity, per the contract.
const NON_COLLAB_WEIGHTS: [BehaviorName, number][] = [
  ["idle", 40],
  ["active_editor", 40],
  ["execution_heavy", 12],
  ["preview_heavy", 8],
];

function buildWeightedPattern(
  weights: [BehaviorName, number][],
): BehaviorName[] {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const pattern: BehaviorName[] = [];
  const assigned = weights.map(() => 0);
  for (let slot = 1; slot <= total; slot++) {
    let bestIdx = 0;
    let bestDeficit = -Infinity;
    for (let i = 0; i < weights.length; i++) {
      const weight = weights[i][1];
      const target = (weight / total) * slot;
      const deficit = target - assigned[i];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIdx = i;
      }
    }
    assigned[bestIdx]++;
    pattern.push(weights[bestIdx][0]);
  }
  return pattern;
}

const NORMAL_PATTERN = buildWeightedPattern(NORMAL_WEIGHTS);
const NON_COLLAB_PATTERN = buildWeightedPattern(NON_COLLAB_WEIGHTS);

interface Args {
  workload: Workload;
  users: number;
  rampSec: number;
  steadySec: number;
  rampdownSec: number;
  observeSec: number;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const workload = get("--workload", "collab-heavy") as Workload;
  return {
    workload,
    users: Number(get("--users", "40")),
    rampSec: Number(get("--ramp", "45")),
    steadySec: Number(get("--steady", "90")),
    rampdownSec: Number(get("--rampdown", "20")),
    observeSec: Number(get("--observe", "90")),
    label: get("--label", workload),
  };
}

function memLine(tag: string, snap: any): string {
  const m = snap.memory;
  const cpu = snap.cpuUsageMicros;
  return (
    `[memprofile] ${tag} rss=${(m.rssBytes / 1e6).toFixed(1)}MB ` +
    `heapUsed=${(m.heapUsedBytes / 1e6).toFixed(1)}MB heapTotal=${(m.heapTotalBytes / 1e6).toFixed(1)}MB ` +
    `external=${(m.externalBytes / 1e6).toFixed(1)}MB arrayBuffers=${(m.arrayBuffersBytes / 1e6).toFixed(1)}MB ` +
    `ws=${snap.activeWsConnections} rooms=${snap.activeCollabRooms} sandboxes=${snap.activeSandboxes} ` +
    `cpuUserMs=${(cpu.userMicros / 1000).toFixed(0)} cpuSysMs=${(cpu.systemMicros / 1000).toFixed(0)} ` +
    `gc=${JSON.stringify(snap.gc)}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[memprofile] workload=${args.workload} users=${args.users} ramp=${args.rampSec}s ` +
      `steady=${args.steadySec}s rampdown=${args.rampdownSec}s observe=${args.observeSec}s`,
  );

  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const heapDir = join(resultsDir, `memprofile-heap-${args.label}-${stamp}`);

  const server = await bootstrapLoadTestServer({
    authRateLimit: { max: 100_000, windowMs: 60_000 },
  });
  console.log(`[memprofile] server up at ${server.baseUrl}`);

  const metrics = new MetricsCollector();
  const controller = new AbortController();

  const heapSnapshots: { tag: string; atSec: number; file: string }[] = [];
  const takeHeap = (tag: string, atSec: number) => {
    mkdirSync(heapDir, { recursive: true });
    const before = Date.now();
    const file = writeHeapSnapshot(join(heapDir, `${tag}.heapsnapshot`));
    const tookMs = Date.now() - before;
    heapSnapshots.push({ tag, atSec, file });
    console.log(
      `[memprofile] heap snapshot '${tag}' written (${tookMs}ms, blocks event loop): ${file}`,
    );
  };

  // Only the collab-heavy workload gets the full heap-snapshot treatment —
  // it is the arm already known (from M6 evidence) to grow; keeping
  // snapshot count bounded per the contract's instruction.
  const takeHeapSnapshots = args.workload === "collab-heavy";
  if (takeHeapSnapshots) takeHeap("baseline", 0);

  const sharedProjectIds: string[] = [];
  let seedToken = "";
  {
    const reg = (await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `memprofile_seed_${Date.now()}`,
        password: "load-test-password-1234",
      }),
    }).then((r) => r.json())) as { token: string };
    seedToken = reg.token;
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

  const startedAt = Date.now();
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

  const vus: Promise<void>[] = [];
  const rampMsPerUser = (args.rampSec * 1000) / Math.max(1, args.users);
  for (let i = 0; i < args.users; i++) {
    let behavior: BehaviorName;
    let presetToken: string | undefined;
    if (args.workload === "collab-heavy") {
      // Same shape as M6's --collab-only: every VU is rapid_typing,
      // concentrated on sharedProjectIds[0], authenticated as the seed
      // owner so /ws/collab's requireProjectAccess() passes for every VU.
      behavior = "rapid_typing";
      presetToken = seedToken;
    } else if (args.workload === "non-collab") {
      behavior = NON_COLLAB_PATTERN[i % NON_COLLAB_PATTERN.length];
    } else {
      behavior = NORMAL_PATTERN[i % NORMAL_PATTERN.length];
    }
    const ctx: VirtualUserContext = {
      baseUrl: server.baseUrl,
      wsBase: server.wsBase,
      metrics,
      signal: controller.signal,
      vuIndex: i,
      sharedProjectIds,
    };
    vus.push(runVirtualUser(behavior, ctx, presetToken).catch(() => {}));
    await new Promise((r) => setTimeout(r, rampMsPerUser));
  }
  console.log(`[memprofile] ramp-up complete, holding steady state`);

  await new Promise((r) => setTimeout(r, (args.steadySec * 1000) / 2));
  if (takeHeapSnapshots) {
    takeHeap("mid-run", Math.round((Date.now() - startedAt) / 1000));
  }
  console.log(memLine("mid-run", server.snapshot()));

  await new Promise((r) => setTimeout(r, (args.steadySec * 1000) / 2));
  if (takeHeapSnapshots) {
    takeHeap("peak", Math.round((Date.now() - startedAt) / 1000));
  }
  console.log(memLine("peak", server.snapshot()));

  console.log(`[memprofile] ramping down`);
  const rampdownStart = Date.now();
  controller.abort();
  await Promise.race([
    Promise.allSettled(vus),
    new Promise((r) => setTimeout(r, args.rampdownSec * 1000)),
  ]);
  const rampdownMs = Date.now() - rampdownStart;
  console.log(memLine("immediately-post-rampdown", server.snapshot()));

  console.log(`[memprofile] observing for ${args.observeSec}s post-rampdown`);
  const observeStart = Date.now();
  while (Date.now() - observeStart < args.observeSec * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = server.snapshot();
    snapshots.push({
      atSec: Math.round((Date.now() - startedAt) / 1000),
      snapshot: s,
    });
    console.log(
      memLine(
        `+${Math.round((Date.now() - observeStart) / 1000)}s post-rampdown`,
        s,
      ),
    );
  }
  clearInterval(snapshotTimer);

  if (takeHeapSnapshots) {
    takeHeap("post-rampdown", Math.round((Date.now() - startedAt) / 1000));
  }

  const finalSnapshot = server.snapshot();
  const report = {
    workload: args.workload,
    args,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    rampdownMs,
    metrics: metrics.report(),
    observabilitySnapshots: snapshots,
    finalObservabilitySnapshot: finalSnapshot,
    heapSnapshots,
  };

  const jsonPath = join(resultsDir, `memprofile-${args.label}-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const mdPath = join(resultsDir, `memprofile-${args.label}-${stamp}.md`);
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(`[memprofile] wrote ${jsonPath}`);
  console.log(`[memprofile] wrote ${mdPath}`);

  await server.close();
}

export function renderMarkdown(report: any): string {
  const lines: string[] = [];
  lines.push(`# Memory profile — ${report.workload} (${report.args.label})`);
  lines.push("");
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(
    `- Args: users=${report.args.users} ramp=${report.args.rampSec}s steady=${report.args.steadySec}s ` +
      `rampdown=${report.args.rampdownSec}s observe=${report.args.observeSec}s`,
  );
  lines.push(
    `- Total duration (incl. observation window): ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push(`- Rampdown wall time: ${(report.rampdownMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## Heap snapshots");
  lines.push("");
  if (report.heapSnapshots.length === 0) {
    lines.push("(none taken for this workload — see script comments)");
  } else {
    for (const h of report.heapSnapshots) {
      lines.push(`- ${h.tag} (t=${h.atSec}s): ${h.file}`);
    }
  }
  lines.push("");
  lines.push(
    "## Observability over time (sampled every 5s; ws/rooms/sandboxes/memory/cpu/gc)",
  );
  lines.push("");
  lines.push(
    "| t(s) | rss MB | heapUsed MB | heapTotal MB | external MB | arrayBuffers MB | ws | rooms | sandboxes | evloop p99ms | gc major | gc minor |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { atSec, snapshot } of report.observabilitySnapshots as any[]) {
    const m = snapshot.memory;
    const gcMajor = snapshot.gc.major?.count ?? 0;
    const gcMinor = snapshot.gc.minor?.count ?? 0;
    lines.push(
      `| ${atSec} | ${(m.rssBytes / 1e6).toFixed(1)} | ${(m.heapUsedBytes / 1e6).toFixed(1)} | ` +
        `${(m.heapTotalBytes / 1e6).toFixed(1)} | ${(m.externalBytes / 1e6).toFixed(1)} | ` +
        `${(m.arrayBuffersBytes / 1e6).toFixed(1)} | ${snapshot.activeWsConnections} | ` +
        `${snapshot.activeCollabRooms} | ${snapshot.activeSandboxes} | ` +
        `${snapshot.eventLoopLagMs?.p99Ms.toFixed(1) ?? "-"} | ${gcMajor} | ${gcMinor} |`,
    );
  }
  lines.push("");
  lines.push(
    "Full raw per-sample data (including per-GC-kind breakdowns and cpuUsage) is in the sibling `.json` file.",
  );
  return lines.join("\n");
}

main().catch((err) => {
  console.error("[memprofile] fatal error:", err);
  process.exit(1);
});
