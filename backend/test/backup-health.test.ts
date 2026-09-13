import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import {
  createDatabaseBackup,
  listDatabaseBackups,
} from "../src/backup/service.js";
import {
  createWorkspaceBackup,
  listWorkspaceBackups,
} from "../src/backup/workspaceBackup.js";
import {
  getDatabaseBackupHealth,
  getWorkspaceBackupHealth,
  getBackupHealthSummary,
} from "../src/backup/health.js";
import { createProject } from "../src/projects/service.js";
import { writeProjectFile } from "../src/files/service.js";
import { hashPassword } from "../src/auth/passwords.js";
import { ensureAdminUser } from "../src/db.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

/**
 * NOTE on timestamp simulation: `backup.test.ts` uses `utimesSync` to
 * simulate stale LOCK files, but that only rewrites a file's mtime.
 * `listDatabaseBackups`/`listWorkspaceBackups` derive `createdAt` from
 * `stat.birthtime` whenever it's valid (verified empirically: birthtime is
 * NOT affected by `utimesSync` on this platform — a real backup's
 * `createdAt` cannot be back-dated that way). Both health functions
 * therefore accept an explicit `now` override instead, and these tests use
 * that — computing exact boundary offsets from each backup's own real,
 * recorded `createdAt` — for fully deterministic boundary testing.
 */
describe("Milestone 34 — Backup & Restore Operational Health Observability", () => {
  const WARNING_MS = 10_000;
  const CRITICAL_MS = 20_000;

  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerId: number;

  beforeEach(async () => {
    cfg = makeTestConfig({
      backupHealthWarningAgeMs: WARNING_MS,
      backupHealthCriticalAgeMs: CRITICAL_MS,
      maxDatabaseBackups: 10,
    });
    api = await startTestApi(cfg);
    db = api.db;
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "health_owner", password: "password123" },
    });
    ownerId = reg.data.user.id;
  });

  afterEach(async () => {
    await api.close();
  });

  // createDatabaseBackup()'s own returned `createdAt` is `new Date().toISOString()`
  // captured moments after the file is written; listDatabaseBackups() (what
  // the health functions actually read) derives `createdAt` from the file's
  // own stat.birthtime instead — a few milliseconds earlier and NOT the same
  // value. Boundary tests must use the listed value, the health function's
  // actual source of truth, not the creation call's return value.
  async function latestListedCreatedAtMs(): Promise<number> {
    const backups = await listDatabaseBackups(cfg);
    return new Date(backups[0].createdAt).getTime();
  }

  describe("Database backup health", () => {
    it("1. never: no backups exist at all", async () => {
      const health = await getDatabaseBackupHealth(cfg);
      expect(health.status).toBe("never");
      expect(health.backupCount).toBe(0);
      expect(health.latestBackupCreatedAt).toBeNull();
      expect(health.latestBackupAgeMs).toBeNull();
      expect(health.warningAgeMs).toBe(WARNING_MS);
      expect(health.criticalAgeMs).toBe(CRITICAL_MS);
    });

    it("2. ok: exactly at the warning boundary (inclusive)", async () => {
      await createDatabaseBackup(db, cfg);
      const createdAtMs = await latestListedCreatedAtMs();
      const health = await getDatabaseBackupHealth(
        cfg,
        createdAtMs + WARNING_MS,
      );
      expect(health.status).toBe("ok");
      expect(health.latestBackupAgeMs).toBe(WARNING_MS);
    });

    it("3. stale: just beyond the warning boundary", async () => {
      await createDatabaseBackup(db, cfg);
      const createdAtMs = await latestListedCreatedAtMs();
      const health = await getDatabaseBackupHealth(
        cfg,
        createdAtMs + WARNING_MS + 1,
      );
      expect(health.status).toBe("stale");
    });

    it("4. stale: exactly at the critical boundary (inclusive of stale, not yet critical)", async () => {
      await createDatabaseBackup(db, cfg);
      const createdAtMs = await latestListedCreatedAtMs();
      const health = await getDatabaseBackupHealth(
        cfg,
        createdAtMs + CRITICAL_MS,
      );
      expect(health.status).toBe("stale");
      expect(health.latestBackupAgeMs).toBe(CRITICAL_MS);
    });

    it("5. critical: just beyond the critical boundary", async () => {
      await createDatabaseBackup(db, cfg);
      const createdAtMs = await latestListedCreatedAtMs();
      const health = await getDatabaseBackupHealth(
        cfg,
        createdAtMs + CRITICAL_MS + 1,
      );
      expect(health.status).toBe("critical");
    });

    it("6. a corrupt newest backup is skipped in favor of an older valid one — never falsely reported healthy", async () => {
      await createDatabaseBackup(db, cfg);
      const olderListed = (await listDatabaseBackups(cfg))[0];
      await new Promise((r) => setTimeout(r, 10));
      const newer = await createDatabaseBackup(db, cfg);
      // Corrupt the newer (by filename, newest) backup after creation.
      writeFileSync(newer.filePath, Buffer.from("not a sqlite file"));

      const health = await getDatabaseBackupHealth(cfg);
      expect(health.backupCount).toBe(2); // honest total file count
      expect(health.latestBackupCreatedAt).toBe(olderListed.createdAt); // valid one wins
    });
  });

  describe("Workspace backup health", () => {
    it("7. zero projects: status ok, 100% coverage vacuously", async () => {
      const health = await getWorkspaceBackupHealth(cfg, db);
      expect(health.totalProjects).toBe(0);
      expect(health.coveredProjects).toBe(0);
      expect(health.uncoveredProjects).toBe(0);
      expect(health.coveragePercent).toBe(100);
      expect(health.status).toBe("ok");
      expect(health.oldestLatestBackupAgeMs).toBeNull();
    });

    it("8. one uncovered project: never", async () => {
      await createProject(cfg, db, ownerId, { name: "No Backup" });
      const health = await getWorkspaceBackupHealth(cfg, db);
      expect(health.totalProjects).toBe(1);
      expect(health.coveredProjects).toBe(0);
      expect(health.uncoveredProjects).toBe(1);
      expect(health.coveragePercent).toBe(0);
      expect(health.status).toBe("never");
    });

    it("9. all covered and fresh: ok", async () => {
      const p1 = await createProject(cfg, db, ownerId, { name: "P1" });
      const p2 = await createProject(cfg, db, ownerId, { name: "P2" });
      await createWorkspaceBackup(cfg, db, p1.id);
      await createWorkspaceBackup(cfg, db, p2.id);

      const health = await getWorkspaceBackupHealth(cfg, db);
      expect(health.totalProjects).toBe(2);
      expect(health.coveredProjects).toBe(2);
      expect(health.uncoveredProjects).toBe(0);
      expect(health.coveragePercent).toBe(100);
      expect(health.status).toBe("ok");
    });

    it("10. mixed covered/uncovered: critical, correct coverage math", async () => {
      const p1 = await createProject(cfg, db, ownerId, { name: "Covered" });
      await createProject(cfg, db, ownerId, { name: "Uncovered" });
      await createWorkspaceBackup(cfg, db, p1.id);

      const health = await getWorkspaceBackupHealth(cfg, db);
      expect(health.totalProjects).toBe(2);
      expect(health.coveredProjects).toBe(1);
      expect(health.uncoveredProjects).toBe(1);
      expect(health.coveragePercent).toBe(50);
      expect(health.status).toBe("critical"); // any uncovered => critical
    });

    // Mirrors latestListedCreatedAtMs() above: createWorkspaceBackup()'s
    // returned `createdAt` is also `new Date().toISOString()`, not the
    // listed value listWorkspaceBackups() (and the health function) derive
    // from stat.birthtime -- boundary tests must use the listed value.
    async function latestListedWorkspaceCreatedAtMs(
      projectId: string,
    ): Promise<number> {
      const backups = await listWorkspaceBackups(cfg, projectId);
      return new Date(backups[0].createdAt).getTime();
    }

    it("11. stale oldest covered project (no uncovered projects)", async () => {
      const p1 = await createProject(cfg, db, ownerId, { name: "P1" });
      await createWorkspaceBackup(cfg, db, p1.id);
      const createdAtMs = await latestListedWorkspaceCreatedAtMs(p1.id);

      const health = await getWorkspaceBackupHealth(
        cfg,
        db,
        createdAtMs + WARNING_MS + 1,
      );
      expect(health.uncoveredProjects).toBe(0);
      expect(health.status).toBe("stale");
      expect(health.oldestLatestBackupProjectId).toBe(p1.id);
    });

    it("12. critical oldest covered project (no uncovered projects)", async () => {
      const p1 = await createProject(cfg, db, ownerId, { name: "P1" });
      await createWorkspaceBackup(cfg, db, p1.id);
      const createdAtMs = await latestListedWorkspaceCreatedAtMs(p1.id);

      const health = await getWorkspaceBackupHealth(
        cfg,
        db,
        createdAtMs + CRITICAL_MS + 1,
      );
      expect(health.uncoveredProjects).toBe(0);
      expect(health.status).toBe("critical");
    });

    it("13. exact threshold boundaries for workspace freshness (ok at warning, stale at critical)", async () => {
      const p1 = await createProject(cfg, db, ownerId, { name: "P1" });
      await createWorkspaceBackup(cfg, db, p1.id);
      const createdAtMs = await latestListedWorkspaceCreatedAtMs(p1.id);

      const atWarning = await getWorkspaceBackupHealth(
        cfg,
        db,
        createdAtMs + WARNING_MS,
      );
      expect(atWarning.status).toBe("ok");

      const atCritical = await getWorkspaceBackupHealth(
        cfg,
        db,
        createdAtMs + CRITICAL_MS,
      );
      expect(atCritical.status).toBe("stale");
    });

    it("14. oldestLatestBackupAgeMs identifies the correct (least-recently-backed-up) project among several covered ones", async () => {
      const pOld = await createProject(cfg, db, ownerId, { name: "Old" });
      await createWorkspaceBackup(cfg, db, pOld.id);
      const oldCreatedAtMs = await latestListedWorkspaceCreatedAtMs(pOld.id);
      await new Promise((r) => setTimeout(r, 10));
      const pNew = await createProject(cfg, db, ownerId, { name: "New" });
      await createWorkspaceBackup(cfg, db, pNew.id);

      const health = await getWorkspaceBackupHealth(cfg, db);
      expect(health.oldestLatestBackupProjectId).toBe(pOld.id);
      expect(health.oldestLatestBackupAgeMs).toBeGreaterThanOrEqual(
        Date.now() - oldCreatedAtMs - 5,
      );
    });
  });

  describe("Admin /health integration", () => {
    it("15. response includes backups, and existing fields retain their exact shape", async () => {
      const adminHash = await hashPassword("AdminPass@123");
      ensureAdminUser(db, "health_admin", adminHash);
      const adminLogin = await api.request("POST", "/api/auth/admin-login", {
        body: { username: "health_admin", password: "AdminPass@123" },
      });
      const adminToken = adminLogin.data.token;

      const res = await api.request("GET", "/api/admin/health", {
        token: adminToken,
      });
      expect(res.status).toBe(200);

      // Existing fields, unchanged shape.
      expect(res.data.database).toEqual({ live: true, walMode: true });
      expect(res.data.docker).toBeDefined();
      expect(res.data.sandboxManager).toBeDefined();
      expect(typeof res.data.sandboxManager.maxSandboxes).toBe("number");

      // New field.
      expect(res.data.backups).toBeDefined();
      expect(res.data.backups.database.status).toBe("never");
      expect(res.data.backups.workspaces.status).toBe("ok"); // zero projects

      // No filenames/paths/secrets leaked into the aggregate summary.
      const serialized = JSON.stringify(res.data.backups);
      expect(serialized).not.toMatch(
        /\.zip|\.db|workspace-backups|backups[\\/]/i,
      );
    });

    it("16. anonymous and non-admin requests to /health are still rejected exactly as before", async () => {
      const reg = await api.request("POST", "/api/auth/register", {
        body: { username: "health_nonadmin", password: "password123" },
      });
      const anonRes = await api.request("GET", "/api/admin/health", {});
      expect(anonRes.status).toBe(401);
      const nonAdminRes = await api.request("GET", "/api/admin/health", {
        token: reg.data.token,
      });
      expect(nonAdminRes.status).toBe(403);
    });
  });

  describe("Public health endpoints remain untouched", () => {
    it("17. GET /api/health is unchanged (no backups field, same shape)", async () => {
      const res = await api.request("GET", "/api/health", {});
      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        ok: true,
        status: "live",
        runUser: cfg.runUser.user,
        platform: process.platform,
      });
      expect(res.data.backups).toBeUndefined();
    });

    it("18. GET /api/health/ready is unchanged (no backups field, same checks shape)", async () => {
      const res = await api.request("GET", "/api/health/ready", {});
      expect(res.data.checks).toBeDefined();
      expect(res.data.checks.database).toBeDefined();
      expect(res.data.checks.docker).toBeDefined();
      expect(res.data.checks.runnerImage).toBeDefined();
      expect(res.data.backups).toBeUndefined();
      expect((res.data.checks as any).backups).toBeUndefined();
    });
  });

  it("19. getBackupHealthSummary aggregates both dimensions in one call", async () => {
    const project = await createProject(cfg, db, ownerId, { name: "P" });
    const cwd = (await import("../src/projects/service.js")).projectDir(
      cfg,
      project.id,
    );
    await writeProjectFile(cwd, "a.txt", "content");
    await createWorkspaceBackup(cfg, db, project.id);
    await createDatabaseBackup(db, cfg);

    const summary = await getBackupHealthSummary(cfg, db);
    expect(summary.database.status).toBe("ok");
    expect(summary.workspaces.status).toBe("ok");
    expect(summary.workspaces.totalProjects).toBe(1);
    expect(summary.workspaces.coveredProjects).toBe(1);
  });
});
