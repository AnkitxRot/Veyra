import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  DEFAULT_USER_PREFERENCES,
  getUserPreferences,
  updateUserPreferences,
} from "../src/auth/preferences.js";
import { openDb } from "../src/db.js";

/**
 * M66 — the "format on save" editor setting was the one genuine editor
 * preference living in browser localStorage instead of the typed,
 * server-persisted user_preferences store (the single source of truth for
 * every other editor setting). This covers it joining that store.
 */
describe("M66 — formatOnSave joins the typed user-preference store", () => {
  let api: TestApi;
  let token: string;
  let userId: number;

  beforeEach(async () => {
    api = await startTestApi(makeTestConfig());
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "m66_user", password: "password123" },
    });
    token = reg.data.token;
    userId = reg.data.user.id;
  });

  afterEach(async () => {
    await api.close();
  });

  it("defaults to false and is returned by GET", async () => {
    expect(DEFAULT_USER_PREFERENCES.formatOnSave).toBe(false);
    const res = await api.request("GET", "/api/auth/preferences", { token });
    expect(res.data.preferences.formatOnSave).toBe(false);
  });

  it("a valid PUT persists formatOnSave and GET reflects it", async () => {
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { formatOnSave: true },
    });
    expect(put.status).toBe(200);
    expect(put.data.preferences.formatOnSave).toBe(true);

    const get = await api.request("GET", "/api/auth/preferences", { token });
    expect(get.data.preferences.formatOnSave).toBe(true);
  });

  it("a partial PUT preserves formatOnSave alongside the other keys", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { formatOnSave: true },
    });
    const put = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { fontSize: 20 },
    });
    expect(put.data.preferences.formatOnSave).toBe(true);
    expect(put.data.preferences.fontSize).toBe(20);
  });

  it("rejects a non-boolean formatOnSave with 400", async () => {
    const res = await api.request("PUT", "/api/auth/preferences", {
      token,
      body: { formatOnSave: "yes" },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_format_on_save");
  });

  it("getUserPreferences / updateUserPreferences round-trip the flag", () => {
    const db = api.db;
    expect(getUserPreferences(db, userId).formatOnSave).toBe(false);
    const updated = updateUserPreferences(db, userId, { formatOnSave: true });
    expect(updated.formatOnSave).toBe(true);
    expect(getUserPreferences(db, userId).formatOnSave).toBe(true);
  });

  it("a fresh database's user_preferences table carries the format_on_save column", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("format_on_save");
  });
});
