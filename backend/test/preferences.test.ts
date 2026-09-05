import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  DEFAULT_USER_PREFERENCES,
  getUserPreferences,
  updateUserPreferences,
} from "../src/auth/preferences.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 22 — User Preferences & Editor Settings Persistence", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let userId1: number;
  let token1: string;
  let userId2: number;
  let token2: string;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;

    // Register user 1
    const reg1 = await api.request("POST", "/api/auth/register", {
      body: { username: "pref_user_1", password: "password123" },
    });
    userId1 = reg1.data.user.id;
    token1 = reg1.data.token;

    // Register user 2
    const reg2 = await api.request("POST", "/api/auth/register", {
      body: { username: "pref_user_2", password: "password123" },
    });
    userId2 = reg2.data.user.id;
    token2 = reg2.data.token;
  });

  afterEach(async () => {
    await api.close();
  });

  it("1. authenticated GET with no saved row returns exact defaults", async () => {
    const res = await api.request("GET", "/api/auth/preferences", {
      token: token1,
    });
    expect(res.status).toBe(200);
    expect(res.data.preferences).toEqual({
      fontSize: DEFAULT_USER_PREFERENCES.fontSize,
      tabSize: DEFAULT_USER_PREFERENCES.tabSize,
      wordWrap: DEFAULT_USER_PREFERENCES.wordWrap,
      minimap: DEFAULT_USER_PREFERENCES.minimap,
      lineNumbers: DEFAULT_USER_PREFERENCES.lineNumbers,
      cursorBlinking: DEFAULT_USER_PREFERENCES.cursorBlinking,
      renderWhitespace: DEFAULT_USER_PREFERENCES.renderWhitespace,
      formatOnSave: DEFAULT_USER_PREFERENCES.formatOnSave,
    });
  });

  it("2. valid PUT persists and returns normalized values", async () => {
    const updatePayload = {
      fontSize: 16,
      tabSize: 2,
      wordWrap: "on",
      minimap: true,
      lineNumbers: "relative",
      cursorBlinking: "blink",
      renderWhitespace: "all",
    };

    const putRes = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: updatePayload,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.data.preferences.fontSize).toBe(16);
    expect(putRes.data.preferences.tabSize).toBe(2);
    expect(putRes.data.preferences.wordWrap).toBe("on");
    expect(putRes.data.preferences.minimap).toBe(true);
    expect(putRes.data.preferences.lineNumbers).toBe("relative");
    expect(putRes.data.preferences.cursorBlinking).toBe("blink");
    expect(putRes.data.preferences.renderWhitespace).toBe("all");
    expect(putRes.data.preferences.updatedAt).toBeDefined();
  });

  it("3. GET returns saved preferences accurately", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 15, tabSize: 8, wordWrap: "bounded" },
    });

    const getRes = await api.request("GET", "/api/auth/preferences", {
      token: token1,
    });
    expect(getRes.status).toBe(200);
    expect(getRes.data.preferences.fontSize).toBe(15);
    expect(getRes.data.preferences.tabSize).toBe(8);
    expect(getRes.data.preferences.wordWrap).toBe("bounded");
  });

  it("4. partial PUT updates specified fields and preserves unspecified fields", async () => {
    // 1st PUT: set fontSize to 18 and tabSize to 8
    await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 18, tabSize: 8 },
    });

    // 2nd partial PUT: set only wordWrap to 'wordWrapColumn'
    const partialRes = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { wordWrap: "wordWrapColumn" },
    });
    expect(partialRes.status).toBe(200);
    expect(partialRes.data.preferences.fontSize).toBe(18); // preserved
    expect(partialRes.data.preferences.tabSize).toBe(8); // preserved
    expect(partialRes.data.preferences.wordWrap).toBe("wordWrapColumn"); // updated
    expect(partialRes.data.preferences.minimap).toBe(false); // default preserved
  });

  it("5. rejects unknown preference keys with 400", async () => {
    const res = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 14, unknownKey: "malicious" },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_preference_key");
  });

  it("6. rejects invalid numeric values with 400", async () => {
    // Too small fontSize
    const tooSmall = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 4 },
    });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.data.error.code).toBe("invalid_font_size");

    // Too large fontSize
    const tooLarge = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 60 },
    });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.data.error.code).toBe("invalid_font_size");

    // Non-numeric fontSize
    const nonNumeric = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: "14" as any },
    });
    expect(nonNumeric.status).toBe(400);
    expect(nonNumeric.data.error.code).toBe("invalid_font_size");

    // Invalid tabSize
    const invalidTab = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { tabSize: 3 },
    });
    expect(invalidTab.status).toBe(400);
    expect(invalidTab.data.error.code).toBe("invalid_tab_size");
  });

  it("7. rejects invalid enum values with 400", async () => {
    const invalidWrap = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { wordWrap: "wrap-always" },
    });
    expect(invalidWrap.status).toBe(400);
    expect(invalidWrap.data.error.code).toBe("invalid_word_wrap");

    const invalidLines = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { lineNumbers: "numbered" },
    });
    expect(invalidLines.status).toBe(400);
    expect(invalidLines.data.error.code).toBe("invalid_line_numbers");

    const invalidBlink = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { cursorBlinking: "fast" },
    });
    expect(invalidBlink.status).toBe(400);
    expect(invalidBlink.data.error.code).toBe("invalid_cursor_blinking");

    const invalidWhitespace = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { renderWhitespace: "spaces-only" },
    });
    expect(invalidWhitespace.status).toBe(400);
    expect(invalidWhitespace.data.error.code).toBe("invalid_render_whitespace");

    const invalidMinimap = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { minimap: "true" as any },
    });
    expect(invalidMinimap.status).toBe(400);
    expect(invalidMinimap.data.error.code).toBe("invalid_minimap");
  });

  it("8. rejects unauthenticated GET and PUT with 401", async () => {
    const getRes = await api.request("GET", "/api/auth/preferences");
    expect(getRes.status).toBe(401);

    const putRes = await api.request("PUT", "/api/auth/preferences", {
      body: { fontSize: 16 },
    });
    expect(putRes.status).toBe(401);
  });

  it("9. guarantees user isolation (cannot modify or view other user preferences)", async () => {
    // User 1 sets fontSize: 20
    await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 20 },
    });

    // User 2 fetches preferences: should have default fontSize 13.5
    const u2Res = await api.request("GET", "/api/auth/preferences", {
      token: token2,
    });
    expect(u2Res.status).toBe(200);
    expect(u2Res.data.preferences.fontSize).toBe(13.5);

    // User 2 sets fontSize: 12
    await api.request("PUT", "/api/auth/preferences", {
      token: token2,
      body: { fontSize: 12 },
    });

    // User 1 still has 20
    const u1Res = await api.request("GET", "/api/auth/preferences", {
      token: token1,
    });
    expect(u1Res.status).toBe(200);
    expect(u1Res.data.preferences.fontSize).toBe(20);
  });

  it("10. cascade-deletes preferences when user is deleted", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 15 },
    });

    // Confirm row exists in DB
    const before = db
      .prepare("SELECT * FROM user_preferences WHERE user_id = ?")
      .get(userId1);
    expect(before).toBeDefined();

    // Delete user 1
    db.prepare("DELETE FROM users WHERE id = ?").run(userId1);

    // Row should be deleted via ON DELETE CASCADE
    const after = db
      .prepare("SELECT * FROM user_preferences WHERE user_id = ?")
      .get(userId1);
    expect(after).toBeUndefined();
  });

  it("11. records USER_PREFERENCES_UPDATED in audit_logs", async () => {
    await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: { fontSize: 17, tabSize: 2 },
    });

    const log = db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'USER_PREFERENCES_UPDATED' ORDER BY id DESC LIMIT 1",
      )
      .get(userId1) as any;

    expect(log).toBeDefined();
    expect(log.event_type).toBe("USER_PREFERENCES_UPDATED");
    const details = JSON.parse(log.details);
    expect(details.updates.fontSize).toBe(17);
    expect(details.updates.tabSize).toBe(2);
  });

  it("12. repeated PUT is idempotent", async () => {
    const payload = { fontSize: 14, tabSize: 4, wordWrap: "on" };

    const res1 = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: payload,
    });
    const res2 = await api.request("PUT", "/api/auth/preferences", {
      token: token1,
      body: payload,
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.data.preferences.fontSize).toBe(res2.data.preferences.fontSize);
    expect(res1.data.preferences.tabSize).toBe(res2.data.preferences.tabSize);
    expect(res1.data.preferences.wordWrap).toBe(res2.data.preferences.wordWrap);
  });

  it("13. direct domain functions handle existing users without rows", () => {
    // userId2 exists in users table but has no row in user_preferences
    const freshPrefs = getUserPreferences(db, userId2);
    expect(freshPrefs).toEqual(DEFAULT_USER_PREFERENCES);

    const updated = updateUserPreferences(db, userId2, { fontSize: 22 });
    expect(updated.fontSize).toBe(22);
    expect(updated.tabSize).toBe(DEFAULT_USER_PREFERENCES.tabSize);
  });
});
