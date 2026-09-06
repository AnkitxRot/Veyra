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
 * M67 — the four genuinely user-scoped IDE layout dimensions (sidebar width,
 * bottom panel height, sidebar hidden, bottom panel collapsed) move from
 * throwaway IDE.tsx component state into the typed, server-persisted
 * user_preferences store, so a reload no longer discards them.
 */
describe("M67 — persistent IDE layout preferences", () => {
  let api: TestApi;
  let token: string;
  let userId: number;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "m67_user", password: "password123" },
    });
    token = reg.data.token;
    userId = reg.data.user.id;
  });

  afterEach(async () => {
    await api.close();
  });

  it("1. DEFAULT_USER_PREFERENCES carries the four layout fields", () => {
    expect(DEFAULT_USER_PREFERENCES.sidebarWidth).toBe(250);
    expect(DEFAULT_USER_PREFERENCES.bottomHeight).toBe(260);
    expect(DEFAULT_USER_PREFERENCES.sidebarHidden).toBe(false);
    expect(DEFAULT_USER_PREFERENCES.bottomCollapsed).toBe(false);
  });

  it("2. GET with no saved row returns the layout defaults", async () => {
    const res = await api.request("GET", "/api/auth/preferences", { token });
    expect(res.status).toBe(200);
    expect(res.data.preferences.sidebarWidth).toBe(250);
    expect(res.data.preferences.bottomHeight).toBe(260);
    expect(res.data.preferences.sidebarHidden).toBe(false);
    expect(res.data.preferences.bottomCollapsed).toBe(false);
  });

  it("3. a valid layout PUT persists and GET reflects the persisted layout", async () => {
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: {
        sidebarWidth: 320,
        bottomHeight: 400,
        sidebarHidden: true,
        bottomCollapsed: true,
      },
    });
    expect(put.status).toBe(200);
    expect(put.data.preferences.sidebarWidth).toBe(320);
    expect(put.data.preferences.bottomHeight).toBe(400);
    expect(put.data.preferences.sidebarHidden).toBe(true);
    expect(put.data.preferences.bottomCollapsed).toBe(true);

    const get = await api.request("GET", "/api/auth/preferences", { token });
    expect(get.data.preferences.sidebarWidth).toBe(320);
    expect(get.data.preferences.bottomHeight).toBe(400);
    expect(get.data.preferences.sidebarHidden).toBe(true);
    expect(get.data.preferences.bottomCollapsed).toBe(true);
  });

  it("4. rejects an out-of-range sidebarWidth with 400 invalid_sidebar_width", async () => {
    const tooSmall = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: 100 },
    });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.data.error.code).toBe("invalid_sidebar_width");

    const tooLarge = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: 900 },
    });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.data.error.code).toBe("invalid_sidebar_width");

    const nonNumber = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: "320" as any },
    });
    expect(nonNumber.status).toBe(400);
    expect(nonNumber.data.error.code).toBe("invalid_sidebar_width");

    const nan = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: Number.NaN },
    });
    expect(nan.status).toBe(400);
    expect(nan.data.error.code).toBe("invalid_sidebar_width");
  });

  it("5. rejects an out-of-range bottomHeight with 400 invalid_bottom_height", async () => {
    const tooSmall = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { bottomHeight: 50 },
    });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.data.error.code).toBe("invalid_bottom_height");

    const tooLarge = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { bottomHeight: 5000 },
    });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.data.error.code).toBe("invalid_bottom_height");
  });

  it("6. rejects a non-boolean sidebarHidden / bottomCollapsed with 400", async () => {
    const badHidden = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarHidden: "true" as any },
    });
    expect(badHidden.status).toBe(400);
    expect(badHidden.data.error.code).toBe("invalid_sidebar_hidden");

    const badCollapsed = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { bottomCollapsed: 1 as any },
    });
    expect(badCollapsed.status).toBe(400);
    expect(badCollapsed.data.error.code).toBe("invalid_bottom_collapsed");
  });

  it("7. accepts the exact boundary values", async () => {
    const res = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: 180, bottomHeight: 600 },
    });
    expect(res.status).toBe(200);
    expect(res.data.preferences.sidebarWidth).toBe(180);
    expect(res.data.preferences.bottomHeight).toBe(600);

    const res2 = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: 500, bottomHeight: 120 },
    });
    expect(res2.status).toBe(200);
    expect(res2.data.preferences.sidebarWidth).toBe(500);
    expect(res2.data.preferences.bottomHeight).toBe(120);
  });

  it("8. a partial layout PUT preserves the other layout + editor keys", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: 300, sidebarHidden: true, fontSize: 20 },
    });
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { bottomCollapsed: true },
    });
    expect(put.data.preferences.sidebarWidth).toBe(300); // preserved
    expect(put.data.preferences.sidebarHidden).toBe(true); // preserved
    expect(put.data.preferences.fontSize).toBe(20); // preserved
    expect(put.data.preferences.bottomHeight).toBe(260); // default preserved
    expect(put.data.preferences.bottomCollapsed).toBe(true); // updated
  });

  it("9. rejects an unknown layout-shaped key with 400 invalid_preference_key", async () => {
    const res = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidthPx: 300 },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_preference_key");
  });

  it("10. getUserPreferences / updateUserPreferences round-trip the layout", () => {
    const db = api.db;
    expect(getUserPreferences(db, userId).sidebarWidth).toBe(250);
    const updated = updateUserPreferences(db, userId, {
      sidebarWidth: 210,
      bottomCollapsed: true,
    });
    expect(updated.sidebarWidth).toBe(210);
    expect(updated.bottomCollapsed).toBe(true);
    const reread = getUserPreferences(db, userId);
    expect(reread.sidebarWidth).toBe(210);
    expect(reread.bottomCollapsed).toBe(true);
    expect(reread.bottomHeight).toBe(260); // untouched default
  });

  it("11. a fresh database's user_preferences table carries the four layout columns", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("sidebar_width");
    expect(cols).toContain("bottom_height");
    expect(cols).toContain("sidebar_hidden");
    expect(cols).toContain("bottom_collapsed");
  });

  it("12. the v14 migration adds the layout columns to a pre-v14 db, is idempotent, and defaults existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudide-m67-layout-"));
    const dbPath = join(dir, "pre-v14.db");
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
          updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (let v = 1; v <= 13; v++) {
        raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      }
      raw
        .prepare(
          "INSERT INTO users (id, username, password_hash) VALUES (1, 'legacy', 'hash')",
        )
        .run();
      raw
        .prepare(
          "INSERT INTO user_preferences (user_id, font_size) VALUES (1, 16)",
        )
        .run();
      raw.close();

      const migrated = openDb(dbPath);
      expect(getSchemaVersion(migrated)).toBe(16);
      const cols = (
        migrated.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining([
          "sidebar_width",
          "bottom_height",
          "sidebar_hidden",
          "bottom_collapsed",
        ]),
      );

      const prefs = getUserPreferences(migrated, 1);
      expect(prefs.fontSize).toBe(16); // pre-existing data survived
      expect(prefs.sidebarWidth).toBe(250);
      expect(prefs.bottomHeight).toBe(260);
      expect(prefs.sidebarHidden).toBe(false);
      expect(prefs.bottomCollapsed).toBe(false);
      migrated.close();

      // Idempotent: reopening applies nothing new and does not error.
      const reopened = openDb(dbPath);
      expect(getSchemaVersion(reopened)).toBe(16);
      const versions = (
        reopened
          .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
          .all() as Array<{ version: number }>
      ).map((r) => r.version);
      expect(versions).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
      reopened.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("13. layout updates are recorded in the preferences audit log", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { sidebarWidth: 333 },
    });
    const log = api.db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'USER_PREFERENCES_UPDATED' ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as any;
    expect(log).toBeDefined();
    expect(JSON.parse(log.details).updates.sidebarWidth).toBe(333);
  });
});
