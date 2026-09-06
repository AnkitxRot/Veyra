import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  DEFAULT_USER_PREFERENCES,
  DEFAULT_KEYMAP,
  CONFIGURABLE_COMMAND_IDS,
  getUserPreferences,
  updateUserPreferences,
} from "../src/auth/preferences.js";
import { openDb, getSchemaVersion } from "../src/db.js";
import type { Db } from "../src/db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };

const SAVE = "workbench.action.saveFile";
const QUICK_OPEN = "workbench.action.quickOpen";
const TOGGLE_SIDEBAR = "workbench.action.toggleSidebar";

/**
 * M70 — configurable keybindings. A typed `keymap` preference stores only the
 * command IDs the user has REMAPPED (id -> canonical chord); commands at their
 * default are absent. Joins the existing typed user_preferences store; the
 * dormant user_settings is untouched.
 */
describe("M70 — keybinding preference", () => {
  let api: TestApi;
  let token: string;
  let userId: number;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "m70_user", password: "password123" },
    });
    token = reg.data.token;
    userId = reg.data.user.id;
  });

  afterEach(async () => {
    await api.close();
  });

  it("1. defaults to an empty override map", async () => {
    expect(DEFAULT_USER_PREFERENCES.keymap).toEqual({});
    const res = await api.request("GET", "/api/auth/preferences", { token });
    expect(res.status).toBe(200);
    expect(res.data.preferences.keymap).toEqual({});
  });

  it("1b. exposes the configurable command set and their default chords", () => {
    expect(CONFIGURABLE_COMMAND_IDS).toContain(SAVE);
    expect(CONFIGURABLE_COMMAND_IDS).toContain(QUICK_OPEN);
    expect(DEFAULT_KEYMAP[SAVE]).toBe("mod+s");
    expect(DEFAULT_KEYMAP[QUICK_OPEN]).toBe("mod+p");
    // every configurable command has a default chord
    for (const id of CONFIGURABLE_COMMAND_IDS) {
      expect(typeof DEFAULT_KEYMAP[id]).toBe("string");
    }
  });

  it("2. a valid override persists and round-trips", async () => {
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+alt+s" } },
    });
    expect(put.status).toBe(200);
    expect(put.data.preferences.keymap).toEqual({ [SAVE]: "mod+alt+s" });
    const get = await api.request("GET", "/api/auth/preferences", { token });
    expect(get.data.preferences.keymap).toEqual({ [SAVE]: "mod+alt+s" });
  });

  it("3. a keymap PUT replaces the whole map; other prefs are untouched", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+alt+s", [QUICK_OPEN]: "mod+alt+o" }, fontSize: 20 },
    });
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [TOGGLE_SIDEBAR]: "mod+alt+b" } },
    });
    // replace, not merge
    expect(put.data.preferences.keymap).toEqual({ [TOGGLE_SIDEBAR]: "mod+alt+b" });
    expect(put.data.preferences.fontSize).toBe(20); // untouched
    // a PUT that does not mention keymap leaves it alone
    const put2 = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { minimap: true },
    });
    expect(put2.data.preferences.keymap).toEqual({ [TOGGLE_SIDEBAR]: "mod+alt+b" });
  });

  it("4. an unknown command ID is rejected with 400 invalid_command_id", async () => {
    const res = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { "not.a.real.command": "mod+k" } },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_command_id");
  });

  it("5. an invalid / unusable shortcut is rejected with 400 invalid_shortcut", async () => {
    for (const chord of [
      "banana",
      "p", // no modifier — would break typing
      "shift+p", // shift-only — still typing
      "mod+w", // browser-reserved (close tab)
      "mod+t", // browser-reserved (new tab)
      "mod+shift+", // no key
      "MOD+S", // not canonical (uppercase)
      "ctrl+p", // raw ctrl is not a recognised modifier (use "mod")
      "",
    ]) {
      const res = await api.request("PUT", "/api/auth/preferences", {
        token,
        body: { keymap: { [SAVE]: chord } },
      });
      expect(res.status, `chord=${JSON.stringify(chord)}`).toBe(400);
      expect(res.data.error.code).toBe("invalid_shortcut");
    }
  });

  it("6. a shortcut already owned by another command is rejected with 400 duplicate_shortcut", async () => {
    // quick-open remapped onto save's default chord
    const a = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [QUICK_OPEN]: "mod+s" } },
    });
    expect(a.status).toBe(400);
    expect(a.data.error.code).toBe("duplicate_shortcut");
    // two overrides sharing a chord
    const b = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+alt+k", [QUICK_OPEN]: "mod+alt+k" } },
    });
    expect(b.status).toBe(400);
    expect(b.data.error.code).toBe("duplicate_shortcut");
  });

  it("6b. an override that swaps two commands' chords is allowed", async () => {
    // save <-> quick-open swap: mod+p on save, mod+s on quick-open — no dup
    const res = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+p", [QUICK_OPEN]: "mod+s" } },
    });
    expect(res.status).toBe(200);
    expect(res.data.preferences.keymap).toEqual({
      [SAVE]: "mod+p",
      [QUICK_OPEN]: "mod+s",
    });
  });

  it("7. resetting to {} clears every override", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+alt+s" } },
    });
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: {} },
    });
    expect(put.data.preferences.keymap).toEqual({});
    const get = await api.request("GET", "/api/auth/preferences", { token });
    expect(get.data.preferences.keymap).toEqual({});
  });

  it("8. a keymap-shaped unknown key is still rejected as invalid_preference_key", async () => {
    const res = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymaps: { [SAVE]: "mod+alt+s" } },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_preference_key");
  });

  it("8b. a non-object keymap is rejected", async () => {
    for (const bad of ["x", 1, true, null, [1, 2]]) {
      const res = await api.request("PUT", "/api/auth/preferences", {
        token,
        body: { keymap: bad as any },
      });
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe("invalid_keymap");
    }
  });

  it("9. keymap updates leave theme / fontSize / layout intact", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { theme: "light", fontSize: 18, sidebarWidth: 300 },
    });
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+alt+s" } },
    });
    expect(put.data.preferences.theme).toBe("light");
    expect(put.data.preferences.fontSize).toBe(18);
    expect(put.data.preferences.sidebarWidth).toBe(300);
    expect(put.data.preferences.keymap).toEqual({ [SAVE]: "mod+alt+s" });
  });

  it("10. getUserPreferences / updateUserPreferences round-trip keymap", () => {
    const db = api.db;
    expect(getUserPreferences(db, userId).keymap).toEqual({});
    const updated = updateUserPreferences(db, userId, {
      keymap: { [SAVE]: "mod+alt+s" },
    });
    expect(updated.keymap).toEqual({ [SAVE]: "mod+alt+s" });
    const reread = getUserPreferences(db, userId);
    expect(reread.keymap).toEqual({ [SAVE]: "mod+alt+s" });
  });

  it("11. the v16 migration adds keymap defaulting to '{}', is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudide-m70-keymap-"));
    const dbPath = join(dir, "pre-v16.db");
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
          format_on_save INTEGER NOT NULL DEFAULT 0,
          sidebar_width INTEGER NOT NULL DEFAULT 250,
          bottom_height INTEGER NOT NULL DEFAULT 260,
          sidebar_hidden INTEGER NOT NULL DEFAULT 0,
          bottom_collapsed INTEGER NOT NULL DEFAULT 0,
          theme TEXT NOT NULL DEFAULT 'system',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (let v = 1; v <= 15; v++) {
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
      expect(getSchemaVersion(migrated)).toBe(16);
      const cols = (
        migrated.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      expect(cols).toContain("keymap");
      const prefs = getUserPreferences(migrated, 1);
      expect(prefs.fontSize).toBe(16);
      expect(prefs.keymap).toEqual({});
      migrated.close();

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

  it("12. a keymap update is recorded in the preferences audit log", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { keymap: { [SAVE]: "mod+alt+s" } },
    });
    const log = api.db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'USER_PREFERENCES_UPDATED' ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as any;
    expect(log).toBeDefined();
    expect(JSON.parse(log.details).updates.keymap[SAVE]).toBe("mod+alt+s");
  });
});
