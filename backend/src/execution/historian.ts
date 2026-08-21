import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { ContainerStats, SandboxManager } from './sandbox.js';
import { randomUUID } from 'node:crypto';

export interface TelemetryRecord {
  id?: number;
  projectId: string;
  sandboxId: string;
  executionId?: string | null;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  createdAt: string;
}

export interface TelemetrySummary {
  avgCpuPercent: number;
  peakCpuPercent: number;
  avgMemoryBytes: number;
  peakMemoryBytes: number;
  memoryLimitBytes: number;
  peakPids: number;
  totalNetworkRxBytes: number;
  totalNetworkTxBytes: number;
  totalBlockReadBytes: number;
  totalBlockWriteBytes: number;
  sampleCount: number;
}

export interface AnomalyRecord {
  id: string;
  projectId: string;
  sandboxId?: string | null;
  executionId?: string | null;
  anomalyType:
    | 'high_cpu'
    | 'memory_pressure'
    | 'pid_pressure'
    | 'long_execution'
    | 'repeated_failure'
    | 'sandbox_churn';
  severity: 'warning' | 'critical';
  title: string;
  reason: string;
  details: string;
  status: 'active' | 'resolved';
  createdAt: string;
  resolvedAt?: string | null;
}

export interface ProjectHealthStatus {
  status: 'healthy' | 'warning' | 'critical';
  score: number; // 0 - 100
  summary: string;
  runtime: {
    sandboxRunning: boolean;
    currentCpuPercent: number;
    currentMemoryBytes: number;
    currentPids: number;
  };
  usage: {
    executionsToday: number;
    totalDurationMsToday: number;
    snapshotCount: number;
  };
  anomalies: AnomalyRecord[];
  failureRatePercent: number;
}

/**
 * High-performance, bounded in-memory ring buffer for recent hot telemetry samples.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private capacity: number;
  private head = 0;
  private size = 0;

  constructor(capacity = 120) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  getAll(): T[] {
    const result: T[] = [];
    if (this.size === 0) return result;
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      const idx = (start + i) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

export class TelemetryHistorian {
  private static instance: TelemetryHistorian;
  private db: Db | null = null;
  private cfg: AppConfig | null = null;
  private sandboxManager = SandboxManager.getInstance();

  // Bounded In-Memory Hot Buffers (per project + platform aggregate)
  private hotBuffers = new Map<string, RingBuffer<TelemetryRecord>>();
  private aggregateHotBuffer = new RingBuffer<{
    timestamp: string;
    aggregateCpuPercent: number;
    aggregateMemoryBytes: number;
    activeSandboxes: number;
    activePids: number;
  }>(180);

  // Write Batching Queue
  private writeQueue: TelemetryRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;

  // Active Executions Map (projectId -> executionId)
  private activeExecutions = new Map<string, { executionId: string; startTime: number }>();

  // State tracking for Anomaly Engine
  private highCpuStreaks = new Map<string, number>(); // projectId -> consecutive seconds over threshold

  private constructor() {}

  public static getInstance(): TelemetryHistorian {
    if (!TelemetryHistorian.instance) {
      TelemetryHistorian.instance = new TelemetryHistorian();
    }
    return TelemetryHistorian.instance;
  }

  public init(db: Db, cfg: AppConfig): void {
    this.db = db;
    this.cfg = cfg;

    this.startBackgroundTasks();
  }

  public trackExecutionStart(projectId: string, executionId: string): void {
    this.activeExecutions.set(projectId, { executionId, startTime: Date.now() });
  }

  public trackExecutionEnd(projectId: string, executionId: string): void {
    const active = this.activeExecutions.get(projectId);
    if (active && active.executionId === executionId) {
      this.activeExecutions.delete(projectId);
    }
  }

  /**
   * Ingests a new telemetry sample for a project sandbox.
   */
  public recordSample(
    projectId: string,
    sandboxId: string,
    stats: ContainerStats,
    customTime?: string
  ): TelemetryRecord {
    const now = customTime || new Date().toISOString();
    const activeExec = this.activeExecutions.get(projectId);

    // Parse cumulative/rate network and block I/O strings
    const { rxBytes, txBytes } = parseNetIO(stats.netIO);
    const { readBytes, writeBytes } = parseBlockIO(stats.blockIO);

    const record: TelemetryRecord = {
      projectId,
      sandboxId,
      executionId: activeExec?.executionId || null,
      cpuPercent: Math.max(0, stats.cpuPercent),
      memoryUsageBytes: stats.memoryUsageBytes,
      memoryLimitBytes: stats.memoryLimitBytes || 536870912,
      pids: stats.pids,
      networkRxBytes: rxBytes,
      networkTxBytes: txBytes,
      blockReadBytes: readBytes,
      blockWriteBytes: writeBytes,
      createdAt: now,
    };

    // 1. Append to In-Memory Hot Buffer (instant sub-millisecond chart feeds)
    let buffer = this.hotBuffers.get(projectId);
    if (!buffer) {
      buffer = new RingBuffer<TelemetryRecord>(180);
      this.hotBuffers.set(projectId, buffer);
    }
    buffer.push(record);

    // 2. Queue for Batched DB Persistence
    this.writeQueue.push(record);
    if (this.writeQueue.length >= 100) {
      this.flushQueue();
    }

    // 3. Evaluate Lightweight Anomaly Rules
    this.evaluateAnomalies(projectId, sandboxId, record, activeExec);

    return record;
  }

  /**
   * Flushes batched telemetry records into SQLite in a single transaction.
   */
  public flushQueue(): void {
    if (!this.db || this.writeQueue.length === 0) return;

    const toWrite = [...this.writeQueue];
    this.writeQueue = [];

    try {
      this.db.exec('BEGIN TRANSACTION;');
      const stmt = this.db.prepare(`
        INSERT INTO telemetry_samples (
          project_id, sandbox_id, execution_id, cpu_percent,
          memory_usage_bytes, memory_limit_bytes, pids,
          network_rx_bytes, network_tx_bytes, block_read_bytes, block_write_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of toWrite) {
        stmt.run(
          item.projectId,
          item.sandboxId,
          item.executionId || null,
          item.cpuPercent,
          item.memoryUsageBytes,
          item.memoryLimitBytes,
          item.pids,
          item.networkRxBytes,
          item.networkTxBytes,
          item.blockReadBytes,
          item.blockWriteBytes,
          item.createdAt
        );
      }
      this.db.exec('COMMIT;');
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      console.error('[TelemetryHistorian] Error flushing batched telemetry:', err.message);
    }
  }

  /**
   * Evaluates explainable, deterministic heuristic anomaly rules.
   */
  private evaluateAnomalies(
    projectId: string,
    sandboxId: string,
    sample: TelemetryRecord,
    activeExec?: { executionId: string; startTime: number }
  ): void {
    if (!this.db) return;

    // Rule 1: High CPU Usage (>85% for >= 10 seconds)
    const currentStreak = (this.highCpuStreaks.get(projectId) || 0) + 1;
    if (sample.cpuPercent >= 85) {
      this.highCpuStreaks.set(projectId, currentStreak);
      if (currentStreak >= 5) {
        // Sampled every 2s -> 5 samples = ~10s
        this.createOrUpdateAnomaly({
          projectId,
          sandboxId,
          executionId: sample.executionId,
          anomalyType: 'high_cpu',
          severity: 'warning',
          title: 'High CPU Utilization Detected',
          reason: `Sandbox sustained ${sample.cpuPercent.toFixed(1)}% CPU utilization across multiple sampling intervals.`,
          details: 'Possible causes: sustained compute loop or intense compilation workload.',
        });
      }
    } else {
      this.highCpuStreaks.set(projectId, 0);
    }

    // Rule 2: Memory Pressure (>85% of limit)
    const memPercent = (sample.memoryUsageBytes / sample.memoryLimitBytes) * 100;
    if (memPercent >= 85) {
      this.createOrUpdateAnomaly({
        projectId,
        sandboxId,
        executionId: sample.executionId,
        anomalyType: 'memory_pressure',
        severity: memPercent >= 95 ? 'critical' : 'warning',
        title: 'Sandbox Memory Pressure',
        reason: `Memory consumption reached ${formatBytes(sample.memoryUsageBytes)} (${memPercent.toFixed(1)}% of ${formatBytes(sample.memoryLimitBytes)} limit).`,
        details: 'Approaching container memory ceiling. Risk of OOM termination if allocation continues.',
      });
    }

    // Rule 3: Process / PID Pressure (>50 PIDs near limit 64)
    if (sample.pids >= 50) {
      this.createOrUpdateAnomaly({
        projectId,
        sandboxId,
        executionId: sample.executionId,
        anomalyType: 'pid_pressure',
        severity: sample.pids >= 58 ? 'critical' : 'warning',
        title: 'Elevated Process Count',
        reason: `Active process count reached ${sample.pids} PIDs (limit is 64).`,
        details: 'Possible causes: fork bombing, unbounded subprocess spawning, or orphan worker threads.',
      });
    }

    // Rule 4: Long-Running Execution (>45s)
    if (activeExec && Date.now() - activeExec.startTime > 45_000) {
      this.createOrUpdateAnomaly({
        projectId,
        sandboxId,
        executionId: activeExec.executionId,
        anomalyType: 'long_execution',
        severity: 'warning',
        title: 'Long-Running Process Execution',
        reason: `Execution ${activeExec.executionId.slice(0, 8)} has been running for ${Math.round((Date.now() - activeExec.startTime) / 1000)}s.`,
        details: 'Process may be awaiting user input, stuck in an infinite loop, or executing long batch tasks.',
      });
    }
  }

  private createOrUpdateAnomaly(params: {
    projectId: string;
    sandboxId?: string | null;
    executionId?: string | null;
    anomalyType: AnomalyRecord['anomalyType'];
    severity: 'warning' | 'critical';
    title: string;
    reason: string;
    details: string;
  }): void {
    if (!this.db) return;

    // Check if active anomaly of this type already exists for project in last 2 minutes
    const existing = this.db
      .prepare(
        `SELECT id FROM resource_anomalies 
         WHERE project_id = ? AND anomaly_type = ? AND status = 'active' 
         AND created_at >= datetime('now', '-2 minutes')`
      )
      .get(params.projectId, params.anomalyType) as { id: string } | undefined;

    if (!existing) {
      const id = `anom-${randomUUID().slice(0, 8)}`;
      this.db
        .prepare(
          `INSERT INTO resource_anomalies (
            id, project_id, sandbox_id, execution_id, anomaly_type,
            severity, title, reason, details, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        )
        .run(
          id,
          params.projectId,
          params.sandboxId || null,
          params.executionId || null,
          params.anomalyType,
          params.severity,
          params.title,
          params.reason,
          params.details
        );
    }
  }

  /**
   * Queries historical telemetry samples and aggregates for a project.
   */
  public queryProjectTelemetry(
    projectId: string,
    options: {
      range?: '30s' | '5m' | '15m' | '1h' | 'all';
      startTime?: string;
      endTime?: string;
      maxPoints?: number;
    } = {}
  ): { samples: TelemetryRecord[]; summary: TelemetrySummary } {
    const { range = '5m', startTime, endTime, maxPoints = 60 } = options;

    let timeFilter = "datetime('now', '-5 minutes')";
    if (range === '30s') timeFilter = "datetime('now', '-30 seconds')";
    else if (range === '15m') timeFilter = "datetime('now', '-15 minutes')";
    else if (range === '1h') timeFilter = "datetime('now', '-1 hour')";
    else if (range === 'all') timeFilter = "datetime('now', '-24 hours')";

    let rows: any[] = [];
    if (this.db) {
      if (startTime && endTime) {
        rows = this.db
          .prepare(
            `SELECT * FROM telemetry_samples 
             WHERE project_id = ? AND created_at >= ? AND created_at <= ?
             ORDER BY created_at ASC`
          )
          .all(projectId, startTime, endTime);
      } else {
        rows = this.db
          .prepare(
            `SELECT * FROM telemetry_samples 
             WHERE project_id = ? AND created_at >= ${timeFilter}
             ORDER BY created_at ASC`
          )
          .all(projectId);
      }
    }

    // Merge recent hot buffer samples not yet flushed to DB
    const hotBuffer = this.hotBuffers.get(projectId);
    if (hotBuffer) {
      const hotSamples = hotBuffer.getAll();
      if (rows.length === 0) {
        for (const h of hotSamples) {
          rows.push({
            project_id: h.projectId,
            sandbox_id: h.sandboxId,
            execution_id: h.executionId,
            cpu_percent: h.cpuPercent,
            memory_usage_bytes: h.memoryUsageBytes,
            memory_limit_bytes: h.memoryLimitBytes,
            pids: h.pids,
            network_rx_bytes: h.networkRxBytes,
            network_tx_bytes: h.networkTxBytes,
            block_read_bytes: h.blockReadBytes,
            block_write_bytes: h.blockWriteBytes,
            created_at: h.createdAt,
          });
        }
      } else {
        const persistedTimestamps = new Set(rows.map((r) => r.created_at));
        for (const h of hotSamples) {
          if (!persistedTimestamps.has(h.createdAt)) {
            rows.push({
              project_id: h.projectId,
              sandbox_id: h.sandboxId,
              execution_id: h.executionId,
              cpu_percent: h.cpuPercent,
              memory_usage_bytes: h.memoryUsageBytes,
              memory_limit_bytes: h.memoryLimitBytes,
              pids: h.pids,
              network_rx_bytes: h.networkRxBytes,
              network_tx_bytes: h.networkTxBytes,
              block_read_bytes: h.blockReadBytes,
              block_write_bytes: h.blockWriteBytes,
              created_at: h.createdAt,
            });
          }
        }
      }
    }

    const records: TelemetryRecord[] = rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      sandboxId: r.sandbox_id,
      executionId: r.execution_id,
      cpuPercent: Number(r.cpu_percent) || 0,
      memoryUsageBytes: Number(r.memory_usage_bytes) || 0,
      memoryLimitBytes: Number(r.memory_limit_bytes) || 536870912,
      pids: Number(r.pids) || 0,
      networkRxBytes: Number(r.network_rx_bytes) || 0,
      networkTxBytes: Number(r.network_tx_bytes) || 0,
      blockReadBytes: Number(r.block_read_bytes) || 0,
      blockWriteBytes: Number(r.block_write_bytes) || 0,
      createdAt: r.created_at,
    }));

    const summary = calculateSummary(records);
    const downsampled = downsampleRecords(records, maxPoints);

    return {
      samples: downsampled,
      summary,
    };
  }

  /**
   * Queries telemetry specifically for an execution ID.
   */
  public queryExecutionTelemetry(
    projectId: string,
    executionId: string
  ): { samples: TelemetryRecord[]; summary: TelemetrySummary } {
    let rows: any[] = [];
    if (this.db) {
      rows = this.db
        .prepare(
          `SELECT * FROM telemetry_samples 
           WHERE project_id = ? AND execution_id = ?
           ORDER BY created_at ASC`
        )
        .all(projectId, executionId);
    }

    const records: TelemetryRecord[] = rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      sandboxId: r.sandbox_id,
      executionId: r.execution_id,
      cpuPercent: Number(r.cpu_percent) || 0,
      memoryUsageBytes: Number(r.memory_usage_bytes) || 0,
      memoryLimitBytes: Number(r.memory_limit_bytes) || 536870912,
      pids: Number(r.pids) || 0,
      networkRxBytes: Number(r.network_rx_bytes) || 0,
      networkTxBytes: Number(r.network_tx_bytes) || 0,
      blockReadBytes: Number(r.block_read_bytes) || 0,
      blockWriteBytes: Number(r.block_write_bytes) || 0,
      createdAt: r.created_at,
    }));

    return {
      samples: records,
      summary: calculateSummary(records),
    };
  }

  /**
   * Queries Project Health Center diagnostic state.
   */
  public getProjectHealth(projectId: string): ProjectHealthStatus {
    const anomalies: AnomalyRecord[] = this.db
      ? (this.db
          .prepare(
            `SELECT * FROM resource_anomalies 
             WHERE project_id = ? AND status = 'active'
             ORDER BY created_at DESC LIMIT 10`
          )
          .all(projectId) as any[]).map((r) => ({
          id: r.id,
          projectId: r.project_id,
          sandboxId: r.sandbox_id,
          executionId: r.execution_id,
          anomalyType: r.anomaly_type,
          severity: r.severity,
          title: r.title,
          reason: r.reason,
          details: r.details,
          status: r.status,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
        }))
      : [];

    // Usage & Failure stats today
    let executionsToday = 0;
    let totalDurationMsToday = 0;
    let failedExecutionsToday = 0;

    if (this.db) {
      const statsRow = this.db
        .prepare(
          `SELECT 
            COUNT(*) as total,
            SUM(duration_ms) as total_duration,
            SUM(CASE WHEN exit_code != 0 OR status = 'error' THEN 1 ELSE 0 END) as failed
           FROM runs
           WHERE project_id = ? AND created_at >= datetime('now', '-24 hours')`
        )
        .get(projectId) as { total: number; total_duration: number; failed: number } | undefined;

      executionsToday = statsRow?.total || 0;
      totalDurationMsToday = statsRow?.total_duration || 0;
      failedExecutionsToday = statsRow?.failed || 0;
    }

    const snapshotCount = this.db
      ? (this.db.prepare('SELECT COUNT(*) as count FROM snapshots WHERE project_id = ?').get(projectId) as { count: number })?.count || 0
      : 0;

    const failureRate = executionsToday > 0 ? (failedExecutionsToday / executionsToday) * 100 : 0;

    // Get live runtime stats
    const hotSamples = this.hotBuffers.get(projectId)?.getAll() || [];
    const latestSample = hotSamples[hotSamples.length - 1];

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    let score = 100;
    let summaryText = 'All systems healthy. Resource utilization within normal baseline.';

    if (anomalies.some((a) => a.severity === 'critical') || failureRate >= 50) {
      status = 'critical';
      score = Math.max(20, 60 - anomalies.length * 15);
      summaryText = 'Critical resource conditions or elevated execution failure rate detected.';
    } else if (anomalies.length > 0 || failureRate >= 20) {
      status = 'warning';
      score = Math.max(50, 85 - anomalies.length * 10);
      summaryText = 'Resource warnings active. Check memory/CPU margins or execution logs.';
    }

    return {
      status,
      score,
      summary: summaryText,
      runtime: {
        sandboxRunning: !!latestSample,
        currentCpuPercent: latestSample?.cpuPercent || 0,
        currentMemoryBytes: latestSample?.memoryUsageBytes || 0,
        currentPids: latestSample?.pids || 0,
      },
      usage: {
        executionsToday,
        totalDurationMsToday,
        snapshotCount,
      },
      anomalies,
      failureRatePercent: Math.round(failureRate),
    };
  }

  /**
   * Queries platform-wide aggregate historical telemetry for Admin Control Plane.
   */
  public queryAdminHistoricalTelemetry(range: '5m' | '15m' | '1h' | '24h' = '15m'): {
    timeline: {
      timestamp: string;
      avgCpuPercent: number;
      peakCpuPercent: number;
      totalMemoryBytes: number;
      activeSandboxes: number;
      activePids: number;
    }[];
    anomalies: AnomalyRecord[];
  } {
    let timeFilter = "datetime('now', '-15 minutes')";
    if (range === '5m') timeFilter = "datetime('now', '-5 minutes')";
    else if (range === '1h') timeFilter = "datetime('now', '-1 hour')";
    else if (range === '24h') timeFilter = "datetime('now', '-24 hours')";

    let rows: any[] = [];
    let anomalies: AnomalyRecord[] = [];

    if (this.db) {
      rows = this.db
        .prepare(
          `SELECT 
            strftime('%Y-%m-%d %H:%M:%S', created_at) as bucket_time,
            AVG(cpu_percent) as avg_cpu,
            MAX(cpu_percent) as peak_cpu,
            SUM(memory_usage_bytes) as total_mem,
            COUNT(DISTINCT sandbox_id) as active_sandboxes,
            SUM(pids) as total_pids
           FROM telemetry_samples
           WHERE created_at >= ${timeFilter}
           GROUP BY (strftime('%s', created_at) / 10)
           ORDER BY bucket_time ASC`
        )
        .all();

      anomalies = (this.db
        .prepare(
          `SELECT * FROM resource_anomalies 
           ORDER BY created_at DESC LIMIT 20`
        )
        .all() as any[]).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        sandboxId: r.sandbox_id,
        executionId: r.execution_id,
        anomalyType: r.anomaly_type,
        severity: r.severity,
        title: r.title,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }));
    }

    const timeline = rows.map((r) => ({
      timestamp: r.bucket_time,
      avgCpuPercent: Math.round((Number(r.avg_cpu) || 0) * 10) / 10,
      peakCpuPercent: Math.round((Number(r.peak_cpu) || 0) * 10) / 10,
      totalMemoryBytes: Number(r.total_mem) || 0,
      activeSandboxes: Number(r.active_sandboxes) || 0,
      activePids: Number(r.total_pids) || 0,
    }));

    return {
      timeline,
      anomalies,
    };
  }

  /**
   * Background sampling and cleanup timers
   */
  private startBackgroundTasks(): void {
    const sampleInterval = this.cfg?.telemetrySampleIntervalMs || 2000;
    const flushInterval = this.cfg?.telemetryFlushIntervalMs || 5000;

    // Periodic sandbox sampler
    this.sampleTimer = setInterval(async () => {
      try {
        const activeSandboxes = await this.sandboxManager.getAllActiveSandboxes();
        for (const sb of activeSandboxes) {
          const stats = await this.sandboxManager.getContainerStats(sb.projectId);
          if (stats.running) {
            this.recordSample(sb.projectId, sb.containerId, stats);
          }
        }
      } catch {}
    }, sampleInterval);
    this.sampleTimer.unref();

    // Batched flush timer
    this.flushTimer = setInterval(() => {
      this.flushQueue();
    }, flushInterval);
    this.flushTimer.unref();

    // Periodic retention cleaner (every 15 minutes)
    this.cleanupTimer = setInterval(() => {
      this.purgeExpiredSamples();
    }, 15 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  public purgeExpiredSamples(): void {
    if (!this.db || !this.cfg) return;
    const hours = this.cfg.telemetryRetentionHours || 2;
    try {
      this.db.prepare(`DELETE FROM telemetry_samples WHERE created_at < datetime('now', '-${hours} hours')`).run();
      this.db.prepare(`DELETE FROM resource_anomalies WHERE created_at < datetime('now', '-24 hours') AND status = 'resolved'`).run();
    } catch (err: any) {
      console.warn('[TelemetryHistorian] Cleanup warning:', err.message);
    }
  }

  public stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.flushQueue();
  }
}

/**
 * Calculates deterministic min/avg/max summary over a collection of telemetry samples.
 */
function calculateSummary(records: TelemetryRecord[]): TelemetrySummary {
  if (records.length === 0) {
    return {
      avgCpuPercent: 0,
      peakCpuPercent: 0,
      avgMemoryBytes: 0,
      peakMemoryBytes: 0,
      memoryLimitBytes: 536870912,
      peakPids: 0,
      totalNetworkRxBytes: 0,
      totalNetworkTxBytes: 0,
      totalBlockReadBytes: 0,
      totalBlockWriteBytes: 0,
      sampleCount: 0,
    };
  }

  let totalCpu = 0;
  let peakCpu = 0;
  let totalMem = 0;
  let peakMem = 0;
  let peakPids = 0;
  let maxRx = 0;
  let maxTx = 0;
  let maxRead = 0;
  let maxWrite = 0;
  const memLimit = records[0].memoryLimitBytes || 536870912;

  for (const r of records) {
    totalCpu += r.cpuPercent;
    if (r.cpuPercent > peakCpu) peakCpu = r.cpuPercent;

    totalMem += r.memoryUsageBytes;
    if (r.memoryUsageBytes > peakMem) peakMem = r.memoryUsageBytes;

    if (r.pids > peakPids) peakPids = r.pids;

    if (r.networkRxBytes > maxRx) maxRx = r.networkRxBytes;
    if (r.networkTxBytes > maxTx) maxTx = r.networkTxBytes;
    if (r.blockReadBytes > maxRead) maxRead = r.blockReadBytes;
    if (r.blockWriteBytes > maxWrite) maxWrite = r.blockWriteBytes;
  }

  return {
    avgCpuPercent: Math.round((totalCpu / records.length) * 10) / 10,
    peakCpuPercent: Math.round(peakCpu * 10) / 10,
    avgMemoryBytes: Math.round(totalMem / records.length),
    peakMemoryBytes: peakMem,
    memoryLimitBytes: memLimit,
    peakPids,
    totalNetworkRxBytes: maxRx,
    totalNetworkTxBytes: maxTx,
    totalBlockReadBytes: maxRead,
    totalBlockWriteBytes: maxWrite,
    sampleCount: records.length,
  };
}

/**
 * Downsamples dense record arrays into maxPoints evenly distributed buckets.
 */
function downsampleRecords(records: TelemetryRecord[], maxPoints: number): TelemetryRecord[] {
  if (records.length <= maxPoints) return records;

  const result: TelemetryRecord[] = [];
  const step = records.length / maxPoints;

  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.floor(i * step), records.length - 1);
    result.push(records[idx]);
  }

  // Always include the latest sample
  if (result[result.length - 1] !== records[records.length - 1]) {
    result[result.length - 1] = records[records.length - 1];
  }

  return result;
}

function parseNetIO(netIOStr = ''): { rxBytes: number; txBytes: number } {
  if (!netIOStr || !netIOStr.includes('/')) return { rxBytes: 0, txBytes: 0 };
  const [rx, tx] = netIOStr.split('/').map((s) => s.trim());
  return {
    rxBytes: parseByteUnits(rx),
    txBytes: parseByteUnits(tx),
  };
}

function parseBlockIO(blockIOStr = ''): { readBytes: number; writeBytes: number } {
  if (!blockIOStr || !blockIOStr.includes('/')) return { readBytes: 0, writeBytes: 0 };
  const [read, write] = blockIOStr.split('/').map((s) => s.trim());
  return {
    readBytes: parseByteUnits(read),
    writeBytes: parseByteUnits(write),
  };
}

function parseByteUnits(str = ''): number {
  const match = str.match(/^([\d.]+)\s*([A-Za-z]+)?$/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  switch (unit) {
    case 'B':
      return Math.round(val);
    case 'KB':
    case 'KIB':
      return Math.round(val * 1024);
    case 'MB':
    case 'MIB':
      return Math.round(val * 1024 * 1024);
    case 'GB':
    case 'GIB':
      return Math.round(val * 1024 * 1024 * 1024);
    default:
      return Math.round(val);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const telemetryHistorian = TelemetryHistorian.getInstance();
