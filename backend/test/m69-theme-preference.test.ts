import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  DEFAULT_USER_PREFERENCES,
  getUserPreferences,
  updateUserPreferences,
} from "../src/auth/preferences.js";
import { openDb, getSchemaVersion } from "../src/db.js";
import type { Db } from "../src/db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };

/**
 * M69 — Unified Theme & Appearance. A single typed `theme` preference
 * ("system" | "dark" | "light") joins the existing typed user_preferences
 * store. The dormant user_settings system stays untouched.
 */
describe("M69 — theme preference", () => {
  let api: TestApi;
  let token: string;
  let userId: number;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "m69_user", password: "password123" },
    });
    token = reg.data.token;
    userId = reg.data.user.id;
  });

  afterEach(async () => {
    await api.close();
  });

  it("1. defaults to \"system\"", async () => {
    expect(DEFAULT_USER_PREFERENCES.theme).toBe("system");
    const res = await api.request("GET", "/api/auth/preferences", { token });
    expect(res.status).toBe(200);
    expect(res.data.preferences.theme).toBe("system");
  });

  it("2. accepts every valid theme value and round-trips it", async () => {
    for (const theme of ["dark", "light", "system"] as const) {
      const put = await api.request("PUT", "/api/auth/preferences", {
        token,
        body: { theme },
      });
      expect(put.status).toBe(200);
      expect(put.data.preferences.theme).toBe(theme);
      const get = await api.request("GET", "/api/auth/preferences", { token });
      expect(get.data.preferences.theme).toBe(theme);
    }
  });

  it("3. rejects an invalid theme value with 400 invalid_theme", async () => {
    for (const bad of ["Dark", "auto", "", "light-high-contrast", 1, true, null]) {
      const res = await api.request("PUT", "/api/auth/preferences", {
        token,
        body: { theme: bad as any },
      });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe("invalid_theme");
    }
  });

  it("4. a persisted theme survives a fresh GET", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { theme: "light" },
    });
    const get = await api.request("GET", "/api/auth/preferences", { token });
    expect(get.data.preferences.theme).toBe("light");
  });

  it("5. a partial PUT keeps theme, editor, and layout keys correct", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { theme: "dark", fontSize: 20, sidebarWidth: 300 },
    });
    // a later PUT that does not mention theme leaves it alone
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { minimap: true },
    });
    expect(put.data.preferences.theme).toBe("dark"); // preserved
    expect(put.data.preferences.fontSize).toBe(20); // preserved
    expect(put.data.preferences.sidebarWidth).toBe(300); // preserved
    expect(put.data.preferences.minimap).toBe(true); // updated
    // a PUT of theme alone leaves the rest alone
    const put2 = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { theme: "light" },
    });
    expect(put2.data.preferences.theme).toBe("light");
    expect(put2.data.preferences.fontSize).toBe(20);
    expect(put2.data.preferences.sidebarWidth).toBe(300);
    expect(put2.data.preferences.minimap).toBe(true);
  });

  it("6. unknown theme-shaped keys are still rejected as invalid_preference_key", async () => {
    for (const key of ["themeMode", "appearance", "colorScheme"]) {
      const res = await api.request("PUT", "/api/auth/preferences", {
        token,
        body: { [key]: "dark" },
      });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe("invalid_preference_key");
    }
  });

  it("7. getUserPreferences / updateUserPreferences round-trip theme", () => {
    const db = api.db;
    expect(getUserPreferences(db, userId).theme).toBe("system");
    const updated = updateUserPreferences(db, userId, { theme: "dark" });
    expect(updated.theme).toBe("dark");
    const reread = getUserPreferences(db, userId);
    expect(reread.theme).toBe("dark");
    expect(reread.fontSize).toBe(DEFAULT_USER_PREFERENCES.fontSize); // untouched
  });

  it("8. a fresh database's user_preferences table carries the theme column", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("theme");
  });

  it("9. the v15 migration adds theme to a pre-v15 db, is idempotent, and defaults existing rows to 'system'", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudide-m69-theme-"));
    const dbPath = join(dir, "pre-v15.db");
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
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (let v = 1; v <= 14; v++) {
        raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      }
      raw
        .prepare(
          "INSERT INTO users (id, username, password_hash) VALUES (1, 'legacy', 'hash')",
        )
        .run();
      raw
        .prepare("INSERT INTO user_preferences (user_id, font_size) VALUES (1, 16)")
        .run();
      raw.close();

      const migrated = openDb(dbPath);
      expect(getSchemaVersion(migrated)).toBe(17);
      const cols = (
        migrated.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      expect(cols).toContain("theme");

      const prefs = getUserPreferences(migrated, 1);
      expect(prefs.fontSize).toBe(16); // pre-existing data survived
      expect(prefs.theme).toBe("system"); // defaulted
      migrated.close();

      const reopened = openDb(dbPath);
      expect(getSchemaVersion(reopened)).toBe(17);
      const versions = (
        reopened
          .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
          .all() as Array<{ version: number }>
      ).map((r) => r.version);
      expect(versions).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
      ]);
      reopened.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("10. a theme update is recorded in the preferences audit log", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { theme: "light" },
    });
    const log = api.db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'USER_PREFERENCES_UPDATED' ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as any;
    expect(log).toBeDefined();
    expect(JSON.parse(log.details).updates.theme).toBe("light");
  });
});
