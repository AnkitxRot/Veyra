import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSyncType;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

// M61 (v12): persistent code-anchored comment threads (Track A) + the
// versioned per-user settings blob (Track B) + server-authoritative profile
// identity tables (Track C). See
// docs/superpowers/specs/2026-08-31-m61-contextual-comments-customization-design.md
// §4.3 (comments) and §6.3 (profile). Anchors are stored as opaque
// Y.RelativePosition blobs — the server never decodes or resolves them.
const M61_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS comment_threads (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path          TEXT NOT NULL,
      anchor_rel_start   BLOB,
      anchor_rel_end     BLOB,
      anchor_start_line  INTEGER NOT NULL,
      anchor_end_line    INTEGER NOT NULL,
      anchor_prefix_hash TEXT NOT NULL,
      anchor_prefix      TEXT NOT NULL,
      anchor_status      TEXT NOT NULL DEFAULT 'ok',
      created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at        TEXT,
      resolved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      root_comment_id    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comment_threads_project_file
      ON comment_threads(project_id, file_path, resolved_at);
    CREATE INDEX IF NOT EXISTS idx_comment_threads_project_updated
      ON comment_threads(project_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS comments (
      id                TEXT PRIMARY KEY,
      thread_id         TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      author_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body              TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at         TEXT,
      deleted_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id, created_at, id);

    CREATE TABLE IF NOT EXISTS comment_mentions (
      comment_id        TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (comment_id, mentioned_user_id)
    );

    CREATE TABLE IF NOT EXISTS comment_reactions (
      comment_id        TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji             TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (comment_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL DEFAULT 1,
      data        TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_media (
      id           TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,
      mime         TEXT NOT NULL,
      width        INTEGER NOT NULL,
      height       INTEGER NOT NULL,
      bytes        INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_profile_media_user ON profile_media(user_id, kind);

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name         TEXT,
      pronouns             TEXT,
      location             TEXT,
      bio                  TEXT,
      avatar_media_id      TEXT REFERENCES profile_media(id) ON DELETE SET NULL,
      banner_kind          TEXT NOT NULL DEFAULT 'none',
      banner_value         TEXT,
      banner_media_id      TEXT REFERENCES profile_media(id) ON DELETE SET NULL,
      profile_accent       TEXT NOT NULL DEFAULT 'inherit',
      profile_effect       TEXT NOT NULL DEFAULT 'none',
      availability_default  TEXT NOT NULL DEFAULT 'online',
      profile_visibility    TEXT NOT NULL DEFAULT 'collaborators',
      show_location         INTEGER NOT NULL DEFAULT 1,
      show_links            INTEGER NOT NULL DEFAULT 1,
      show_activity         INTEGER NOT NULL DEFAULT 1,
      show_current_file     INTEGER NOT NULL DEFAULT 1,
      show_recent_history   INTEGER NOT NULL DEFAULT 1,
      show_featured         INTEGER NOT NULL DEFAULT 1,
      version              INTEGER NOT NULL DEFAULT 1,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_custom_status (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      emoji       TEXT,
      text        TEXT,
      expires_at  TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_badges (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id    TEXT NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, badge_id)
    );

    CREATE TABLE IF NOT EXISTS user_links (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      label       TEXT,
      url         TEXT NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_featured_projects (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, project_id)
    );
`;

// v12 only: copy any pre-existing M22 editor preferences into the new
// versioned settings blob so upgraded users keep their editor config.
function copyLegacyPreferencesIntoSettings(db: Db): void {
  const legacy = db
    .prepare(
      "SELECT user_id, font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace FROM user_preferences",
    )
    .all() as Array<{
    user_id: number;
    font_size: number;
    tab_size: number;
    word_wrap: string;
    minimap: number;
    line_numbers: string;
    cursor_blinking: string;
    render_whitespace: string;
  }>;
  const ins = db.prepare(
    "INSERT INTO user_settings (user_id, version, data) VALUES (?, 1, ?) ON CONFLICT(user_id) DO NOTHING",
  );
  for (const r of legacy) {
    ins.run(
      r.user_id,
      JSON.stringify({
        "editor.fontSize": Number(r.font_size),
        "editor.tabSize": Number(r.tab_size),
        "editor.wordWrap": r.word_wrap,
        "editor.minimap": !!r.minimap,
        "editor.lineNumbers": r.line_numbers,
        "editor.cursorBlinking": r.cursor_blinking,
        "editor.renderWhitespace": r.render_whitespace,
      }),
    );
  }
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
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
      project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
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

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      font_size          REAL NOT NULL DEFAULT 13.5,
      tab_size           INTEGER NOT NULL DEFAULT 4,
      word_wrap          TEXT NOT NULL DEFAULT 'off',
      minimap            INTEGER NOT NULL DEFAULT 0,
      line_numbers       TEXT NOT NULL DEFAULT 'on',
      cursor_blinking    TEXT NOT NULL DEFAULT 'smooth',
      render_whitespace  TEXT NOT NULL DEFAULT 'selection',
      format_on_save     INTEGER NOT NULL DEFAULT 0,
      sidebar_width      INTEGER NOT NULL DEFAULT 250,
      bottom_height      INTEGER NOT NULL DEFAULT 260,
      sidebar_hidden     INTEGER NOT NULL DEFAULT 0,
      bottom_collapsed   INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS secrets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scope        TEXT NOT NULL,
      scope_id     TEXT NOT NULL,
      environment  TEXT,
      name         TEXT NOT NULL,
      ciphertext   BLOB NOT NULL,
      nonce        BLOB NOT NULL,
      key_version  INTEGER NOT NULL DEFAULT 1,
      is_secret    INTEGER NOT NULL DEFAULT 1,
      fingerprint  TEXT,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      UNIQUE(scope, scope_id, environment, name),
      FOREIGN KEY (scope_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- SQLite treats NULLs as distinct in a UNIQUE constraint, so the table
    -- constraint above does not stop two rows with the same name and a NULL
    -- environment. This functional index closes that for the common
    -- no-environment case.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_identity
      ON secrets(scope, scope_id, COALESCE(environment, ''), name);
    CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope, scope_id);

    -- M60: derived, metadata-only collaboration history. NEVER stores document
    -- content, diffs, Yjs updates, cursor/selection trails, or execution output
    -- (see docs/superpowers/specs/2026-08-31-m60-change-attribution-history-design.md §7).
    CREATE TABLE IF NOT EXISTS collaboration_changes (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path      TEXT NOT NULL,
      kind           TEXT NOT NULL DEFAULT 'edit_burst',
      started_at     TEXT NOT NULL,
      ended_at       TEXT NOT NULL,
      update_count   INTEGER NOT NULL DEFAULT 0,
      lines_added    INTEGER NOT NULL DEFAULT 0,
      lines_removed  INTEGER NOT NULL DEFAULT 0,
      start_line     INTEGER,
      end_line       INTEGER,
      detail         TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_collab_changes_project_ended
      ON collaboration_changes(project_id, ended_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS collab_last_seen (
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );

    ${M61_SCHEMA_SQL}
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
    description: "Add runs and audit_logs tables",
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
    description: "Add snapshots table",
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
    description: "Add role column to users table",
    up: (db: Db) => {
      try {
        db.exec(
          "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
        );
      } catch (err: any) {
        if (!err.message?.includes("duplicate column name")) {
          throw err;
        }
      }
    },
  },
  {
    version: 5,
    description: "Add telemetry_samples and resource_anomalies tables",
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
    description:
      "Create project_collaborators table for M4 real-time multiplayer sharing",
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
    description:
      "Create ai_verifications journal table for M5 verification-aware AI assistant",
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
  {
    version: 8,
    description: "Create user_preferences table for M22 editor customization",
    up(db: Db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          font_size          REAL NOT NULL DEFAULT 13.5,
          tab_size           INTEGER NOT NULL DEFAULT 4,
          word_wrap          TEXT NOT NULL DEFAULT 'off',
          minimap            INTEGER NOT NULL DEFAULT 0,
          line_numbers       TEXT NOT NULL DEFAULT 'on',
          cursor_blinking    TEXT NOT NULL DEFAULT 'smooth',
          render_whitespace  TEXT NOT NULL DEFAULT 'selection',
          updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 9,
    description:
      "Change audit_logs.project_id from ON DELETE CASCADE to ON DELETE SET NULL, so a project's prior audit history survives its deletion instead of being silently destroyed (M33)",
    up(db: Db) {
      // SQLite has no ALTER TABLE for changing a foreign key's ON DELETE
      // action, so this uses the standard rename-recreate-copy-drop
      // pattern. Idempotency check first: a database created after the
      // baseline schema (openDb's inline SQL) was updated already has the
      // correct constraint, so the (harmless but wasteful) recreate is
      // skipped rather than blindly re-run on every fresh database, unlike
      // most other migrations in this file which tolerate that via
      // `CREATE TABLE IF NOT EXISTS` no-ops.
      const fkRows = db
        .prepare("PRAGMA foreign_key_list(audit_logs)")
        .all() as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      const projectFk = fkRows.find(
        (r) => r.from === "project_id" && r.table === "projects",
      );
      if (projectFk && projectFk.on_delete === "SET NULL") {
        return;
      }

      db.exec(`
        CREATE TABLE audit_logs_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
          event_type  TEXT NOT NULL,
          details     TEXT NOT NULL,
          ip_address  TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO audit_logs_new (id, user_id, project_id, event_type, details, ip_address, created_at)
        SELECT id, user_id, project_id, event_type, details, ip_address, created_at FROM audit_logs;

        DROP TABLE audit_logs;

        ALTER TABLE audit_logs_new RENAME TO audit_logs;

        CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      `);
    },
  },
  {
    version: 10,
    description:
      "Create secrets table for M47 encrypted per-project secrets & environment variables",
    up(db: Db) {
      // Mirrors the inline schema in openDb(); `IF NOT EXISTS` makes this a
      // no-op on a fresh database (which already ran the inline CREATE) and
      // the real create on an upgraded one.
      db.exec(`
        CREATE TABLE IF NOT EXISTS secrets (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          scope        TEXT NOT NULL,
          scope_id     TEXT NOT NULL,
          environment  TEXT,
          name         TEXT NOT NULL,
          ciphertext   BLOB NOT NULL,
          nonce        BLOB NOT NULL,
          key_version  INTEGER NOT NULL DEFAULT 1,
          is_secret    INTEGER NOT NULL DEFAULT 1,
          fingerprint  TEXT,
          created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          UNIQUE(scope, scope_id, environment, name),
          FOREIGN KEY (scope_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_identity
          ON secrets(scope, scope_id, COALESCE(environment, ''), name);
        CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope, scope_id);
      `);
    },
  },
  {
    version: 11,
    description:
      "M60: collaboration_changes + collab_last_seen for change attribution & history",
    up(db: Db) {
      // Mirrors the inline schema in openDb(); `IF NOT EXISTS` makes this a
      // no-op on a fresh database and the real create on an upgraded one.
      db.exec(`
        CREATE TABLE IF NOT EXISTS collaboration_changes (
          id             TEXT PRIMARY KEY,
          project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          file_path      TEXT NOT NULL,
          kind           TEXT NOT NULL DEFAULT 'edit_burst',
          started_at     TEXT NOT NULL,
          ended_at       TEXT NOT NULL,
          update_count   INTEGER NOT NULL DEFAULT 0,
          lines_added    INTEGER NOT NULL DEFAULT 0,
          lines_removed  INTEGER NOT NULL DEFAULT 0,
          start_line     INTEGER,
          end_line       INTEGER,
          detail         TEXT,
          created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_collab_changes_project_ended
          ON collaboration_changes(project_id, ended_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS collab_last_seen (
          project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        );
      `);
    },
  },
  {
    version: 12,
    description:
      "M61: comment threads (Track A) + versioned user_settings (Track B) + profile identity tables (Track C)",
    up(db: Db) {
      // Mirrors the inline schema in openDb(); `IF NOT EXISTS` makes the
      // CREATEs a no-op on a fresh database and the real create on an
      // upgraded one. The legacy-preferences copy runs only here.
      db.exec(M61_SCHEMA_SQL);
      copyLegacyPreferencesIntoSettings(db);
    },
  },
  {
    version: 13,
    description:
      "M66: add user_preferences.format_on_save — the 'format on save' editor setting moves from browser localStorage into the typed server-persisted preference store (single source of truth). Existing rows default to 0 (off), matching the prior client default.",
    up(db: Db) {
      const cols = (
        db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      if (!cols.includes("format_on_save")) {
        db.exec(
          "ALTER TABLE user_preferences ADD COLUMN format_on_save INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    version: 14,
    description:
      "M67: add user_preferences.{sidebar_width,bottom_height,sidebar_hidden,bottom_collapsed} — the four genuinely user-scoped IDE panel-layout dimensions move from throwaway IDE.tsx component state into the typed server-persisted preference store so a reload no longer discards them. Existing rows default to the prior in-memory defaults (250 / 260 / off / off), so no user's layout changes.",
    up(db: Db) {
      const cols = (
        db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      const add = (name: string, ddl: string) => {
        if (!cols.includes(name)) {
          db.exec(`ALTER TABLE user_preferences ADD COLUMN ${ddl}`);
        }
      };
      add("sidebar_width", "sidebar_width INTEGER NOT NULL DEFAULT 250");
      add("bottom_height", "bottom_height INTEGER NOT NULL DEFAULT 260");
      add("sidebar_hidden", "sidebar_hidden INTEGER NOT NULL DEFAULT 0");
      add("bottom_collapsed", "bottom_collapsed INTEGER NOT NULL DEFAULT 0");
    },
  },
];

export function getSchemaVersion(db: Db): number {
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as {
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
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
      BASELINE_SCHEMA_VERSION,
    );
    current = BASELINE_SCHEMA_VERSION;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
        migration.version,
      );
      db.exec("COMMIT");
      current = migration.version;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure; the original migration error is what matters
      }
      throw err;
    }
  }
}

export function ensureAdminUser(
  db: Db,
  username: string,
  passwordHash: string,
): void {
  const existing = db
    .prepare("SELECT id, role FROM users WHERE username = ?")
    .get(username) as { id: number; role: string } | undefined;
  if (!existing) {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run(username, passwordHash, "admin");
  } else if (existing.role !== "admin") {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
      "admin",
      existing.id,
    );
  }
}
