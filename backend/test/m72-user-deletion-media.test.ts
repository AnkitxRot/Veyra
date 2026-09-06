import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { hashPassword } from "../src/auth/passwords.js";
import { ensureAdminUser } from "../src/db.js";
import { cleanupExpiredDemoAccounts } from "../src/auth/demoGc.js";
import { profileMediaUserDir } from "../src/profile/media.js";
import type { AppConfig } from "../src/config.js";
import { makePng, multipart } from "./imageFixture.js";

let cfg: AppConfig;
let api: TestApi;

beforeEach(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);
});

afterEach(async () => {
  await api.close();
  try {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("M72 — avatar media is wiped on user deletion", () => {
  it("admin user deletion removes the on-disk avatar directory", async () => {
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "doomed_user", password: "password123" },
    });
    const victimId: number = reg.data.user.id;
    const victimToken: string = reg.data.token;

    const { body, contentType } = multipart("a.png", makePng(64, 64));
    const up = await fetch(`${api.base}/api/auth/profile/avatar`, {
      method: "POST",
      headers: { "Content-Type": contentType, Authorization: `Bearer ${victimToken}` },
      body,
    });
    expect(up.status).toBe(200);
    expect(existsSync(profileMediaUserDir(cfg, victimId))).toBe(true);

    ensureAdminUser(api.db, "admin_del", await hashPassword("AdminPass@123"));
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "admin_del", password: "AdminPass@123" },
    });
    const del = await api.request(
      "DELETE",
      `/api/admin/users/${victimId}`,
      { token: adminLogin.data.token },
    );
    expect(del.status).toBe(200);
    expect(existsSync(profileMediaUserDir(cfg, victimId))).toBe(false);
  });

  it("demo-account GC removes any leftover avatar directory", async () => {
    const db = api.db;
    // an aged demo account with no live session
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    db.prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES ('evaluator_beef', 'h', ?)",
    ).run(old);
    const demoId = (
      db.prepare("SELECT id FROM users WHERE username = 'evaluator_beef'").get() as {
        id: number;
      }
    ).id;

    // simulate a leftover media directory for that user
    const dir = profileMediaUserDir(cfg, demoId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "leftover.png"), makePng(32, 32));
    expect(existsSync(dir)).toBe(true);

    const res = await cleanupExpiredDemoAccounts(cfg, db, Date.now());
    expect(res.cleanedUsers).toBeGreaterThanOrEqual(1);
    expect(existsSync(dir)).toBe(false);
  });
});
