import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, ensureAdminUser } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { TelemetryHistorian, RingBuffer } from "../src/execution/historian.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { hashPassword } from "../src/auth/passwords.js";

describe("M3 Cloud Resource Intelligence: Telemetry Historian & Buffers", () => {
  it("RingBuffer maintains bounded capacity and circular FIFO ordering", () => {
    const ring = new RingBuffer<number>(3);
    expect(ring.getAll()).toEqual([]);

    ring.push(10);
    ring.push(20);
    expect(ring.getAll()).toEqual([10, 20]);

    ring.push(30);
    expect(ring.getAll()).toEqual([10, 20, 30]);

    ring.push(40); // 10 should be evicted
    expect(ring.getAll()).toEqual([20, 30, 40]);
  });

  it("Historian records samples, generates summaries, and flushes to database", async () => {
    const db = openDb(":memory:");
    const cfg = resolveConfig();
    const historian = TelemetryHistorian.getInstance();
    historian.init(db, cfg);

    // Insert user and project for foreign keys
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("hist_user", "hash", "user");
    db.prepare(
      "INSERT INTO projects (id, owner_id, name) VALUES (?, ?, ?)",
    ).run("proj-hist-1", 1, "HistProject");

    const projId = "proj-hist-1";

    // Record 2 samples
    historian.recordSample(projId, "sb-test-1", {
      running: true,
      cpuPercent: 25.5,
      memoryUsageBytes: 128 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 25,
      pids: 4,
      netIO: "10KB / 5KB",
      blockIO: "20KB / 10KB",
    });

    historian.recordSample(projId, "sb-test-1", {
      running: true,
      cpuPercent: 75.5,
      memoryUsageBytes: 256 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 50,
      pids: 8,
      netIO: "30KB / 15KB",
      blockIO: "40KB / 20KB",
    });

    // Query in-memory / hot buffer telemetry
    const res = historian.queryProjectTelemetry(projId, { range: "5m" });
    expect(res.samples.length).toBe(2);
    expect(res.summary.peakCpuPercent).toBe(75.5);
    expect(res.summary.avgCpuPercent).toBe(50.5);
    expect(res.summary.peakPids).toBe(8);

    // Flush to SQLite
    historian.flushQueue();
    const rows = db
      .prepare(
        "SELECT COUNT(*) as count FROM telemetry_samples WHERE project_id = ?",
      )
      .get(projId) as { count: number };
    expect(rows.count).toBe(2);

    historian.stop();
  });

  it("disposeProject releases per-project hot buffer and anomaly streak state", () => {
    const db = openDb(":memory:");
    const cfg = resolveConfig();
    const historian = TelemetryHistorian.getInstance();
    historian.init(db, cfg);

    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("dispose_user", "hash", "user");
    db.prepare(
      "INSERT INTO projects (id, owner_id, name) VALUES (?, ?, ?)",
    ).run("proj-dispose-1", 1, "DisposeProject");

    const projId = "proj-dispose-1";
    const internals = historian as unknown as {
      hotBuffers: Map<string, unknown>;
      highCpuStreaks: Map<string, number>;
      activeExecutions: Map<string, unknown>;
    };

    historian.trackExecutionStart(projId, "exec-dispose-1");
    historian.recordSample(projId, "sb-dispose-1", {
      running: true,
      cpuPercent: 12.5,
      memoryUsageBytes: 32 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 6.25,
      pids: 2,
      netIO: "1KB / 1KB",
      blockIO: "1KB / 1KB",
    });

    // Populated before disposal
    expect(internals.hotBuffers.has(projId)).toBe(true);
    expect(internals.highCpuStreaks.has(projId)).toBe(true);
    expect(internals.activeExecutions.has(projId)).toBe(true);
    expect(
      historian.queryProjectTelemetry(projId, { range: "5m" }).samples.length,
    ).toBe(1);

    historian.disposeProject(projId);

    // All per-project in-memory state released
    expect(internals.hotBuffers.has(projId)).toBe(false);
    expect(internals.highCpuStreaks.has(projId)).toBe(false);
    expect(internals.activeExecutions.has(projId)).toBe(false);
    expect(
      historian.queryProjectTelemetry(projId, { range: "5m" }).samples.length,
    ).toBe(0);

    historian.stop();
  });
});

describe("M3 Cloud Resource Intelligence: Anomaly Engine & Health Center", () => {
  it("detects high CPU, memory pressure, and PID pressure anomalies", async () => {
    const db = openDb(":memory:");
    const cfg = resolveConfig();
    const historian = TelemetryHistorian.getInstance();
    historian.init(db, cfg);

    // Insert user and project for foreign keys
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("anom_user", "hash", "user");
    db.prepare(
      "INSERT INTO projects (id, owner_id, name) VALUES (?, ?, ?)",
    ).run("proj-anom-1", 1, "AnomProject");

    const projId = "proj-anom-1";

    // Trigger high CPU anomaly (>85% sustained across >= 5 samples)
    for (let i = 0; i < 6; i++) {
      historian.recordSample(projId, "sb-high-cpu", {
        running: true,
        cpuPercent: 92.0,
        memoryUsageBytes: 64 * 1024 * 1024,
        memoryLimitBytes: 512 * 1024 * 1024,
        memoryPercent: 12.5,
        pids: 3,
        netIO: "0B / 0B",
        blockIO: "0B / 0B",
      });
    }

    // Trigger memory critical pressure (>95% limit)
    historian.recordSample(projId, "sb-high-cpu", {
      running: true,
      cpuPercent: 10.0,
      memoryUsageBytes: 500 * 1024 * 1024, // 97.6% of 512MB
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 97.6,
      pids: 3,
      netIO: "0B / 0B",
      blockIO: "0B / 0B",
    });

    // M86: normal IDE load (language server + a test run ≈ 58 threads) is
    // not pressure under the configured limit.
    historian.recordSample(projId, "sb-high-cpu", {
      running: true,
      cpuPercent: 10.0,
      memoryUsageBytes: 64 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 12.5,
      pids: 58,
      netIO: "0B / 0B",
      blockIO: "0B / 0B",
    });
    expect(
      historian
        .getProjectHealth(projId)
        .anomalies.some((a) => a.anomalyType === "pid_pressure"),
    ).toBe(false);

    // Trigger PID pressure (>= ~78% of the configured sandbox limit)
    historian.recordSample(projId, "sb-high-cpu", {
      running: true,
      cpuPercent: 10.0,
      memoryUsageBytes: 64 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 12.5,
      pids: Math.ceil(cfg.limits.pidsLimit * 0.85),
      netIO: "0B / 0B",
      blockIO: "0B / 0B",
    });

    const health = historian.getProjectHealth(projId);
    expect(health.status).toBe("critical"); // Memory critical anomaly triggered
    expect(health.anomalies.length).toBeGreaterThanOrEqual(3);
    expect(health.anomalies.some((a) => a.anomalyType === "high_cpu")).toBe(
      true,
    );
    expect(
      health.anomalies.some((a) => a.anomalyType === "memory_pressure"),
    ).toBe(true);
    const pid = health.anomalies.find((a) => a.anomalyType === "pid_pressure");
    expect(pid).toBeTruthy();
    expect(pid!.reason).toContain(`limit is ${cfg.limits.pidsLimit}`);

    historian.stop();
  });
});

describe("M3 Cloud Resource Intelligence: Historical API & Multi-Tenant Authorization", () => {
  let api: TestApi;
  let cfg: ReturnType<typeof makeTestConfig>;
  let user1Token: string;
  let user2Token: string;
  let adminToken: string;
  let proj1Id: string;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);

    // Register user 1
    const u1 = await api.request("POST", "/api/auth/register", {
      body: { username: "tenantuser1", password: "password123" },
    });
    user1Token = u1.data.token;

    // Register user 2
    const u2 = await api.request("POST", "/api/auth/register", {
      body: { username: "tenantuser2", password: "password123" },
    });
    user2Token = u2.data.token;

    // Create admin user
    const hash = await hashPassword("AdminPass123!");
    ensureAdminUser(api.db, "adminm3", hash);
    const admLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "adminm3", password: "AdminPass123!" },
    });
    adminToken = admLogin.data.token;

    // Create project under user 1
    const p1 = await api.request("POST", "/api/projects", {
      token: user1Token,
      body: { name: "M3TestProject" },
    });
    proj1Id = p1.data.project.id;
  });

  afterEach(async () => {
    TelemetryHistorian.getInstance().stop();
    await api.close();
  });

  it("GET /api/projects/:id/telemetry returns historical samples and summary", async () => {
    TelemetryHistorian.getInstance().recordSample(proj1Id, "sb-1", {
      running: true,
      cpuPercent: 42.0,
      memoryUsageBytes: 120 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 23.4,
      pids: 6,
      netIO: "5KB / 2KB",
      blockIO: "10KB / 5KB",
    });

    const res = await api.request(
      "GET",
      `/api/projects/${proj1Id}/telemetry?range=5m`,
      {
        token: user1Token,
      },
    );

    expect(res.status).toBe(200);
    expect(res.data.samples.length).toBeGreaterThanOrEqual(1);
    expect(res.data.summary.peakCpuPercent).toBe(42.0);
  });

  it("DELETE /api/projects/:id releases the project telemetry state held by the historian", async () => {
    const historian = TelemetryHistorian.getInstance();
    const internals = historian as unknown as {
      hotBuffers: Map<string, unknown>;
      highCpuStreaks: Map<string, number>;
    };

    historian.recordSample(proj1Id, "sb-delete-1", {
      running: true,
      cpuPercent: 30.0,
      memoryUsageBytes: 90 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      memoryPercent: 17.5,
      pids: 5,
      netIO: "2KB / 1KB",
      blockIO: "4KB / 2KB",
    });
    expect(internals.hotBuffers.has(proj1Id)).toBe(true);
    expect(internals.highCpuStreaks.has(proj1Id)).toBe(true);

    const del = await api.request("DELETE", `/api/projects/${proj1Id}`, {
      token: user1Token,
    });
    expect(del.status).toBeLessThan(300);

    expect(internals.hotBuffers.has(proj1Id)).toBe(false);
    expect(internals.highCpuStreaks.has(proj1Id)).toBe(false);
  });

  it("enforces multi-tenant authorization: user2 cannot read user1 project telemetry", async () => {
    const res = await api.request("GET", `/api/projects/${proj1Id}/telemetry`, {
      token: user2Token,
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/projects/:id/health returns deterministic health score and runtime status", async () => {
    const res = await api.request("GET", `/api/projects/${proj1Id}/health`, {
      token: user1Token,
    });

    expect(res.status).toBe(200);
    expect(res.data.health.status).toBe("healthy");
    expect(res.data.health.score).toBe(100);
    expect(typeof res.data.health.runtime).toBe("object");
  });

  it("GET /api/admin/telemetry/historical requires admin role and returns aggregate timeline", async () => {
    // Forbidden for normal user token
    const forbiddenRes = await api.request(
      "GET",
      "/api/admin/telemetry/historical",
      {
        token: user1Token,
      },
    );
    expect(forbiddenRes.status).toBe(403);

    // Allowed for admin token
    const adminRes = await api.request(
      "GET",
      "/api/admin/telemetry/historical?range=15m",
      {
        token: adminToken,
      },
    );
    expect(adminRes.status).toBe(200);
    expect(Array.isArray(adminRes.data.timeline)).toBe(true);
    expect(Array.isArray(adminRes.data.anomalies)).toBe(true);
  });
});
