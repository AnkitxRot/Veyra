import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  registerConnection,
  unregisterConnection,
  activeConnectionCountForUser,
} from "../src/ws/connectionRegistry.js";
import { cleanupExpiredDemoAccounts } from "../src/auth/demoGc.js";
import { createProject, projectDir } from "../src/projects/service.js";
import { createSnapshot } from "../src/projects/snapshots.js";
import { hashPassword } from "../src/auth/passwords.js";
import { writeProjectFile } from "../src/files/service.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 19 — Auth Lifecycle & Session Security", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;
  });

  afterEach(async () => {
    await api.close();
  });

  describe("A. Logout WebSocket Teardown", () => {
    it("terminates live WebSockets when an authenticated user logs out", async () => {
      // 1. Register a test user
      const regRes = await api.request("POST", "/api/auth/register", {
        body: { username: "ws_user_1", password: "password123" },
      });
      expect(regRes.status).toBe(201);
      const { token, user } = regRes.data;

      // 2. Simulate active WebSocket connection registered for this user
      let closeCalled = false;
      let closeCode: number | undefined;
      let closeReason: string | undefined;

      const mockWs: any = {
        close: vi.fn((code, reason) => {
          closeCalled = true;
          closeCode = code;
          closeReason = reason;
        }),
        terminate: vi.fn(),
      };

      registerConnection(user.id, mockWs);
      expect(activeConnectionCountForUser(user.id)).toBe(1);

      // 3. User logs out
      const logoutRes = await api.request("POST", "/api/auth/logout", {
        token,
      });
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.data.ok).toBe(true);

      // 4. Verify socket was closed with code 4401 "Session revoked"
      expect(closeCalled).toBe(true);
      expect(closeCode).toBe(4401);
      expect(closeReason).toBe("Session revoked");

      // 5. Verify session was removed from database
      const sessionRow = db
        .prepare("SELECT * FROM sessions WHERE user_id = ?")
        .get(user.id);
      expect(sessionRow).toBeUndefined();

      // Clean up mock socket from registry
      unregisterConnection(user.id, mockWs);
    });

    it("records AUTH_LOGOUT in audit log on logout", async () => {
      const regRes = await api.request("POST", "/api/auth/register", {
        body: { username: "audit_user_1", password: "password123" },
      });
      const { token, user } = regRes.data;

      await api.request("POST", "/api/auth/logout", { token });

      const auditRow = db
        .prepare(
          "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'AUTH_LOGOUT'",
        )
        .get(user.id) as any;
      expect(auditRow).toBeDefined();
      expect(JSON.parse(auditRow.details).username).toBe("audit_user_1");
    });
  });

  describe("B. Demo Account Security & Username Reservation", () => {
    it("prohibits registering usernames starting with evaluator_ via public registration", async () => {
      const res = await api.request("POST", "/api/auth/register", {
        body: { username: "evaluator_attacker", password: "password123" },
      });
      expect(res.status).toBe(409);
      expect(res.data.error.code).toBe("username_taken");
    });
  });

  describe("C. Expired Demo Account Garbage Collection", () => {
    it("purges expired demo accounts, workspaces on disk, snapshots, and DB records", async () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 3 * 3600 * 1000).toISOString(); // 3 hours ago

      // 1. Insert an expired demo user directly
      const hash = await hashPassword("demopass123");
      const userInsert = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("evaluator_exp001", hash, "user", twoHoursAgo);
      const demoUserId = Number(userInsert.lastInsertRowid);

      // Insert an expired session
      const expiredSessionTime = new Date(now - 1 * 3600 * 1000).toISOString();
      db.prepare(
        "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      ).run("expired_token_1", demoUserId, expiredSessionTime, twoHoursAgo);

      // Create a project for this demo user
      const project = await createProject(cfg, db, demoUserId, {
        name: "ExpiredDemoProject",
        language: "python",
      });

      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "main.py", "print('demo')\n");
      expect(existsSync(join(wsDir, "main.py"))).toBe(true);

      // Create a snapshot
      await createSnapshot(cfg, db, demoUserId, project.id, "DemoSnapshot1");
      const snapDir = join(cfg.dataDir, "snapshots", project.id);

      // 2. Run demo GC
      const result = await cleanupExpiredDemoAccounts(cfg, db, now);
      expect(result.cleanedUsers).toBe(1);
      expect(result.cleanedProjects).toBe(1);

      // 3. Assert workspace directory on disk is removed
      expect(existsSync(wsDir)).toBe(false);
      expect(existsSync(snapDir)).toBe(false);

      // 4. Assert user and project DB rows are gone
      const userRow = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(demoUserId);
      expect(userRow).toBeUndefined();

      const projRow = db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(project.id);
      expect(projRow).toBeUndefined();

      const snapRows = db
        .prepare("SELECT * FROM snapshots WHERE user_id = ?")
        .all(demoUserId);
      expect(snapRows).toHaveLength(0);

      // 5. Assert audit log was recorded
      const audit = db
        .prepare(
          "SELECT * FROM audit_logs WHERE event_type = 'DEMO_ACCOUNTS_GC'",
        )
        .get() as any;
      expect(audit).toBeDefined();
      expect(JSON.parse(audit.details).username).toBe("evaluator_exp001");
    });

    it("preserves active unexpired demo accounts", async () => {
      const now = Date.now();
      const thirtyMinsAgo = new Date(now - 30 * 60 * 1000).toISOString();
      const futureExpiry = new Date(now + 90 * 60 * 1000).toISOString();

      // Create a fresh demo user (created 30 mins ago, session valid for 90 more mins)
      const hash = await hashPassword("demopass123");
      const userInsert = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("evaluator_act002", hash, "user", thirtyMinsAgo);
      const activeDemoId = Number(userInsert.lastInsertRowid);

      db.prepare(
        "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      ).run("active_token_2", activeDemoId, futureExpiry, thirtyMinsAgo);

      const project = await createProject(cfg, db, activeDemoId, {
        name: "ActiveDemoProject",
        language: "python",
      });
      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "main.py", "print('active')\n");

      // Run GC
      const result = await cleanupExpiredDemoAccounts(cfg, db, now);
      expect(result.cleanedUsers).toBe(0);
      expect(result.cleanedProjects).toBe(0);

      // Assert user, project, and workspace on disk are intact
      expect(existsSync(join(wsDir, "main.py"))).toBe(true);
      const userRow = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(activeDemoId);
      expect(userRow).toBeDefined();
    });

    it("preserves regular non-demo user accounts even if their sessions are expired", async () => {
      const now = Date.now();
      const threeDaysAgo = new Date(now - 3 * 24 * 3600 * 1000).toISOString();

      // Create regular user (not starting with evaluator_)
      const hash = await hashPassword("regularpass123");
      const userInsert = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("regular_alice", hash, "user", threeDaysAgo);
      const regularId = Number(userInsert.lastInsertRowid);

      // Expired session
      db.prepare(
        "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      ).run("alice_old_session", regularId, threeDaysAgo, threeDaysAgo);

      const project = await createProject(cfg, db, regularId, {
        name: "AliceProject",
        language: "javascript",
      });
      const wsDir = projectDir(cfg, project.id);
      await writeProjectFile(wsDir, "index.js", "console.log('alice')\n");

      // Run GC
      const result = await cleanupExpiredDemoAccounts(cfg, db, now);
      expect(result.cleanedUsers).toBe(0);

      // Assert Alice's account and workspace are completely untouched
      expect(existsSync(join(wsDir, "index.js"))).toBe(true);
      const userRow = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(regularId);
      expect(userRow).toBeDefined();
    });

    it("is idempotent when run multiple times in sequence", async () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 3 * 3600 * 1000).toISOString();

      const hash = await hashPassword("demopass");
      const userInsert = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("evaluator_idem01", hash, "user", twoHoursAgo);
      const demoId = Number(userInsert.lastInsertRowid);

      await createProject(cfg, db, demoId, { name: "IdemProj" });

      // First run cleans the user
      const r1 = await cleanupExpiredDemoAccounts(cfg, db, now);
      expect(r1.cleanedUsers).toBe(1);

      // Second run cleans nothing and does not error
      const r2 = await cleanupExpiredDemoAccounts(cfg, db, now);
      expect(r2.cleanedUsers).toBe(0);
      expect(r2.cleanedProjects).toBe(0);
    });

    it("recovers gracefully when workspace files on disk are already missing", async () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 3 * 3600 * 1000).toISOString();

      const hash = await hashPassword("demopass");
      const userInsert = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("evaluator_missing_ws", hash, "user", twoHoursAgo);
      const demoId = Number(userInsert.lastInsertRowid);

      const project = await createProject(cfg, db, demoId, {
        name: "MissingWsProj",
      });

      // Manually delete workspace directory before GC
      const wsDir = projectDir(cfg, project.id);
      await fs.rm(wsDir, { recursive: true, force: true });
      expect(existsSync(wsDir)).toBe(false);

      // GC should not throw and should clean up the DB rows
      const result = await cleanupExpiredDemoAccounts(cfg, db, now);
      expect(result.cleanedUsers).toBe(1);

      const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(demoId);
      expect(userRow).toBeUndefined();
    });

    it("supports single-flight concurrency without double-deletion errors", async () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 3 * 3600 * 1000).toISOString();

      const hash = await hashPassword("demopass");
      const userInsert = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("evaluator_conc01", hash, "user", twoHoursAgo);
      const demoId = Number(userInsert.lastInsertRowid);

      await createProject(cfg, db, demoId, { name: "ConcProj" });

      // Run two GC operations concurrently
      const [res1, res2] = await Promise.all([
        cleanupExpiredDemoAccounts(cfg, db, now),
        cleanupExpiredDemoAccounts(cfg, db, now),
      ]);

      expect(res1).toBe(res2); // Single-flight returned the exact same in-flight promise
      expect(res1.cleanedUsers).toBe(1);
    });
  });
});
