import { WebSocket } from 'ws';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { SandboxManager } from '../execution/sandbox.js';
import { auditEmitter, auditFailureEmitter, getAuditFailureSnapshot, type AuditRecord } from '../audit.js';

export class AdminTelemetryStreamManager {
  private static instance: AdminTelemetryStreamManager;
  private clients = new Set<WebSocket>();
  private ticker: NodeJS.Timeout | null = null;
  private sandboxManager = SandboxManager.getInstance();
  private db: Db | null = null;
  private cfg: AppConfig | null = null;
  private lastBroadcastTime = 0;

  private constructor() {
    // Listen for platform events from audit system
    auditEmitter.on('audit', (record: AuditRecord) => {
      this.broadcastEvent(record);
    });
    // M93: listen for audit write failures
    auditFailureEmitter.on('failure', () => {
      this.broadcastAuditIntegrity();
    });
  }

  public static getInstance(): AdminTelemetryStreamManager {
    if (!AdminTelemetryStreamManager.instance) {
      AdminTelemetryStreamManager.instance = new AdminTelemetryStreamManager();
    }
    return AdminTelemetryStreamManager.instance;
  }

  public init(db: Db, cfg: AppConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  public addClient(ws: WebSocket) {
    this.clients.add(ws);

    // Send initial snapshot immediately
    this.sendSnapshot(ws).catch(() => {});
    // M93: send initial audit integrity snapshot
    this.sendAuditIntegritySnapshot(ws).catch(() => {});

    // Start 1Hz background collector if first client connected
    if (this.clients.size === 1 && !this.ticker) {
      this.startCollector();
    }

    ws.on('close', () => {
      this.clients.delete(ws);
      if (this.clients.size === 0) {
        this.stopCollector();
      }
    });

    ws.on('error', () => {
      this.clients.delete(ws);
      if (this.clients.size === 0) {
        this.stopCollector();
      }
    });

    // Handle client ping
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch {}
    });
  }

  private startCollector() {
    this.stopCollector();
    this.ticker = setInterval(() => {
      this.collectAndBroadcast().catch((err) => {
        console.error('[AdminTelemetry] Collector tick error:', err);
      });
    }, 1000); // 1 Hz tick
    this.ticker.unref();
  }

  private stopCollector() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private async collectAndBroadcast() {
    if (this.clients.size === 0 || !this.db || !this.cfg) return;

    const payload = await this.buildTelemetryPayload();
    const message = JSON.stringify({
      type: 'telemetry_tick',
      data: payload,
      timestamp: Date.now(),
    });

    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch {
          // ignore send failures for individual clients; other clients still receive the tick
        }
      }
    }
    this.lastBroadcastTime = Date.now();
  }

  private async sendSnapshot(ws: WebSocket) {
    if (!this.db || !this.cfg || ws.readyState !== WebSocket.OPEN) return;
    const payload = await this.buildTelemetryPayload();
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        data: payload,
        timestamp: Date.now(),
      })
    );
  }

  private async sendAuditIntegritySnapshot(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'audit_integrity',
        data: getAuditFailureSnapshot(),
        timestamp: Date.now(),
      })
    );
  }

  public broadcastEvent(record: AuditRecord) {
    if (this.clients.size === 0) return;
    const message = JSON.stringify({
      type: 'platform_event',
      event: record,
      timestamp: Date.now(),
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch {
          // ignore send failures for individual clients; other clients still receive the event
        }
      }
    }
  }

  private broadcastAuditIntegrity() {
    if (this.clients.size === 0) return;
    const snapshot = getAuditFailureSnapshot();
    const message = JSON.stringify({
      type: 'audit_integrity',
      data: snapshot,
      timestamp: Date.now(),
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch {
          // ignore send failures for individual clients
        }
      }
    }
  }

  private async buildTelemetryPayload() {
    if (!this.db || !this.cfg) return null;

    const activeSandboxes = await this.sandboxManager.getAllActiveSandboxes();
    let aggregateCpu = 0;
    let aggregateMemoryBytes = 0;
    let aggregatePids = 0;

    const sandboxesData = await Promise.all(
      activeSandboxes.map(async (sb) => {
        const stats = await this.sandboxManager.getContainerStats(sb.projectId);
        const projectRow = this.db!.prepare(`
          SELECT p.name, u.username
          FROM projects p
          JOIN users u ON u.id = p.owner_id
          WHERE p.id = ?
        `).get(sb.projectId) as { name: string; username: string } | undefined;

        if (stats.running) {
          aggregateCpu += stats.cpuPercent;
          aggregateMemoryBytes += stats.memoryUsageBytes;
          aggregatePids += stats.pids;
        }

        return {
          containerId: sb.containerId,
          projectId: sb.projectId,
          projectName: projectRow?.name ?? 'Workspace',
          ownerUsername: projectRow?.username ?? 'Unknown',
          ports: sb.ports,
          lastUsed: sb.lastUsed,
          idleSeconds: Math.max(0, Math.floor((Date.now() - sb.lastUsed) / 1000)),
          status: stats.running ? 'running' : 'idle',
          cpuPercent: stats.cpuPercent,
          memoryUsageBytes: stats.memoryUsageBytes,
          pids: stats.pids,
          limits: {
            memoryBytes: this.cfg!.limits.memoryBytes,
            cpuQuota: this.cfg!.limits.cpuQuota,
            pidsLimit: this.cfg!.limits.pidsLimit,
          },
        };
      })
    );

    // Platform counters
    const totalUsersRow = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    const demoUsersRow = this.db.prepare("SELECT COUNT(*) as count FROM users WHERE username LIKE 'evaluator_%'").get() as { count: number };
    const totalProjectsRow = this.db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number };
    const totalRunsRow = this.db.prepare('SELECT COUNT(*) as count FROM runs').get() as { count: number };

    return {
      system: {
        status: 'healthy',
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryRssBytes: process.memoryUsage().rss,
      },
      counters: {
        totalUsers: totalUsersRow?.count ?? 0,
        demoSessions: demoUsersRow?.count ?? 0,
        totalProjects: totalProjectsRow?.count ?? 0,
        activeSandboxes: activeSandboxes.length,
        totalExecutions: totalRunsRow?.count ?? 0,
      },
      aggregateTelemetry: {
        cpuPercent: Math.round(aggregateCpu * 10) / 10,
        memoryUsageBytes: aggregateMemoryBytes,
        memoryLimitBytes: this.cfg.limits.memoryBytes * Math.max(1, activeSandboxes.length),
        pids: aggregatePids,
      },
      sandboxes: sandboxesData,
    };
  }
}
