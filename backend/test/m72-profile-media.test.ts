import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { openDb, type Db } from "../src/db.js";
import { makeTestConfig } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import {
  storeAvatar,
  deleteAvatar,
  getAvatarFile,
  canViewAvatar,
  usersShareAProject,
  removeUserMediaDir,
  profileMediaUserDir,
} from "../src/profile/media.js";
import { getAvatarVersion, getProfile } from "../src/profile/store.js";
import { makePng, makeSvg } from "./imageFixture.js";

let cfg: AppConfig;
let db: Db;

function seedUsers(): void {
  db.prepare(
    "INSERT INTO users (id,username,password_hash,role) VALUES " +
      "(1,'alice','h','user'),(2,'bob','h','user'),(3,'carol','h','user'),(9,'root','h','admin')",
  ).run();
}

function addProject(id: string, ownerId: number): void {
  db.prepare(
    "INSERT INTO projects (id, owner_id, name) VALUES (?, ?, ?)",
  ).run(id, ownerId, `proj-${id}`);
}

beforeEach(() => {
  cfg = makeTestConfig();
  db = openDb(":memory:");
  seedUsers();
});

afterEach(() => {
  try {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("M72 avatar media storage", () => {
  it("1. storeAvatar writes a file, a media row, and bumps the profile version", async () => {
    const out = await storeAvatar(db, cfg, 1, makePng(64, 64));
    expect(out.mime).toBe("image/png");
    expect(out.avatarVersion).toBe(1);
    const file = getAvatarFile(db, cfg, 1);
    expect(file).not.toBeNull();
    expect(existsSync(file!.absPath)).toBe(true);
    expect(file!.mime).toBe("image/png");
    // stored under <dataDir>/profile-media/1/
    expect(file!.absPath.startsWith(profileMediaUserDir(cfg, 1))).toBe(true);
  });

  it("2. getProfile / getAvatarVersion report the cache-buster", async () => {
    expect(getAvatarVersion(db, 1)).toBe(0);
    expect(getProfile(db, 1).avatarVersion).toBe(0);
    await storeAvatar(db, cfg, 1, makePng(64, 64));
    expect(getAvatarVersion(db, 1)).toBe(1);
    expect(getProfile(db, 1).avatarVersion).toBe(1);
  });

  it("3. replacing an avatar unlinks the old file and bumps the version again", async () => {
    const first = await storeAvatar(db, cfg, 1, makePng(64, 64));
    const firstPath = getAvatarFile(db, cfg, 1)!.absPath;
    const second = await storeAvatar(db, cfg, 1, makePng(80, 80));
    expect(second.avatarVersion).toBe(first.avatarVersion + 1);
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(getAvatarFile(db, cfg, 1)!.absPath)).toBe(true);
    // exactly one media row survives
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM profile_media WHERE user_id = 1")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("4. deleteAvatar clears the pointer, drops the row, unlinks, bumps version", async () => {
    await storeAvatar(db, cfg, 1, makePng(64, 64));
    const path = getAvatarFile(db, cfg, 1)!.absPath;
    const removed = await deleteAvatar(db, cfg, 1);
    expect(removed).toBe(true);
    expect(getAvatarFile(db, cfg, 1)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(getAvatarVersion(db, 1)).toBe(0);
    expect(getProfile(db, 1).avatarVersion).toBe(0);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM profile_media WHERE user_id = 1")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("5. deleteAvatar on a user with no avatar returns false", async () => {
    expect(await deleteAvatar(db, cfg, 2)).toBe(false);
  });

  it("6. an invalid image never writes a file or a row", async () => {
    await expect(storeAvatar(db, cfg, 1, makeSvg())).rejects.toThrow();
    expect(getAvatarFile(db, cfg, 1)).toBeNull();
    expect(existsSync(profileMediaUserDir(cfg, 1))).toBe(false);
  });

  it("7. a DB failure inside the transaction rolls back and unlinks the new file", async () => {
    // userId 404 is absent from `users`; the profile_media FK insert fails
    // mid-transaction after the file has been written.
    await expect(storeAvatar(db, cfg, 404, makePng(64, 64))).rejects.toThrow();
    // the freshly written file was cleaned up
    const dir = profileMediaUserDir(cfg, 404);
    const leftovers = existsSync(dir) ? readdirSync(dir) : [];
    expect(leftovers).toEqual([]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM profile_media WHERE user_id = 404")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("8. a failed replacement leaves the previous avatar and version intact", async () => {
    await storeAvatar(db, cfg, 1, makePng(64, 64));
    const goodPath = getAvatarFile(db, cfg, 1)!.absPath;
    const v1 = getAvatarVersion(db, 1);
    await expect(
      storeAvatar(db, cfg, 1, Buffer.from("not an image")),
    ).rejects.toThrow();
    expect(existsSync(goodPath)).toBe(true);
    expect(getAvatarVersion(db, 1)).toBe(v1);
  });

  it("9. removeUserMediaDir wipes the whole per-user directory", async () => {
    await storeAvatar(db, cfg, 1, makePng(64, 64));
    expect(existsSync(profileMediaUserDir(cfg, 1))).toBe(true);
    await removeUserMediaDir(cfg, 1);
    expect(existsSync(profileMediaUserDir(cfg, 1))).toBe(false);
    // idempotent / no throw on a missing dir
    await expect(removeUserMediaDir(cfg, 1)).resolves.toBeUndefined();
  });

  it("10. getAvatarFile resolves inside the per-user directory only", async () => {
    await storeAvatar(db, cfg, 1, makePng(64, 64));
    // tamper the stored path to point outside; the read guard must throw
    db.prepare(
      "UPDATE profile_media SET storage_path = '../../etc/passwd' WHERE user_id = 1",
    ).run();
    expect(() => getAvatarFile(db, cfg, 1)).toThrow();
  });
});

describe("M72 avatar access model", () => {
  it("11. self can always view", () => {
    expect(canViewAvatar(db, 1, 1)).toBe(true);
  });

  it("12. a platform admin can view anyone", () => {
    expect(canViewAvatar(db, 9, 1)).toBe(true);
  });

  it("13. strangers with no shared project cannot view", () => {
    addProject("p1", 1);
    addProject("p2", 2);
    expect(canViewAvatar(db, 2, 1)).toBe(false);
    expect(usersShareAProject(db, 1, 2)).toBe(false);
  });

  it("14. an owner and a collaborator on the same project can view each other", () => {
    addProject("p1", 1);
    db.prepare(
      "INSERT INTO project_collaborators (project_id, user_id, role) VALUES ('p1', 2, 'editor')",
    ).run();
    expect(usersShareAProject(db, 1, 2)).toBe(true);
    expect(canViewAvatar(db, 2, 1)).toBe(true);
    expect(canViewAvatar(db, 1, 2)).toBe(true);
    // carol still cannot
    expect(canViewAvatar(db, 3, 1)).toBe(false);
  });

  it("15. revoking the share removes visibility", () => {
    addProject("p1", 1);
    db.prepare(
      "INSERT INTO project_collaborators (project_id, user_id, role) VALUES ('p1', 2, 'editor')",
    ).run();
    expect(canViewAvatar(db, 2, 1)).toBe(true);
    db.prepare(
      "DELETE FROM project_collaborators WHERE project_id = 'p1' AND user_id = 2",
    ).run();
    expect(canViewAvatar(db, 2, 1)).toBe(false);
  });
});
