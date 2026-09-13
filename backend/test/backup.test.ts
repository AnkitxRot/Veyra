import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { openDb, ensureAdminUser } from "../src/db.js";
import { hashPassword } from "../src/auth/passwords.js";
import {
  createDatabaseBackup,
  listDatabaseBackups,
  deleteDatabaseBackup,
  pruneDatabaseBackups,
  verifyDatabaseBackupIntegrity,
} from "../src/backup/service.js";
import { acquireBackupLock, releaseBackupLock } from "../src/backup/shared.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const projectRoot = resolve(__dirname, "../..");

describe("Milestone 25 — Production SQLite Database Backup & Disaster Recovery Automation", () => {
  let tempDir: string;
  let dbPath: string;
  let backupDir: string;
  let cfg: ReturnType<typeof makeTestConfig>;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `cloudide-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "test_cloudeeeide.db");
    backupDir = join(tempDir, "backups");
    cfg = makeTestConfig({
      dataDir: tempDir,
      dbPath,
      backupDir,
      maxDatabaseBackups: 3,
      maxBackupBytes: 100 * 1024 * 1024, // 100 MB
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. creates online backup successfully and returns metadata", async () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("alice", "hash123", "user");

      const backup = await createDatabaseBackup(db, cfg);
      expect(backup).toBeDefined();
      expect(backup.filename).toMatch(/^cloudeeeide_backup_.+\.db$/);
      expect(backup.sizeBytes).toBeGreaterThan(0);
      expect(backup.integrity).toBe("ok");
      expect(existsSync(backup.filePath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("2. backup file passes PRAGMA integrity_check", async () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("bob", "hash456", "user");
      const backup = await createDatabaseBackup(db, cfg);
      const integrity = verifyDatabaseBackupIntegrity(backup.filePath);
      expect(integrity).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("3. live reads continue normally during and around backup creation", async () => {
    const db = openDb(dbPath);
    try {
      for (let i = 0; i < 20; i++) {
        db.prepare(
          "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        ).run(`user_${i}`, `hash_${i}`, "user");
      }

      // Read before
      const countBefore = (
        db.prepare("SELECT COUNT(*) as c FROM users").get() as any
      ).c;
      expect(countBefore).toBe(20);

      // Perform backup
      const backup = await createDatabaseBackup(db, cfg);
      expect(backup.integrity).toBe("ok");

      // Read after
      const countAfter = (
        db.prepare("SELECT COUNT(*) as c FROM users").get() as any
      ).c;
      expect(countAfter).toBe(20);
    } finally {
      db.close();
    }
  });

  it("4. representative writes continue before and after backup without lockups", async () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("pre_backup_user", "hash_pre", "user");

      const backup1 = await createDatabaseBackup(db, cfg);
      expect(backup1.integrity).toBe("ok");

      // Immediate write post backup
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("post_backup_user", "hash_post", "user");

      const backup2 = await createDatabaseBackup(db, cfg);
      expect(backup2.integrity).toBe("ok");

      const allUsers = (
        db.prepare("SELECT username FROM users ORDER BY id ASC").all() as any[]
      ).map((u) => u.username);
      expect(allUsers).toContain("pre_backup_user");
      expect(allUsers).toContain("post_backup_user");
    } finally {
      db.close();
    }
  });

  it("5. resulting backup contains committed data and is restorable offline", async () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("charlie", "secret_hash", "admin");
      db.prepare(
        "INSERT INTO projects (id, owner_id, name) VALUES (?, ?, ?)",
      ).run("proj_1", 1, "Project Alpha");

      const backup = await createDatabaseBackup(db, cfg);

      // Open the backup as an independent DB to verify committed contents
      const restoredDb = new DatabaseSync(backup.filePath, { readOnly: true });
      try {
        const user = restoredDb
          .prepare("SELECT * FROM users WHERE username = ?")
          .get("charlie") as any;
        expect(user).toBeDefined();
        expect(user.role).toBe("admin");

        const proj = restoredDb
          .prepare("SELECT * FROM projects WHERE id = ?")
          .get("proj_1") as any;
        expect(proj).toBeDefined();
        expect(proj.name).toBe("Project Alpha");
      } finally {
        restoredDb.close();
      }
    } finally {
      db.close();
    }
  });

  it("6. cleans up partial artifact on failure and leaves live DB untouched", async () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("david", "hash_d", "user");

      // Invalid backupDir with invalid path simulation
      const invalidCfg = {
        ...cfg,
        backupDir: join(tempDir, "invalid\0dir"),
      };

      await expect(createDatabaseBackup(db, invalidCfg)).rejects.toThrow();

      // Live DB must still be healthy and queryable
      const user = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get("david") as any;
      expect(user).toBeDefined();
      expect(user.username).toBe("david");
    } finally {
      db.close();
    }
  });

  it("7. enforces max count retention with oldest-first pruning", async () => {
    const db = openDb(dbPath);
    try {
      // cfg.maxDatabaseBackups is 3
      const b1 = await createDatabaseBackup(db, cfg);
      const b2 = await createDatabaseBackup(db, cfg);
      const b3 = await createDatabaseBackup(db, cfg);

      let list = await listDatabaseBackups(cfg);
      expect(list.length).toBe(3);
      expect(list.map((b) => b.filename)).toEqual([
        b3.filename,
        b2.filename,
        b1.filename,
      ]);

      // 4th backup triggers pruning of the oldest (b1)
      const b4 = await createDatabaseBackup(db, cfg);
      list = await listDatabaseBackups(cfg);
      expect(list.length).toBe(3);
      expect(list.map((b) => b.filename)).toEqual([
        b4.filename,
        b3.filename,
        b2.filename,
      ]);
      expect(existsSync(b1.filePath)).toBe(false);
      expect(existsSync(b2.filePath)).toBe(true);
      expect(existsSync(b4.filePath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("8. enforces max byte retention and prunes oldest when storage exceeds quota", async () => {
    const db = openDb(dbPath);
    try {
      // Populate with some data
      for (let i = 0; i < 50; i++) {
        db.prepare(
          "INSERT INTO audit_logs (event_type, details) VALUES (?, ?)",
        ).run(
          "EXECUTION_COMPLETED",
          JSON.stringify({ index: i, largePayload: "x".repeat(1024) }),
        );
      }

      const b1 = await createDatabaseBackup(db, cfg);
      const backupSize = statSync(b1.filePath).size;

      // Set maxBackupBytes to only allow 2 backups of this size
      const tightByteCfg = {
        ...cfg,
        maxDatabaseBackups: 10,
        maxBackupBytes: backupSize * 2 + 500,
      };

      const b2 = await createDatabaseBackup(db, tightByteCfg);
      void b2;
      const b3 = await createDatabaseBackup(db, tightByteCfg);

      const list = await listDatabaseBackups(tightByteCfg);
      expect(list.length).toBeLessThanOrEqual(2);
      expect(list.some((b) => b.filename === b1.filename)).toBe(false);
      expect(list.some((b) => b.filename === b3.filename)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("9. pruning is idempotent and resilient against deleted files", async () => {
    const db = openDb(dbPath);
    try {
      const b1 = await createDatabaseBackup(db, cfg);
      const b2 = await createDatabaseBackup(db, cfg);

      // Manually delete b1 file behind the back
      rmSync(b1.filePath, { force: true });

      // Prune should run without throwing
      const res = await pruneDatabaseBackups(cfg);
      expect(res).toBeDefined();
      expect(res.prunedCount).toBe(0);

      const list = await listDatabaseBackups(cfg);
      expect(list.length).toBe(1);
      expect(list[0].filename).toBe(b2.filename);
    } finally {
      db.close();
    }
  });

  it("10. backup filename collision safety under rapid concurrent invocation", async () => {
    const db = openDb(dbPath);
    try {
      // Run 3 backup requests concurrently
      const results = await Promise.all([
        createDatabaseBackup(db, cfg),
        createDatabaseBackup(db, cfg),
        createDatabaseBackup(db, cfg),
      ]);

      const filenames = results.map((r) => r.filename);
      const uniqueFilenames = new Set(filenames);
      expect(uniqueFilenames.size).toBe(3);

      for (const r of results) {
        expect(existsSync(r.filePath)).toBe(true);
        expect(verifyDatabaseBackupIntegrity(r.filePath)).toBe("ok");
      }
    } finally {
      db.close();
    }
  });

  it("11. deleteDatabaseBackup safely removes backup file and rejects traversal", async () => {
    const db = openDb(dbPath);
    try {
      const b1 = await createDatabaseBackup(db, cfg);
      expect(existsSync(b1.filePath)).toBe(true);

      // Traversal rejection
      await expect(
        deleteDatabaseBackup(db, cfg, "../escape.db"),
      ).rejects.toThrow();
      await expect(
        deleteDatabaseBackup(db, cfg, "..\\escape.db"),
      ).rejects.toThrow();
      await expect(
        deleteDatabaseBackup(db, cfg, "/etc/passwd"),
      ).rejects.toThrow();
      await expect(
        deleteDatabaseBackup(db, cfg, "invalid\0.db"),
      ).rejects.toThrow();

      // Successful deletion
      const deleted = await deleteDatabaseBackup(db, cfg, b1.filename);
      expect(deleted).toBe(true);
      expect(existsSync(b1.filePath)).toBe(false);

      // 404 on deleting non-existent backup
      await expect(
        deleteDatabaseBackup(db, cfg, b1.filename),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("12. live database remains fully intact and operational after multiple backups", async () => {
    const db = openDb(dbPath);
    try {
      await createDatabaseBackup(db, cfg);
      await createDatabaseBackup(db, cfg);

      // Insert and query
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("final_user", "final_hash", "user");
      const row = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get("final_user") as any;
      expect(row.username).toBe("final_user");

      // Verify WAL mode and pragma integrity
      const pragmaIntegrity = db.prepare("PRAGMA integrity_check").get() as any;
      expect(pragmaIntegrity.integrity_check).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("13. CLI script (scripts/backup-db.js) executes successfully with exit code 0", () => {
    const db = openDb(dbPath);
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("cli_user", "cli_pass", "user");
    db.close();

    const scriptPath = join(projectRoot, "scripts/backup-db.js");
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, `--db-path=${dbPath}`, `--backup-dir=${backupDir}`],
      { encoding: "utf8" },
    );

    expect(stdout).toContain("Veyra SQLite Production Database Backup");
    expect(stdout).toContain("Online backup completed and verified");
    expect(stdout).toContain("Integrity:  ok");

    const backups = listDatabaseBackups(cfg);
    expect(backups).toBeDefined();
  });

  it("14. CLI script exits non-zero on non-existent database", () => {
    const scriptPath = join(projectRoot, "scripts/backup-db.js");
    const nonexistentPath = join(tempDir, "nonexistent.db");

    expect(() => {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          `--db-path=${nonexistentPath}`,
          `--backup-dir=${backupDir}`,
        ],
        { encoding: "utf8", stdio: "pipe" },
      );
    }).toThrow();
  });

  it("19. listDatabaseBackups reports honest integrity: 'unverified' by default, 'ok'/'failed' only when re-verified", async () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
      ).run("integrity_user", "hash_i", "user");
      const backup = await createDatabaseBackup(db, cfg);

      // Default listing must not silently claim verification that never happened.
      const unverifiedList = await listDatabaseBackups(cfg);
      expect(unverifiedList.length).toBe(1);
      expect(unverifiedList[0].integrity).toBe("unverified");

      // Explicit re-verification of a healthy backup reports 'ok'.
      const verifiedList = await listDatabaseBackups(cfg, { verify: true });
      expect(verifiedList[0].integrity).toBe("ok");

      // A backup corrupted after creation must be reported 'failed' when re-verified,
      // never silently reported as still 'ok'.
      writeFileSync(backup.filePath, Buffer.from("not a sqlite file"));
      const corruptedList = await listDatabaseBackups(cfg, { verify: true });
      expect(corruptedList[0].integrity).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("20. create and delete serialize through the same lock — concurrent calls never corrupt state", async () => {
    const db = openDb(dbPath);
    try {
      const existing = await createDatabaseBackup(db, cfg);

      // Fire a delete of the existing backup concurrently with the creation of a
      // new one. Both must settle cleanly with no unhandled exception and the
      // final on-disk state must be exactly what the two operations imply.
      const [deleted, created] = await Promise.all([
        deleteDatabaseBackup(db, cfg, existing.filename),
        createDatabaseBackup(db, cfg),
      ]);

      expect(deleted).toBe(true);
      expect(existsSync(existing.filePath)).toBe(false);
      expect(existsSync(created.filePath)).toBe(true);

      const list = await listDatabaseBackups(cfg);
      expect(list.map((b) => b.filename)).toEqual([created.filename]);
    } finally {
      db.close();
    }
  });

  it("21. filesystem backup lock is present while held and removed on release", () => {
    const lock = acquireBackupLock(backupDir, {
      staleMs: 30_000,
      maxWaitMs: 1000,
    });
    const lockPath = join(backupDir, ".backup.lock");
    expect(existsSync(lockPath)).toBe(true);

    const payload = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(payload.pid).toBe(process.pid);
    expect(payload.token).toBe(lock.token);

    releaseBackupLock(lock);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("22. stale backup lock is reclaimed instead of blocking for the full wait window", () => {
    mkdirSync(backupDir, { recursive: true });
    const lockPath = join(backupDir, ".backup.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        acquiredAt: new Date(0).toISOString(),
        token: "abandoned",
      }),
    );
    // Backdate the file so it looks old regardless of how fast this test runs.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const start = Date.now();
    const lock = acquireBackupLock(backupDir, {
      staleMs: 100,
      maxWaitMs: 5000,
    });
    const elapsed = Date.now() - start;

    // Reclaimed almost immediately, not after exhausting the 5s max wait.
    expect(elapsed).toBeLessThan(2000);
    const payload = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(payload.token).toBe(lock.token);
    expect(payload.token).not.toBe("abandoned");

    releaseBackupLock(lock);
  });

  it("22b. a lock held by a still-alive process is NOT reclaimed merely for being old (age-only staleness would corrupt a legitimately slow backup)", () => {
    mkdirSync(backupDir, { recursive: true });
    const lockPath = join(backupDir, ".backup.lock");
    // Recorded holder is THIS test process — genuinely alive — but the lock
    // file's mtime is backdated well past staleMs, simulating a large
    // production database whose VACUUM INTO legitimately runs longer than
    // the staleness window (the holder can't heartbeat mid-VACUUM-INTO,
    // since it's a single synchronous call).
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date(0).toISOString(),
        token: "still-working",
      }),
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    // A waiter must time out rather than reclaim a lock whose holder PID is
    // still alive, even though it looks stale by age alone.
    expect(() =>
      acquireBackupLock(backupDir, { staleMs: 100, maxWaitMs: 300 }),
    ).toThrow(/Timed out waiting for backup lock/);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(
      "still-working",
    );

    rmSync(lockPath, { force: true });
  });

  it("23. true concurrent cross-process backup attempts (separate OS processes) serialize safely via the shared filesystem lock", async () => {
    const db = openDb(dbPath);
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("cross_process_user", "hash_cp", "user");
    db.close();

    const scriptPath = join(projectRoot, "scripts/backup-db.js");
    const runCli = () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolvePromise) => {
          const child = spawn(
            process.execPath,
            [
              scriptPath,
              `--db-path=${dbPath}`,
              `--backup-dir=${backupDir}`,
              "--max-backups=10",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d.toString()));
          child.stderr.on("data", (d) => (stderr += d.toString()));
          child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
        },
      );

    // Launch two genuinely separate OS processes at (as close to) the same
    // time as possible — this is real cross-process concurrency, not an
    // in-memory Promise race, and is the scenario the filesystem lock exists
    // to protect (e.g. a cron-triggered CLI backup overlapping an
    // admin-triggered server backup).
    const [r1, r2] = await Promise.all([runCli(), runCli()]);

    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(r1.stdout).toContain("Online backup completed and verified");
    expect(r2.stdout).toContain("Online backup completed and verified");

    const list = await listDatabaseBackups(cfg, { verify: true });
    expect(list.length).toBe(2);
    for (const backup of list) {
      expect(backup.integrity).toBe("ok");
    }
  }, 15000);

  it("24. retention stays within configured bounds after a burst of concurrent creates", async () => {
    const db = openDb(dbPath);
    try {
      // cfg.maxDatabaseBackups is 3 — fire 5 concurrent creations, well beyond
      // the retained count, and confirm pruning under lock contention still
      // converges on the configured limit with no corrupted survivors.
      await Promise.all([
        createDatabaseBackup(db, cfg),
        createDatabaseBackup(db, cfg),
        createDatabaseBackup(db, cfg),
        createDatabaseBackup(db, cfg),
        createDatabaseBackup(db, cfg),
      ]);

      const list = await listDatabaseBackups(cfg, { verify: true });
      expect(list.length).toBeLessThanOrEqual(cfg.maxDatabaseBackups);
      for (const backup of list) {
        expect(backup.integrity).toBe("ok");
      }
    } finally {
      db.close();
    }
  });

  it("25. CLI script consumes the shared backup module instead of reimplementing backup logic", () => {
    const scriptSource = readFileSync(
      join(projectRoot, "scripts/backup-db.js"),
      "utf8",
    );

    expect(scriptSource).toMatch(
      /from\s+["']\.\.\/backend\/src\/backup\/shared\.js["']/,
    );
    // Guard against regressing back to the pre-fix duplicated implementation.
    expect(scriptSource).not.toMatch(/function\s+listBackups\s*\(/);
    expect(scriptSource).not.toMatch(/function\s+pruneBackups\s*\(/);
    expect(scriptSource).not.toMatch(/function\s+verifyIntegrity\s*\(/);
  });

  // chmod is a no-op on Windows for the mode bits Node's fs API reports
  // (verified: statSync().mode is unchanged after chmodSync on this
  // platform's filesystem), so these assertions are only meaningful — and
  // only run — on POSIX, which is the actual production deployment target.
  it.skipIf(process.platform === "win32")(
    "26. restricts the backup file to 0o600 (owner-only) on POSIX",
    async () => {
      const db = openDb(dbPath);
      try {
        const backup = await createDatabaseBackup(db, cfg);
        const mode = statSync(backup.filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        db.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "27. restricts the backup directory to 0o700 (owner-only) on POSIX",
    async () => {
      const db = openDb(dbPath);
      try {
        await createDatabaseBackup(db, cfg);
        const mode = statSync(cfg.backupDir).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        db.close();
      }
    },
  );

  describe("Admin API HTTP Endpoints", () => {
    let api: TestApi;
    let adminToken: string;
    let userToken: string;

    beforeEach(async () => {
      api = await startTestApi(cfg);

      // 1. Create normal user
      const userRes = await api.request("POST", "/api/auth/register", {
        body: { username: "regularuser", password: "userpassword123" },
      });
      userToken = userRes.data.token;

      // 2. Create admin user in db and login
      const adminHash = await hashPassword("AdminPass@123");
      ensureAdminUser(api.db, "adminuser", adminHash);

      const adminRes = await api.request("POST", "/api/auth/admin-login", {
        body: { username: "adminuser", password: "AdminPass@123" },
      });
      adminToken = adminRes.data.token;
    });

    afterEach(async () => {
      await api.close();
    });

    it("15. GET /api/admin/backups rejects non-admin users and allows admins", async () => {
      // Unauthenticated
      const anonRes = await api.request("GET", "/api/admin/backups");
      expect(anonRes.status).toBe(401);

      // Regular user
      const userRes = await api.request("GET", "/api/admin/backups", {
        token: userToken,
      });
      expect(userRes.status).toBe(403);

      // Admin user
      const adminRes = await api.request("GET", "/api/admin/backups", {
        token: adminToken,
      });
      expect(adminRes.status).toBe(200);
      expect(Array.isArray(adminRes.data.backups)).toBe(true);
    });

    it("16. POST /api/admin/backups creates and returns verified backup metadata", async () => {
      const createRes = await api.request("POST", "/api/admin/backups", {
        token: adminToken,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.data.ok).toBe(true);
      expect(createRes.data.backup).toBeDefined();
      expect(createRes.data.backup.filename).toMatch(
        /^cloudeeeide_backup_.+\.db$/,
      );
      expect(createRes.data.backup.integrity).toBe("ok");

      const listRes = await api.request("GET", "/api/admin/backups", {
        token: adminToken,
      });
      expect(listRes.data.backups.length).toBe(1);
      expect(listRes.data.backups[0].filename).toBe(
        createRes.data.backup.filename,
      );
    });

    it("17. GET /api/admin/backups/:filename downloads backup file and rejects traversal", async () => {
      const createRes = await api.request("POST", "/api/admin/backups", {
        token: adminToken,
      });
      const filename = createRes.data.backup.filename;

      // Traversal rejection
      const traversalRes = await api.request(
        "GET",
        "/api/admin/backups/..%2F..%2Fetc%2Fpasswd",
        {
          token: adminToken,
        },
      );
      expect(traversalRes.status).toBe(400);

      // Non-admin download rejection
      const userRes = await api.request(
        "GET",
        `/api/admin/backups/${filename}`,
        { token: userToken },
      );
      expect(userRes.status).toBe(403);

      // Admin download success
      const downloadRes = await api.request(
        "GET",
        `/api/admin/backups/${filename}`,
        {
          token: adminToken,
        },
      );
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.text.length).toBeGreaterThan(0);

      // Downloading a full database export is sensitive enough to audit.
      const auditRes = await api.request(
        "GET",
        "/api/admin/audit?eventType=DATABASE_BACKUP_DOWNLOADED",
        { token: adminToken },
      );
      expect(auditRes.status).toBe(200);
      expect(
        auditRes.data.logs.some((l: any) => l.details.filename === filename),
      ).toBe(true);
    });

    it("18. DELETE /api/admin/backups/:filename deletes backup file and records audit log", async () => {
      const createRes = await api.request("POST", "/api/admin/backups", {
        token: adminToken,
      });
      const filename = createRes.data.backup.filename;

      // Delete endpoint
      const delRes = await api.request(
        "DELETE",
        `/api/admin/backups/${filename}`,
        {
          token: adminToken,
        },
      );
      expect(delRes.status).toBe(200);
      expect(delRes.data.deleted).toBe(filename);

      // List should now be empty
      const listRes = await api.request("GET", "/api/admin/backups", {
        token: adminToken,
      });
      expect(listRes.data.backups.length).toBe(0);

      // Check audit log
      const auditRes = await api.request(
        "GET",
        "/api/admin/audit?eventType=DATABASE_BACKUP_DELETED",
        {
          token: adminToken,
        },
      );
      expect(auditRes.status).toBe(200);
      expect(
        auditRes.data.logs.some((l: any) => l.details.filename === filename),
      ).toBe(true);
    });
  });
});
