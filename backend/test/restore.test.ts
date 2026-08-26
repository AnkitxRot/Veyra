import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { openDb } from "../src/db.js";
import { createDatabaseBackup } from "../src/backup/service.js";
import {
  restoreDatabaseFromBackup,
  RestoreIntegrityError,
  RestoreVerificationError,
  withBackupLockSync,
  listBackupFilesSync,
} from "../src/backup/shared.js";
import { makeTestConfig } from "./helpers.js";

const projectRoot = resolve(__dirname, "../..");

function seedUser(dbPath: string, username: string) {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run(username, "hash", "user");
  } finally {
    db.close();
  }
}

function listUsernames(dbPath: string): string[] {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT username FROM users ORDER BY username")
      .all() as { username: string }[];
    return rows.map((r) => r.username);
  } finally {
    db.close();
  }
}

describe("Milestone 30 — Automated Database Restore & Disaster-Recovery Verification", () => {
  let tempDir: string;
  let dbPath: string;
  let backupDir: string;
  let cfg: ReturnType<typeof makeTestConfig>;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `cloudide-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "test_cloudeeeide.db");
    backupDir = join(tempDir, "backups");
    cfg = makeTestConfig({
      dataDir: tempDir,
      dbPath,
      backupDir,
      maxDatabaseBackups: 10,
      maxBackupBytes: 100 * 1024 * 1024,
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. valid restore replaces the live DB's mutated state with the backup's original content", async () => {
    seedUser(dbPath, "original_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    // Mutate the live DB after the backup was taken.
    seedUser(dbPath, "post_backup_mutation_user");
    expect(listUsernames(dbPath)).toEqual([
      "original_user",
      "post_backup_mutation_user",
    ]);

    const result = restoreDatabaseFromBackup({
      dbPath,
      backupDir,
      filename: backup.filename,
    });

    expect(result.postRestoreIntegrity).toBe("ok");
    expect(result.restoredFrom).toBe(backup.filename);
    expect(listUsernames(dbPath)).toEqual(["original_user"]);
  });

  it("2. a corrupt backup is rejected and the live DB is provably untouched", async () => {
    seedUser(dbPath, "live_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    // Corrupt the backup file after creation.
    writeFileSync(backup.filePath, Buffer.from("not a sqlite file"));

    const beforeContent = readFileSync(dbPath);

    expect(() =>
      restoreDatabaseFromBackup({
        dbPath,
        backupDir,
        filename: backup.filename,
      }),
    ).toThrow(RestoreIntegrityError);

    const afterContent = readFileSync(dbPath);
    expect(Buffer.compare(beforeContent, afterContent)).toBe(0);
    expect(listUsernames(dbPath)).toEqual(["live_user"]);
    // No safety copy should have been made — nothing was mutated.
    expect(existsSync(join(tempDir, "restore-safety"))).toBe(false);
  });

  it("3. traversal / absolute / Windows-style / null-byte filenames are all rejected safely", async () => {
    seedUser(dbPath, "traversal_user");
    const db = openDb(dbPath);
    await createDatabaseBackup(db, cfg);
    db.close();

    const malicious = [
      "../foo.db",
      "/etc/passwd",
      "C:\\Windows\\System32\\config.db",
      "evil\0.db",
      "..\\..\\secrets.db",
    ];
    for (const filename of malicious) {
      expect(() =>
        restoreDatabaseFromBackup({ dbPath, backupDir, filename }),
      ).toThrow(/Invalid backup filename/);
    }
    // Live DB must be completely unaffected by any of the rejected attempts.
    expect(listUsernames(dbPath)).toEqual(["traversal_user"]);
  });

  it("4. a timestamped safety copy of the pre-restore state is created and contains the ORIGINAL data, not the restored data", async () => {
    seedUser(dbPath, "backup_snapshot_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    seedUser(dbPath, "pre_restore_live_user");

    const result = restoreDatabaseFromBackup({
      dbPath,
      backupDir,
      filename: backup.filename,
    });

    expect(result.safetyCopyPath).toBeTruthy();
    expect(existsSync(result.safetyCopyPath!)).toBe(true);

    // The safety copy must reflect the state immediately BEFORE restore
    // (both users present), not the restored state (only the original).
    const safetyUsernames = listUsernames(result.safetyCopyPath!);
    expect(safetyUsernames).toEqual([
      "backup_snapshot_user",
      "pre_restore_live_user",
    ]);
    // Confirms the live DB itself is now the restored (pre-mutation) state.
    expect(listUsernames(dbPath)).toEqual(["backup_snapshot_user"]);
  });

  it("5. stale live WAL/SHM sidecars are removed after restore; safety-copy sidecars are preserved", async () => {
    seedUser(dbPath, "wal_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    // Simulate leftover WAL/SHM sidecars from the pre-restore generation
    // (SQLite's own close-time checkpoint behavior is not deterministic
    // enough to rely on for this test, so these are explicitly planted).
    writeFileSync(dbPath + "-wal", Buffer.from("fake-wal-content"));
    writeFileSync(dbPath + "-shm", Buffer.from("fake-shm-content"));

    const result = restoreDatabaseFromBackup({
      dbPath,
      backupDir,
      filename: backup.filename,
    });

    // Stale sidecars at the LIVE path must be gone — they describe the
    // pre-restore generation and must never be replayed against the
    // freshly-restored file.
    expect(existsSync(dbPath + "-wal")).toBe(false);
    expect(existsSync(dbPath + "-shm")).toBe(false);

    // The safety copy's own sidecars must be preserved untouched.
    expect(existsSync(result.safetyCopyPath! + "-wal")).toBe(true);
    expect(existsSync(result.safetyCopyPath! + "-shm")).toBe(true);
    expect(readFileSync(result.safetyCopyPath! + "-wal").toString()).toBe(
      "fake-wal-content",
    );
    expect(readFileSync(result.safetyCopyPath! + "-shm").toString()).toBe(
      "fake-shm-content",
    );
  });

  it("6. --latest selects the newest backup by the same ordering listBackupFilesSync uses", async () => {
    seedUser(dbPath, "first_state_user");
    let db = openDb(dbPath);
    const older = await createDatabaseBackup(db, cfg);
    db.close();

    // Force a deterministic, distinguishable ordering.
    await new Promise((r) => setTimeout(r, 20));

    seedUser(dbPath, "second_state_user");
    db = openDb(dbPath);
    const newer = await createDatabaseBackup(db, cfg);
    db.close();

    expect(newer.filename).not.toBe(older.filename);

    const backups = listBackupFilesSync(backupDir);
    expect(backups[0].filename).toBe(newer.filename);

    seedUser(dbPath, "post_backups_mutation_user");

    const result = restoreDatabaseFromBackup({
      dbPath,
      backupDir,
      filename: backups[0].filename,
    });
    expect(result.restoredFrom).toBe(newer.filename);
    // The newer backup contains both seeded users at the time it was taken.
    expect(listUsernames(dbPath)).toEqual([
      "first_state_user",
      "second_state_user",
    ]);
  });

  it("7. real cross-process concurrency: a spawned restore and a spawned backup against the same backupDir serialize through the shared lock", async () => {
    seedUser(dbPath, "cross_process_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    const restoreScript = join(projectRoot, "scripts/restore-db.js");
    const backupScript = join(projectRoot, "scripts/backup-db.js");

    const runCli = (scriptPath: string, extraArgs: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolvePromise) => {
          const child = spawn(
            process.execPath,
            [
              scriptPath,
              `--db-path=${dbPath}`,
              `--backup-dir=${backupDir}`,
              ...extraArgs,
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

    // Two genuinely separate OS processes launched at (as close to) the
    // same time as possible, sharing the same backupDir and lock.
    const [restoreResult, backupResult] = await Promise.all([
      runCli(restoreScript, [`--backup-file=${backup.filename}`]),
      runCli(backupScript, ["--max-backups=10"]),
    ]);

    expect(restoreResult.code).toBe(0);
    expect(backupResult.code).toBe(0);
    expect(restoreResult.stdout).toContain("Database restored and verified");
    expect(backupResult.stdout).toContain(
      "Online backup completed and verified",
    );

    // Both operations' outputs must be individually valid — no torn/corrupt
    // artifact from the two processes racing the same directory.
    expect(listUsernames(dbPath)).toEqual(["cross_process_user"]);
    const list = listBackupFilesSync(backupDir);
    expect(list.length).toBeGreaterThanOrEqual(2);
  }, 15000);

  it("8. restoring the same verified backup repeatedly is deterministic and leaks no locks or files", async () => {
    seedUser(dbPath, "repeat_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    for (let i = 0; i < 3; i++) {
      seedUser(dbPath, `mutation_${i}`);
      const result = restoreDatabaseFromBackup({
        dbPath,
        backupDir,
        filename: backup.filename,
      });
      expect(result.postRestoreIntegrity).toBe("ok");
      expect(listUsernames(dbPath)).toEqual(["repeat_user"]);
    }

    // No leaked lock file — a subsequent lock acquisition must succeed
    // immediately rather than time out.
    expect(() =>
      withBackupLockSync(backupDir, { maxWaitMs: 1000 }, () => {}),
    ).not.toThrow();

    // Three distinct safety copies were retained (never auto-deleted).
    const safetyDir = join(tempDir, "restore-safety");
    const safetyFiles = readdirSync(safetyDir) as string[];
    expect(safetyFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("9. a failed post-restore verification is reported as failure and preserves the safety copy (no silent success, no auto-rollback)", async () => {
    seedUser(dbPath, "verify_fail_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    seedUser(dbPath, "pre_restore_state_user");

    const backupPath = join(backupDir, backup.filename);
    // Test-only injection: the backup itself genuinely passes integrity
    // (proving step C's check is real), but the post-restore check on the
    // live path is forced to report corruption, exercising the "report
    // failure, do not auto-rollback, preserve the safety copy" branch
    // without needing to fabricate genuine on-disk corruption mid-copy.
    let calls = 0;
    const integrityCheckFn = (filePath: string) => {
      calls++;
      if (filePath === backupPath) return "ok";
      return "simulated post-restore corruption";
    };

    expect(() =>
      restoreDatabaseFromBackup({
        dbPath,
        backupDir,
        filename: backup.filename,
        integrityCheckFn,
      }),
    ).toThrow(RestoreVerificationError);
    expect(calls).toBe(2); // pre-restore (backup) + post-restore (live) checks both ran

    try {
      restoreDatabaseFromBackup({
        dbPath,
        backupDir,
        filename: backup.filename,
        integrityCheckFn,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreVerificationError);
      const restoreErr = err as InstanceType<typeof RestoreVerificationError>;
      expect(restoreErr.safetyCopyPath).toBeTruthy();
      expect(existsSync(restoreErr.safetyCopyPath!)).toBe(true);
      expect(restoreErr.postRestoreIntegrity).toBe(
        "simulated post-restore corruption",
      );
    }
  });

  it("10. CLI semantics: missing args, both args, invalid backup, and exit codes", async () => {
    seedUser(dbPath, "cli_semantics_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    const scriptPath = join(projectRoot, "scripts/restore-db.js");

    // Missing args.
    expect(() =>
      execFileSync(
        process.execPath,
        [scriptPath, `--db-path=${dbPath}`, `--backup-dir=${backupDir}`],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow();

    // Both args.
    expect(() =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          `--db-path=${dbPath}`,
          `--backup-dir=${backupDir}`,
          `--backup-file=${backup.filename}`,
          "--latest",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow();

    // Invalid/non-existent backup filename.
    expect(() =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          `--db-path=${dbPath}`,
          `--backup-dir=${backupDir}`,
          "--backup-file=cloudeeeide_backup_does-not-exist_ffffffff.db",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow();

    // Success: exit code 0.
    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        `--db-path=${dbPath}`,
        `--backup-dir=${backupDir}`,
        `--backup-file=${backup.filename}`,
      ],
      { encoding: "utf8" },
    );
    expect(stdout).toContain("OFFLINE OPERATION");
    expect(stdout).toContain("Database restored and verified");
  });

  it("11. restore-db.js imports shared restore logic instead of reimplementing validation/locking/integrity code", () => {
    const scriptSource = readFileSync(
      join(projectRoot, "scripts/restore-db.js"),
      "utf8",
    );

    expect(scriptSource).toMatch(
      /from\s+["']\.\.\/backend\/src\/backup\/shared\.js["']/,
    );
    expect(scriptSource).toMatch(/restoreDatabaseFromBackup/);
    expect(scriptSource).toMatch(/withBackupLockSync/);
    // Guard against regressing into a duplicated implementation.
    expect(scriptSource).not.toMatch(/PRAGMA integrity_check/);
    expect(scriptSource).not.toMatch(/function\s+assertValidRestoreFilename/);
  });

  it("12. after a successful restore, the live DB is immediately usable for a representative real query", async () => {
    seedUser(dbPath, "usability_user");
    const db = openDb(dbPath);
    const backup = await createDatabaseBackup(db, cfg);
    db.close();

    seedUser(dbPath, "will_be_reverted_user");

    restoreDatabaseFromBackup({ dbPath, backupDir, filename: backup.filename });

    const reopened = openDb(dbPath);
    try {
      const row = reopened.prepare("SELECT COUNT(*) as c FROM users").get() as {
        c: number;
      };
      expect(row.c).toBe(1);
      const inserted = reopened
        .prepare(
          "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        )
        .run("post_restore_write_check", "hash", "user");
      expect(Number(inserted.changes)).toBe(1);
    } finally {
      reopened.close();
    }
  });
});
