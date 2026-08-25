// M5a: minimal, dependency-free performance instrumentation.
//
// Deliberately built entirely on Node's built-in `node:perf_hooks` histogram
// primitives (the same native mechanism `monitorEventLoopDelay` itself uses)
// instead of any external metrics library — this is a load-test evidence
// layer, not production telemetry infrastructure. All state here is
// in-memory, unauthenticated by itself, and only ever reachable through the
// existing admin-gated `/api/admin` router (see admin/routes.ts).
import {
  monitorEventLoopDelay,
  createHistogram,
  PerformanceObserver,
  constants as perfConstants,
  type IntervalHistogram,
  type RecordableHistogram,
} from "node:perf_hooks";
import type { Db } from "./db.js";

// --- Event-loop lag ---------------------------------------------------

let eventLoopMonitor: IntervalHistogram | null = null;

/** Idempotent: safe to call more than once (e.g. across test setup). */
export function startEventLoopMonitor(): void {
  if (eventLoopMonitor) return;
  eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
  eventLoopMonitor.enable();
}

export function stopEventLoopMonitor(): void {
  eventLoopMonitor?.disable();
  eventLoopMonitor = null;
}

// --- GC pauses (memory-investigation milestone: attribution evidence only,
// no GC flags/tuning) -------------------------------------------------------

export interface GcKindStats {
  count: number;
  totalDurationMs: number;
}

const GC_KIND_LABELS: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

let gcObserver: PerformanceObserver | null = null;
const gcStatsByKind = new Map<string, GcKindStats>();

/** Idempotent, like startEventLoopMonitor. Uses Node's built-in GC
 *  perf_hooks entries — no `--expose-gc` or GC flag required. */
export function startGcObserver(): void {
  if (gcObserver) return;
  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const label = GC_KIND_LABELS[(entry as any).kind] ?? "unknown";
      const stats = gcStatsByKind.get(label) ?? {
        count: 0,
        totalDurationMs: 0,
      };
      stats.count++;
      stats.totalDurationMs += entry.duration;
      gcStatsByKind.set(label, stats);
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
}

export function stopGcObserver(): void {
  gcObserver?.disconnect();
  gcObserver = null;
}

// --- DB call timing -----------------------------------------------------

export interface LatencySnapshot {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function summarizeHistogram(h: RecordableHistogram): LatencySnapshot {
  return {
    count: h.count,
    minMs: h.count === 0 ? 0 : h.min / 1e6,
    maxMs: h.count === 0 ? 0 : h.max / 1e6,
    meanMs: h.count === 0 ? 0 : h.mean / 1e6,
    p50Ms: h.count === 0 ? 0 : h.percentile(50) / 1e6,
    p95Ms: h.count === 0 ? 0 : h.percentile(95) / 1e6,
    p99Ms: h.count === 0 ? 0 : h.percentile(99) / 1e6,
  };
}

// Table x verb combinations are inherently bounded by the fixed schema
// (~11 tables x ~7 verbs) — this cap is a defensive ceiling, not something
// real traffic is expected to approach. Anything beyond it folds into the
// overall histogram only, so label cardinality can never grow unboundedly.
const MAX_DB_LABELS = 128;
const dbHistogramsByLabel = new Map<string, RecordableHistogram>();
const dbOverallHistogram = createHistogram();

function getOrCreateLabelHistogram(label: string): RecordableHistogram | null {
  let h = dbHistogramsByLabel.get(label);
  if (h) return h;
  if (dbHistogramsByLabel.size >= MAX_DB_LABELS) return null;
  h = createHistogram();
  dbHistogramsByLabel.set(label, h);
  return h;
}

function recordDbCall(label: string, elapsedNs: number): void {
  const ns = Math.max(1, Math.round(elapsedNs));
  dbOverallHistogram.record(ns);
  getOrCreateLabelHistogram(label)?.record(ns);
}

/** Exported for tests; not sophisticated SQL parsing, just a bounded label. */
export function labelForSql(sql: string): string {
  const verbMatch =
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i.exec(
      sql,
    );
  const verb = verbMatch ? verbMatch[1].toUpperCase() : "OTHER";
  const tableMatch =
    /\b(?:FROM|INTO|UPDATE|TABLE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(sql);
  const table = tableMatch ? tableMatch[1].toLowerCase() : "";
  return table ? `${verb} ${table}` : verb;
}

/**
 * Wraps `db.prepare` in place so every statement's run/get/all call is timed
 * and bucketed by a bounded operation label, without changing DB behavior —
 * the original prepare/run/get/all implementations are still what actually
 * execute; this only measures around them. Applied once, centrally, at the
 * single point the real production `Db` is constructed (see index.ts) — no
 * call site anywhere else in the codebase needs to change.
 */
export function instrumentDb(db: Db): Db {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql) as unknown as Record<string, unknown>;
    const label = labelForSql(sql);
    for (const method of ["run", "get", "all"] as const) {
      const original = stmt[method];
      if (typeof original !== "function") continue;
      const boundOriginal = (original as (...a: unknown[]) => unknown).bind(
        stmt,
      );
      stmt[method] = (...args: unknown[]) => {
        const start = process.hrtime.bigint();
        try {
          return boundOriginal(...args);
        } finally {
          recordDbCall(label, Number(process.hrtime.bigint() - start));
        }
      };
    }
    return stmt;
  }) as unknown as Db["prepare"];
  return db;
}

// --- Snapshot -------------------------------------------------------------

export interface ObservabilitySnapshot {
  timestamp: string;
  eventLoopLagMs: {
    minMs: number;
    maxMs: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } | null;
  dbCalls: {
    overall: LatencySnapshot;
    byOperation: Record<string, LatencySnapshot>;
  };
  activeWsConnections: number;
  activeCollabRooms: number;
  activeSandboxes: number;
  /** M6: physical WS broadcast sends across every active collab room —
   *  the metric that demonstrates coalescing actually reduces message
   *  volume, not just theoretically. */
  totalCollabBroadcastSends: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    /** Native/off-heap memory (Buffers, sockets, etc.) — from
     *  process.memoryUsage().external. Memory-investigation attribution
     *  evidence: distinguishes JS heap growth from native/buffer growth. */
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  /** Cumulative since process start (node:process.cpuUsage()) — callers
   *  compute deltas between samples for point-in-time CPU utilization. */
  cpuUsageMicros: { userMicros: number; systemMicros: number };
  /** Cumulative GC pause count/duration by kind since startGcObserver() was
   *  called (or since the last resetObservabilityForTests()). */
  gc: Record<string, GcKindStats>;
}

export interface ObservabilityDeps {
  activeConnectionCount: () => number;
  getActiveRoomCount: () => number;
  getActiveSandboxCount: () => number;
  getTotalCollabBroadcastSends: () => number;
}

export function getObservabilitySnapshot(
  deps: ObservabilityDeps,
): ObservabilitySnapshot {
  const mem = process.memoryUsage();
  const byOperation: Record<string, LatencySnapshot> = {};
  for (const [label, h] of dbHistogramsByLabel) {
    byOperation[label] = summarizeHistogram(h);
  }
  return {
    timestamp: new Date().toISOString(),
    eventLoopLagMs: eventLoopMonitor
      ? {
          minMs: eventLoopMonitor.min / 1e6,
          maxMs: eventLoopMonitor.max / 1e6,
          meanMs: eventLoopMonitor.mean / 1e6,
          p50Ms: eventLoopMonitor.percentile(50) / 1e6,
          p95Ms: eventLoopMonitor.percentile(95) / 1e6,
          p99Ms: eventLoopMonitor.percentile(99) / 1e6,
        }
      : null,
    dbCalls: { overall: summarizeHistogram(dbOverallHistogram), byOperation },
    activeWsConnections: deps.activeConnectionCount(),
    activeCollabRooms: deps.getActiveRoomCount(),
    activeSandboxes: deps.getActiveSandboxCount(),
    totalCollabBroadcastSends: deps.getTotalCollabBroadcastSends(),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
    },
    cpuUsageMicros: (() => {
      const cpu = process.cpuUsage();
      return { userMicros: cpu.user, systemMicros: cpu.system };
    })(),
    gc: Object.fromEntries(gcStatsByKind),
  };
}

/** Test-only: reset all in-memory histograms/labels between test cases. */
export function resetObservabilityForTests(): void {
  eventLoopMonitor?.reset();
  dbOverallHistogram.reset();
  dbHistogramsByLabel.clear();
  gcStatsByKind.clear();
}
