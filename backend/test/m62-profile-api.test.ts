import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { collaborationManager } from "../src/collab/manager.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("M62-2 — self-service profile identity API", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let userId: number;
  let token: string;
  let otherId: number;
  let otherToken: string;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "profile_user", password: "password123" },
    });
    userId = reg.data.user.id;
    token = reg.data.token;
    const reg2 = await api.request("POST", "/api/auth/register", {
      body: { username: "other_user", password: "password123" },
    });
    otherId = reg2.data.user.id;
    otherToken = reg2.data.token;
  });

  afterEach(async () => {
    await api.close();
    vi.restoreAllMocks();
  });

  function auditRows(uid: number): any[] {
    return db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? AND event_type = 'PROFILE_UPDATED' ORDER BY id ASC",
      )
      .all(uid) as any[];
  }
  function userRow(uid: number): any {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  }
  function profileRow(uid: number): any {
    return db.prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(uid);
  }

  it("1. unauthenticated GET -> 401", async () => {
    const r = await api.request("GET", "/api/auth/profile");
    expect(r.status).toBe(401);
  });

  it("2. unauthenticated PUT -> 401", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      body: { displayName: "x" },
    });
    expect(r.status).toBe(401);
  });

  it("3. authenticated GET with no row -> null defaults (200)", async () => {
    const r = await api.request("GET", "/api/auth/profile", { token });
    expect(r.status).toBe(200);
    expect(r.data.profile).toEqual({
      displayName: null,
      pronouns: null,
      bio: null,
      updatedAt: null,
      avatarVersion: 0,
    });
  });

  it("4. happy-path PUT persists and returns the values", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: {
        displayName: "Profile User",
        pronouns: "they/them",
        bio: "Backend engineer.\n\nLikes SQLite.",
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.profile.displayName).toBe("Profile User");
    expect(r.data.profile.pronouns).toBe("they/them");
    expect(r.data.profile.bio).toBe("Backend engineer.\n\nLikes SQLite.");
    expect(r.data.profile.updatedAt).toBeTypeOf("string");

    const g = await api.request("GET", "/api/auth/profile", { token });
    expect(g.data.profile.displayName).toBe("Profile User");
  });

  it("5. partial PUT leaves unspecified fields intact", async () => {
    await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "Name", pronouns: "she/her", bio: "bio text" },
    });
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { pronouns: "he/him" },
    });
    expect(r.data.profile.displayName).toBe("Name");
    expect(r.data.profile.pronouns).toBe("he/him");
    expect(r.data.profile.bio).toBe("bio text");
  });

  it("6. clearing values via null", async () => {
    await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "Name", pronouns: "she/her", bio: "bio text" },
    });
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: null, pronouns: null, bio: null },
    });
    expect(r.data.profile).toMatchObject({
      displayName: null,
      pronouns: null,
      bio: null,
    });
  });

  it("7. unknown key -> 400 invalid_profile_key", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "ok", nickname: "nope" },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_profile_key");
    // rejected wholesale — nothing persisted
    expect(profileRow(userId)).toBeUndefined();
  });

  it("8. over-length displayName -> 400", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "a".repeat(49) },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_display_name");
  });

  it("9. over-length pronouns -> 400", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { pronouns: "x".repeat(25) },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_pronouns");
  });

  it("10. over-length bio -> 400", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { bio: "b".repeat(281) },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_bio");
  });

  it("11. control-character normalization strips C0/DEL", async () => {
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const DEL = String.fromCharCode(127);
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: {
        displayName: `Al${NUL}ic${BEL}e${DEL}`,
        bio: `keep${BEL} this${NUL} `,
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.profile.displayName).toBe("Alice");
    expect(r.data.profile.bio).toBe("keep this");
  });

  it("12. displayName strips ALL C0 incl. newline/tab, then collapses whitespace", async () => {
    // Contract: sanitize (strip every C0 + DEL, newline/tab included) FIRST,
    // then collapse remaining spaces, then trim. So "\n\t" between tokens
    // vanishes rather than becoming a space.
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "  Alice\n\tB.\n\n  Carol  " },
    });
    expect(r.status).toBe(200);
    expect(r.data.profile.displayName).toBe("AliceB. Carol");
  });

  it("12a. displayName C0 boundary cases are deterministic", async () => {
    const c = (n: number) => String.fromCharCode(n);
    const cases = [
      [`a${c(0)}b`, "ab"],   // NUL
      [`a${c(7)}b`, "ab"],   // BEL
      [`a${c(11)}b`, "ab"],  // vertical tab
      [`a${c(10)}b`, "ab"],  // newline
      [`a${c(9)}b`, "ab"],   // tab
      [`a${c(127)}b`, "ab"], // DEL
      ["  Ada   L.  ", "Ada L."],
    ];
    for (const [input, expected] of cases) {
      const r = await api.request("PUT", "/api/auth/profile", {
        token,
        body: { displayName: input },
      });
      expect(r.status, JSON.stringify(input)).toBe(200);
      expect(r.data.profile.displayName, JSON.stringify(input)).toBe(expected);
    }
  });

  it("12b. bio preserves intentional breaks, collapses 3+ newlines", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { bio: "para one\n\n\n\n\npara two\nsame para" },
    });
    expect(r.data.profile.bio).toBe("para one\n\npara two\nsame para");
  });

  it("13. null handling — whitespace-only displayName rejected; blank pronouns/bio clear", async () => {
    const bad = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "   " },
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe("invalid_display_name");

    const ok = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { pronouns: "   ", bio: "  \n  " },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.profile.pronouns).toBeNull();
    expect(ok.data.profile.bio).toBeNull();
  });

  it("14. evaluator_* demo PUT -> 403 demo_forbidden", async () => {
    const demo = await api.request("POST", "/api/auth/demo", {});
    const demoTok = demo.data.token;
    const r = await api.request("PUT", "/api/auth/profile", {
      token: demoTok,
      body: { displayName: "Guest" },
    });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("demo_forbidden");
    const g = await api.request("GET", "/api/auth/profile", { token: demoTok });
    expect(g.status).toBe(200);
    expect(g.data.profile.displayName).toBeNull();
  });

  it("15. sending role/username/userId/version cannot modify them", async () => {
    const beforeUser = userRow(userId);
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: {
        displayName: "Legit",
        username: "hacked",
        role: "admin",
        userId: otherId,
        version: 999,
      },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_profile_key");

    const afterUser = userRow(userId);
    expect(afterUser.username).toBe(beforeUser.username);
    expect(afterUser.role).toBe(beforeUser.role);
    expect(profileRow(userId)).toBeUndefined();
  });

  it("16. audit row carries field names only, never content", async () => {
    await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "Secret Name", bio: "private bio text" },
    });
    const rows = auditRows(userId);
    expect(rows.length).toBe(1);
    const details = JSON.parse(rows[0].details);
    expect(details).toEqual({ fields: ["displayName", "bio"] });
    expect(rows[0].details).not.toContain("Secret Name");
    expect(rows[0].details).not.toContain("private bio text");
  });

  it("17. returned profile contains only the intended properties", async () => {
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "Name" },
    });
    expect(Object.keys(r.data.profile).sort()).toEqual(
      ["avatarVersion", "bio", "displayName", "pronouns", "updatedAt"].sort(),
    );
    const g = await api.request("GET", "/api/auth/profile", { token });
    expect(Object.keys(g.data.profile).sort()).toEqual(
      ["avatarVersion", "bio", "displayName", "pronouns", "updatedAt"].sort(),
    );
  });

  it("SECURITY: identity-field injection cannot alter auth identity or role, in response or DB", async () => {
    await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "Baseline" },
    });
    const beforeSelf = userRow(userId);
    const beforeOther = userRow(otherId);

    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { username: "root", role: "admin", userId: otherId },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe("invalid_profile_key");
    expect(r.data.profile).toBeUndefined();

    const afterSelf = userRow(userId);
    expect(afterSelf.username).toBe(beforeSelf.username);
    expect(afterSelf.role).toBe("user");
    const afterOther = userRow(otherId);
    expect(afterOther.username).toBe(beforeOther.username);
    expect(afterOther.role).toBe(beforeOther.role);

    const me = await api.request("GET", "/api/auth/me", { token });
    expect(me.data.user.id).toBe(userId);
    expect(me.data.user.username).toBe("profile_user");
    expect(me.data.user.role).toBe("user");

    expect(profileRow(otherId)).toBeUndefined();
  });

  it("fires the collab profile-event hook once for the acting user on a successful PUT", async () => {
    const spy = vi
      .spyOn(collaborationManager, "broadcastProfileEventForUser")
      .mockImplementation(() => {});
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "Hooked" },
    });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(userId);
  });

  it("does NOT fire the collab hook when validation rejects the PUT", async () => {
    const spy = vi
      .spyOn(collaborationManager, "broadcastProfileEventForUser")
      .mockImplementation(() => {});
    const r = await api.request("PUT", "/api/auth/profile", {
      token,
      body: { bogus: 1 },
    });
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ownership is always req.user — a second user keeps a separate profile", async () => {
    await api.request("PUT", "/api/auth/profile", {
      token,
      body: { displayName: "First" },
    });
    await api.request("PUT", "/api/auth/profile", {
      token: otherToken,
      body: { displayName: "Second" },
    });
    const a = await api.request("GET", "/api/auth/profile", { token });
    const b = await api.request("GET", "/api/auth/profile", {
      token: otherToken,
    });
    expect(a.data.profile.displayName).toBe("First");
    expect(b.data.profile.displayName).toBe("Second");
  });
});
