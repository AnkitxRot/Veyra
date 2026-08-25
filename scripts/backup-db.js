#!/usr/bin/env node
/**
 * Milestone 25 — Production SQLite Database Backup & Disaster Recovery Automation
 *
 * Usage:
 *   node scripts/backup-db.js
 *   npm run db:backup
 *   node scripts/backup-db.js --backup-dir=/custom/backups --max-backups=20
 *
 * Shares filename generation, integrity verification, list/prune retention
 * math, and cross-process locking with the server's backup service
 * (backend/src/backup/shared.js) — do not reimplement any of that here.
 */

import { createRequire } from "node:module";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateBackupFilename,
  verifyDatabaseBackupIntegrity,
  pruneBackupFilesSync,
  withBackupLockSync,
} from "../backend/src/backup/shared.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

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
    maxBackups: Number(process.env.MAX_DATABASE_BACKUPS ?? 10),
    maxBytes: Number(process.env.MAX_BACKUP_BYTES ?? 100 * 1024 * 1024),
    lockStaleMs: Number(process.env.BACKUP_LOCK_STALE_MS ?? 30_000),
  };

  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      console.log(`
Veyra SQLite Production Database Backup CLI

Usage:
  node scripts/backup-db.js [options]
  npm run db:backup

Options:
  --data-dir=<path>     Base data directory (default: DATA_DIR env or standard path)
  --db-path=<path>      Database file path (default: <data-dir>/cloudeeeide.db)
  --backup-dir=<path>   Target backup directory (default: <data-dir>/backups)
  --max-backups=<count> Maximum backup count to retain (default: 10)
  --max-bytes=<bytes>   Maximum total backup storage bytes (default: 104857600)
  -h, --help            Show this help message
`);
      process.exit(0);
    } else if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice(11).trim();
    } else if (arg.startsWith("--db-path=")) {
      options.dbPath = arg.slice(10).trim();
    } else if (arg.startsWith("--backup-dir=")) {
      options.backupDir = arg.slice(13).trim();
    } else if (arg.startsWith("--max-backups=")) {
      options.maxBackups = Number(arg.slice(14).trim());
    } else if (arg.startsWith("--max-bytes=")) {
      options.maxBytes = Number(arg.slice(12).trim());
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

async function main() {
  const opts = parseArgs();

  console.log("============================================================");
  console.log("  Veyra SQLite Production Database Backup");
  console.log("============================================================");
  console.log(`  Target Database:  ${opts.dbPath}`);
  console.log(`  Backup Directory: ${opts.backupDir}`);

  if (!existsSync(opts.dbPath)) {
    console.error(`\n[ERROR] Database file not found at ${opts.dbPath}`);
    process.exit(1);
  }

  let result;
  try {
    // Cross-process lock: coordinates this CLI invocation (e.g. cron) with
    // any server-triggered admin backup hitting the same backupDir, so the
    // two can never race on VACUUM INTO or retention pruning.
    result = withBackupLockSync(
      opts.backupDir,
      { staleMs: opts.lockStaleMs },
      () => {
        const filename = generateBackupFilename();
        const backupPath = join(opts.backupDir, filename);

        const startTime = Date.now();
        let db;
        try {
          db = new DatabaseSync(opts.dbPath);
          const escaped = backupPath.replace(/'/g, "''");
          db.exec(`VACUUM INTO '${escaped}'`);
        } catch (err) {
          try {
            rmSync(backupPath, { force: true });
          } catch {}
          throw new Error(`VACUUM INTO execution failed: ${err.message}`);
        } finally {
          if (db) {
            try {
              db.close();
            } catch {}
          }
        }

        const integrity = verifyDatabaseBackupIntegrity(backupPath);
        if (integrity !== "ok") {
          try {
            rmSync(backupPath, { force: true });
          } catch {}
          throw new Error(`Backup integrity verification failed: ${integrity}`);
        }

        const stat = statSync(backupPath);
        const durationMs = Date.now() - startTime;
        const pruneResult = pruneBackupFilesSync(
          opts.backupDir,
          opts.maxBackups,
          opts.maxBytes,
        );

        return { filename, stat, durationMs, integrity, pruneResult };
      },
    );
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }

  const { filename, stat, durationMs, integrity, pruneResult } = result;

  console.log("\n  ✓ Online backup completed and verified:");
  console.log(`    File:       ${filename}`);
  console.log(
    `    Size:       ${stat.size.toLocaleString()} bytes (${(stat.size / 1024).toFixed(1)} KB)`,
  );
  console.log(`    Duration:   ${durationMs}ms`);
  console.log(`    Integrity:  ${integrity}`);
  console.log(
    `    Retention:  ${pruneResult.remainingCount} backups retained (${pruneResult.prunedCount} pruned)`,
  );
  console.log("============================================================\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
