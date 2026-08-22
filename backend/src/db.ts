import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSyncType;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      language   TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS runs (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      language            TEXT NOT NULL,
      file_path           TEXT NOT NULL,
      status              TEXT NOT NULL,
      exit_code           INTEGER,
      signal              TEXT,
      duration_ms         INTEGER NOT NULL DEFAULT 0,
      peak_memory_bytes   INTEGER DEFAULT 0,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      event_type  TEXT NOT NULL,
      details     TEXT NOT NULL,
      ip_address  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS snapshots (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots(user_id);

    CREATE TABLE IF NOT EXISTS telemetry_samples (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sandbox_id          TEXT NOT NULL,
      execution_id        TEXT,
      cpu_percent         REAL NOT NULL,
      memory_usage_bytes  INTEGER NOT NULL,
      memory_limit_bytes  INTEGER NOT NULL,
      pids                INTEGER NOT NULL,
      network_rx_bytes    INTEGER NOT NULL DEFAULT 0,
      network_tx_bytes    INTEGER NOT NULL DEFAULT 0,
      block_read_bytes    INTEGER NOT NULL DEFAULT 0,
      block_write_bytes   INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_project_time ON telemetry_samples(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_sandbox_time ON telemetry_samples(sandbox_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_execution_time ON telemetry_samples(execution_id, created_at);

    CREATE TABLE IF NOT EXISTS resource_anomalies (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sandbox_id          TEXT,
      execution_id        TEXT,
      anomaly_type        TEXT NOT NULL,
      severity            TEXT NOT NULL,
      title               TEXT NOT NULL,
      reason              TEXT NOT NULL,
      details             TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'active',
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_anomalies_project ON resource_anomalies(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_anomalies_status ON resource_anomalies(status);
  `);
  runMigrations(db);
  return db;
}

export const BASELINE_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  description: string;
  up: (db: Db) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: 'Add runs and audit_logs tables',
    up: (db: Db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id                  TEXT PRIMARY KEY,
          project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          language            TEXT NOT NULL,
          file_path           TEXT NOT NULL,
          status              TEXT NOT NULL,
          exit_code           INTEGER,
          signal              TEXT,
          duration_ms         INTEGER NOT NULL DEFAULT 0,
          peak_memory_bytes   INTEGER DEFAULT 0,
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
        CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id);
        CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

        CREATE TABLE IF NOT EXISTS audit_logs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
          event_type  TEXT NOT NULL,
          details     TEXT NOT NULL,
          ip_address  TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      `);
    },
  },
  {
    version: 3,
    description: 'Add snapshots table',
    up: (db: Db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots(user_id);
      `);
    },
  },
  {
    version: 4,
    description: 'Add role column to users table',
    up: (db: Db) => {
      try {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      } catch (err: any) {
        if (!err.message?.includes('duplicate column name')) {
          throw err;
        }
      }
    },
  },
  {
    version: 5,
    description: 'Add telemetry_samples and resource_anomalies tables',
    up: (db: Db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_samples (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          sandbox_id          TEXT NOT NULL,
          execution_id        TEXT,
          cpu_percent         REAL NOT NULL,
          memory_usage_bytes  INTEGER NOT NULL,
          memory_limit_bytes  INTEGER NOT NULL,
          pids                INTEGER NOT NULL,
          network_rx_bytes    INTEGER NOT NULL DEFAULT 0,
          network_tx_bytes    INTEGER NOT NULL DEFAULT 0,
          block_read_bytes    INTEGER NOT NULL DEFAULT 0,
          block_write_bytes   INTEGER NOT NULL DEFAULT 0,
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_telemetry_project_time ON telemetry_samples(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_telemetry_sandbox_time ON telemetry_samples(sandbox_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_telemetry_execution_time ON telemetry_samples(execution_id, created_at);

        CREATE TABLE IF NOT EXISTS resource_anomalies (
          id                  TEXT PRIMARY KEY,
          project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          sandbox_id          TEXT,
          execution_id        TEXT,
          anomaly_type        TEXT NOT NULL,
          severity            TEXT NOT NULL,
          title               TEXT NOT NULL,
          reason              TEXT NOT NULL,
          details             TEXT NOT NULL,
          status              TEXT NOT NULL DEFAULT 'active',
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at         TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_anomalies_project ON resource_anomalies(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_anomalies_status ON resource_anomalies(status);
      `);
    },
  },
  {
    version: 6,
    description: 'Create project_collaborators table for M4 real-time multiplayer sharing',
    up(db: Db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_collaborators (
          project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role         TEXT NOT NULL DEFAULT 'editor',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_collab_project ON project_collaborators(project_id);
        CREATE INDEX IF NOT EXISTS idx_collab_user ON project_collaborators(user_id);
      `);
    },
  },
  {
    version: 7,
    description: 'Create ai_verifications journal table for M5 verification-aware AI assistant',
    up(db: Db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_verifications (
          id              TEXT PRIMARY KEY,
          project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          action          TEXT NOT NULL,
          provider_type   TEXT NOT NULL,
          model_name      TEXT,
          status          TEXT NOT NULL,
          file_path       TEXT,
          explanation     TEXT,
          diff_summary    TEXT,
          snapshot_id     TEXT,
          execution_id    TEXT,
          exit_code       INTEGER,
          stdout_summary  TEXT,
          stderr_summary  TEXT,
          skip_reason     TEXT,
          duration_ms     INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ai_verif_proj ON ai_verifications(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_verif_status ON ai_verifications(status);
      `);
    },
  },
];

export function getSchemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row?.v ?? 0;
}

function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  let current = getSchemaVersion(db);
  if (current === 0) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(BASELINE_SCHEMA_VERSION);
    current = BASELINE_SCHEMA_VERSION;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
      db.exec('COMMIT');
      current = migration.version;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure; the original migration error is what matters
      }
      throw err;
    }
  }
}

export function ensureAdminUser(db: Db, username: string, passwordHash: string): void {
  const existing = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username) as { id: number; role: string } | undefined;
  if (!existing) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, 'admin');
  } else if (existing.role !== 'admin') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', existing.id);
  }
}
