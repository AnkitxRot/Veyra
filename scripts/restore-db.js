#!/usr/bin/env node
/**
 * Milestone 30 — Automated Database Restore & Disaster-Recovery Verification
 *
 * OFFLINE OPERATION ONLY. This command must be run with the Veyra
 * application process stopped. It replaces the live SQLite database file on
 * disk, which is only safe when nothing still has that file open; this tool
 * cannot reliably detect whether the app is still running and does not try
 * to guess — stopping the app first is the operator's responsibility (see
 * deploy/README.md's Offline Disaster Recovery Runbook).
 *
 * Usage:
 *   node scripts/restore-db.js --backup-file=<filename>
 *   node scripts/restore-db.js --latest
 *   npm run db:restore -- --latest
 *
 * Shares filename validation, integrity verification, and cross-process
 * locking with the server's backup service and scripts/backup-db.js
 * (backend/src/backup/shared.js) — do not reimplement any of that here.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  listBackupFilesSync,
  restoreDatabaseFromBackup,
  withBackupLockSync,
} from "../backend/src/backup/shared.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dataDir:
      process.env.DATA_DIR ??
      (process.platform === "win32"
        ? join(homedir(), ".cloud-ide")
        : "/var/lib/cloud-ide"),
    dbPath: process.env.DATABASE_PATH,
    backupDir: process.env.BACKUP_DIR,
    lockStaleMs: Number(process.env.BACKUP_LOCK_STALE_MS ?? 30_000),
    backupFile: null,
    latest: false,
  };

  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      console.log(`
Veyra SQLite Database Restore CLI — OFFLINE OPERATION

This command must be run with the Veyra application STOPPED. It replaces
the live database file on disk; nothing may still have it open.

Usage:
  node scripts/restore-db.js --backup-file=<filename>
  node scripts/restore-db.js --latest
  npm run db:restore -- --latest

Options:
  --data-dir=<path>     Base data directory (default: DATA_DIR env or standard path)
  --db-path=<path>      Live database file path (default: <data-dir>/cloudeeeide.db)
  --backup-dir=<path>   Backup directory to restore from (default: <data-dir>/backups)
  --backup-file=<name>  Exact backup filename to restore (mutually exclusive with --latest)
  --latest              Restore the most recent backup in --backup-dir
  -h, --help            Show this help message
`);
      process.exit(0);
    } else if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice(11).trim();
    } else if (arg.startsWith("--db-path=")) {
      options.dbPath = arg.slice(10).trim();
    } else if (arg.startsWith("--backup-dir=")) {
      options.backupDir = arg.slice(13).trim();
    } else if (arg.startsWith("--backup-file=")) {
      options.backupFile = arg.slice(14).trim();
    } else if (arg === "--latest") {
      options.latest = true;
    }
  }

  if (!options.dbPath) {
    options.dbPath = join(options.dataDir, "cloudeeeide.db");
  }
  if (!options.backupDir) {
    options.backupDir = join(options.dataDir, "backups");
  }

  return options;
}

function main() {
  const opts = parseArgs();

  if (opts.backupFile && opts.latest) {
    console.error(
      "\n[ERROR] Specify exactly one of --backup-file=<name> or --latest, not both.",
    );
    process.exit(1);
  }
  if (!opts.backupFile && !opts.latest) {
    console.error(
      "\n[ERROR] Specify exactly one of --backup-file=<name> or --latest.\n" +
        "        Run with -h for usage.",
    );
    process.exit(1);
  }

  console.log("============================================================");
  console.log("  Veyra SQLite Database Restore — OFFLINE OPERATION");
  console.log("============================================================");
  console.log("  This command must be run with the Veyra application STOPPED.");
  console.log(`  Live Database:    ${opts.dbPath}`);
  console.log(`  Backup Directory: ${opts.backupDir}`);

  let filename = opts.backupFile;
  if (opts.latest) {
    const backups = listBackupFilesSync(opts.backupDir);
    if (backups.length === 0) {
      console.error(`\n[ERROR] No backups found in ${opts.backupDir}`);
      process.exit(1);
    }
    filename = backups[0].filename;
    console.log(`  Selected (latest): ${filename}`);
  } else {
    console.log(`  Selected:          ${filename}`);
  }

  let result;
  try {
    result = withBackupLockSync(
      opts.backupDir,
      { staleMs: opts.lockStaleMs },
      () =>
        restoreDatabaseFromBackup({
          dbPath: opts.dbPath,
          backupDir: opts.backupDir,
          filename,
        }),
    );
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    if (err.safetyCopyPath) {
      console.error(
        `[ERROR] Pre-restore safety copy preserved at: ${err.safetyCopyPath}`,
      );
    }
    process.exit(1);
  }

  console.log("\n  ✓ Database restored and verified:");
  console.log(`    Restored From:           ${result.restoredFrom}`);
  console.log(
    `    Backup Size:             ${result.backupSizeBytes.toLocaleString()} bytes`,
  );
  console.log(
    `    Pre-Restore Safety Copy: ${result.safetyCopyPath ?? "(none — no prior live database existed)"}`,
  );
  console.log(`    Post-Restore Integrity:  ${result.postRestoreIntegrity}`);
  console.log(`    Duration:                ${result.durationMs}ms`);
  console.log("");
  console.log(
    "  Any live database writes after this backup's creation timestamp are",
  );
  console.log(
    "  permanently lost — this is expected behavior for a restore, not an error.",
  );
  console.log(
    "  Start the application service now, then run: npm run deploy:smoke",
  );
  console.log("============================================================\n");
  process.exit(0);
}

main();
