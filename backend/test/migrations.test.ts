import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  openDb,
  getSchemaVersion,
  BASELINE_SCHEMA_VERSION,
} from "../src/db.js";
import type { Db } from "../src/db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };

describe("Database Schema & Migrations", () => {
  it("initializes a fresh database and applies migrations", () => {
    const db = openDb(":memory:");
    const version = getSchemaVersion(db);
    expect(version).toBeGreaterThanOrEqual(BASELINE_SCHEMA_VERSION);
    expect(version).toBe(12);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("users");
    expect(names).toContain("sessions");
    expect(names).toContain("projects");
    expect(names).toContain("runs");
    expect(names).toContain("audit_logs");
    expect(names).toContain("snapshots");
    expect(names).toContain("telemetry_samples");
    expect(names).toContain("resource_anomalies");
    expect(names).toContain("project_collaborators");
    expect(names).toContain("ai_verifications");
    expect(names).toContain("user_preferences");
    expect(names).toContain("schema_migrations");

    // Verify role column on users table
    const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("role");
  });

  it("sets busy_timeout pragma to 5000ms", () => {
    const db = openDb(":memory:");
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  });

  it("handles existing databases gracefully and records migrations idempotently", () => {
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBe(12);

    // Re-opening or querying should remain consistent
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number }>;
    expect(rows.length).toBe(12);
    expect(rows.map((r) => r.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("M61: v12 creates the comment, settings and profile tables with cascades", () => {
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBe(12);
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    for (const t of [
      "comment_threads",
      "comments",
      "comment_mentions",
      "comment_reactions",
      "user_settings",
      "user_profiles",
      "user_custom_status",
      "profile_media",
      "user_badges",
      "user_links",
      "user_featured_projects",
    ])
      expect(names).toContain(t);
    const fk = db
      .prepare("PRAGMA foreign_key_list(comments)")
      .all() as { table: string; on_delete: string }[];
    expect(fk.find((r) => r.table === "comment_threads")!.on_delete).toBe(
      "CASCADE",
    );
    const cols = (
      db.prepare("PRAGMA table_info(comment_threads)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("anchor_prefix");
    expect(cols).toContain("anchor_prefix_hash");
    const pcols = (
      db.prepare("PRAGMA table_info(user_profiles)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(pcols).toContain("profile_visibility");
    expect(pcols).toContain("show_location");
  });

  it("M61: v12 copies pre-existing user_preferences rows into user_settings.data", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudide-m61-settings-copy-"));
    const dbPath = join(dir, "pre-v12.db");
    try {
      const raw: Db = new DatabaseSync(dbPath);
      raw.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE user_preferences (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          font_size REAL NOT NULL DEFAULT 13.5,
          tab_size INTEGER NOT NULL DEFAULT 4,
          word_wrap TEXT NOT NULL DEFAULT 'off',
          minimap INTEGER NOT NULL DEFAULT 0,
          line_numbers TEXT NOT NULL DEFAULT 'on',
          cursor_blinking TEXT NOT NULL DEFAULT 'smooth',
          render_whitespace TEXT NOT NULL DEFAULT 'selection',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (let v = 1; v <= 11; v++) {
        raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      }
      raw
        .prepare(
          "INSERT INTO users (id, username, password_hash) VALUES (1, 'prefs_user', 'hash')",
        )
        .run();
      raw
        .prepare(
          "INSERT INTO user_preferences (user_id, font_size, tab_size) VALUES (1, 16, 2)",
        )
        .run();
      raw.close();

      const migrated = openDb(dbPath);
      expect(getSchemaVersion(migrated)).toBe(12);
      const row = migrated
        .prepare("SELECT data FROM user_settings WHERE user_id = 1")
        .get() as { data: string } | undefined;
      expect(row).toBeDefined();
      const data = JSON.parse(row!.data);
      expect(data["editor.fontSize"]).toBe(16);
      expect(data["editor.tabSize"]).toBe(2);
      migrated.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  // Milestone 33 — audit_logs.project_id changed from ON DELETE CASCADE to
  // ON DELETE SET NULL, so a project's prior audit history survives its
  // deletion instead of being silently destroyed. This was previously the
  // defect: CASCADE meant deleting a project erased every audit row that
  // ever referenced it.
  describe("Milestone 33 — audit_logs.project_id ON DELETE SET NULL migration", () => {
    it("a fresh database gets the corrected FK directly from the baseline schema (no migration replay needed)", () => {
      const db = openDb(":memory:");
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
      expect(projectFk).toBeDefined();
      expect(projectFk!.on_delete).toBe("SET NULL");

      const userFk = fkRows.find(
        (r) => r.from === "user_id" && r.table === "users",
      );
      expect(userFk).toBeDefined();
      expect(userFk!.on_delete).toBe("SET NULL");
    });

    it("an upgraded database (real pre-M33 schema on disk, real data, reopened via openDb) is migrated correctly: data preserved, FK corrected, idempotent, project deletion now sets project_id NULL, user deletion still sets user_id NULL", () => {
      const dir = mkdtempSync(join(tmpdir(), "cloudide-migration-upgrade-"));
      const dbPath = join(dir, "pre-m33.db");

      try {
        // Hand-build a database at exactly the pre-M33 schema shape (the
        // OLD audit_logs.project_id ON DELETE CASCADE), fully migrated up
        // through version 8, with real data -- not openDb(), since openDb
        // now produces the corrected v9 baseline directly.
        const raw: Db = new DatabaseSync(dbPath);
        raw.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA foreign_keys = ON;

          CREATE TABLE users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'user',
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE TABLE projects (
            id         TEXT PRIMARY KEY,
            owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            language   TEXT NOT NULL DEFAULT 'auto',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE TABLE audit_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
            event_type  TEXT NOT NULL,
            details     TEXT NOT NULL,
            ip_address  TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX idx_audit_project ON audit_logs(project_id);
          CREATE INDEX idx_audit_created ON audit_logs(created_at);

          CREATE TABLE schema_migrations (
            version    INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
        for (let v = 1; v <= 8; v++) {
          raw
            .prepare("INSERT INTO schema_migrations (version) VALUES (?)")
            .run(v);
        }

        raw
          .prepare(
            "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'old_owner', 'hash', 'user')",
          )
          .run();
        raw
          .prepare(
            "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'old_deleted_user', 'hash', 'user')",
          )
          .run();
        raw
          .prepare(
            "INSERT INTO projects (id, owner_id, name) VALUES ('proj-to-delete', 1, 'Pre-M33 Project')",
          )
          .run();
        raw
          .prepare(
            "INSERT INTO projects (id, owner_id, name) VALUES ('proj-keep', 1, 'Kept Project')",
          )
          .run();
        raw
          .prepare(
            "INSERT INTO audit_logs (user_id, project_id, event_type, details) VALUES (1, 'proj-to-delete', 'PROJECT_CREATED', '{}')",
          )
          .run();
        raw
          .prepare(
            "INSERT INTO audit_logs (user_id, project_id, event_type, details) VALUES (2, 'proj-keep', 'AUTH_LOGIN', '{}')",
          )
          .run();
        const preMigrationCount = (
          raw.prepare("SELECT COUNT(*) as c FROM audit_logs").get() as {
            c: number;
          }
        ).c;
        expect(preMigrationCount).toBe(2);
        raw.close();

        // Reopen via the REAL production code path -- this is what
        // actually applying the migration on app restart looks like.
        const migrated = openDb(dbPath);

        expect(getSchemaVersion(migrated)).toBe(12);
        const migrationRows = migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
          .all() as Array<{ version: number }>;
        expect(migrationRows.map((r) => r.version)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ]);

        // All pre-existing data survived the table recreate.
        const postMigrationCount = (
          migrated.prepare("SELECT COUNT(*) as c FROM audit_logs").get() as {
            c: number;
          }
        ).c;
        expect(postMigrationCount).toBe(2);
        const preservedRow = migrated
          .prepare(
            "SELECT * FROM audit_logs WHERE event_type = 'PROJECT_CREATED'",
          )
          .get() as any;
        expect(preservedRow.project_id).toBe("proj-to-delete");
        expect(preservedRow.user_id).toBe(1);

        // The FK is now corrected.
        const fkRows = migrated
          .prepare("PRAGMA foreign_key_list(audit_logs)")
          .all() as Array<{
          from: string;
          on_delete: string;
        }>;
        expect(fkRows.find((r) => r.from === "project_id")!.on_delete).toBe(
          "SET NULL",
        );

        // Indexes survived the recreate.
        const indexes = migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_logs'",
          )
          .all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toEqual(
          expect.arrayContaining(["idx_audit_project", "idx_audit_created"]),
        );

        // Project deletion now sets project_id NULL instead of cascading
        // the audit row away -- the actual defect this migration fixes.
        migrated
          .prepare("DELETE FROM projects WHERE id = 'proj-to-delete'")
          .run();
        const afterProjectDelete = migrated
          .prepare(
            "SELECT * FROM audit_logs WHERE event_type = 'PROJECT_CREATED'",
          )
          .get() as any;
        expect(afterProjectDelete).toBeDefined(); // row survives
        expect(afterProjectDelete.project_id).toBeNull();

        // User deletion behavior is unchanged: still SET NULL, not touched
        // by this migration, verified as a regression guard.
        migrated.prepare("DELETE FROM users WHERE id = 2").run();
        const afterUserDelete = migrated
          .prepare("SELECT * FROM audit_logs WHERE event_type = 'AUTH_LOGIN'")
          .get() as any;
        expect(afterUserDelete).toBeDefined();
        expect(afterUserDelete.user_id).toBeNull();
        expect(afterUserDelete.project_id).toBe("proj-keep"); // untouched

        migrated.close();

        // Reopen a second time -- idempotency: no duplicate migration
        // application, no error, no duplicate schema_migrations rows.
        const reopened = openDb(dbPath);
        expect(getSchemaVersion(reopened)).toBe(12);
        const reopenedMigrationRows = reopened
          .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
          .all() as Array<{ version: number }>;
        expect(reopenedMigrationRows.map((r) => r.version)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ]);
        const finalCount = (
          reopened.prepare("SELECT COUNT(*) as c FROM audit_logs").get() as {
            c: number;
          }
        ).c;
        expect(finalCount).toBe(2); // both rows, from before either deletion, still present
        reopened.close();
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});
