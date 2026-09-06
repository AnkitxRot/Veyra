import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import {
  extForMime,
  validateImage,
  type AvatarMime,
  type ValidatedImage,
} from "./image.js";

/**
 * M72 — one live avatar per user. Files live at
 * `<dataDir>/profile-media/<userId>/<uuid>.<ext>` — outside every project
 * workspace. The path is built only from the numeric userId and a server
 * UUID; nothing the client supplies (filename, declared type) ever reaches
 * the filesystem. Replacing an avatar deletes the previous DB row and
 * unlinks its file (best-effort, after the replacement has committed).
 */

export interface StoredAvatar {
  id: string;
  mime: AvatarMime;
  width: number;
  height: number;
  bytes: number;
  /** `user_profiles.version` after the write — the URL cache-buster. */
  avatarVersion: number;
}

export interface AvatarFile {
  absPath: string;
  mime: AvatarMime;
  bytes: number;
}

const NOW_MS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function profileMediaRoot(cfg: AppConfig): string {
  return resolve(cfg.dataDir, "profile-media");
}

export function profileMediaUserDir(cfg: AppConfig, userId: number): string {
  return resolve(profileMediaRoot(cfg), String(userId));
}

/** Defence in depth: the resolved file must stay inside the user's own dir. */
function assertInsideUserDir(userDir: string, absPath: string): void {
  const rel = relative(userDir, absPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..`) || isAbsolute(rel)) {
    throw new ApiError(
      500,
      "avatar path escaped its storage directory",
      "invalid_storage_path",
    );
  }
}

export function avatarLimits(cfg: AppConfig) {
  return {
    maxBytes: cfg.profileMediaAvatarMaxBytes,
    maxWidth: cfg.profileMediaAvatarMaxDim,
    maxHeight: cfg.profileMediaAvatarMaxDim,
    minDim: cfg.profileMediaAvatarMinDim,
  };
}

/** True when both users own or collaborate on at least one common project. */
export function usersShareAProject(
  db: Db,
  userA: number,
  userB: number,
): boolean {
  if (userA === userB) return true;
  const row = db
    .prepare(
      `WITH access(project_id, user_id) AS (
         SELECT id, owner_id FROM projects
         UNION
         SELECT project_id, user_id FROM project_collaborators
       )
       SELECT 1 AS ok
       FROM access a
       JOIN access b ON a.project_id = b.project_id
       WHERE a.user_id = ? AND b.user_id = ?
       LIMIT 1`,
    )
    .get(userA, userB) as { ok: number } | undefined;
  return row !== undefined;
}

/** Self, a platform admin, or someone who shares a project may view. */
export function canViewAvatar(
  db: Db,
  viewerId: number,
  targetId: number,
): boolean {
  if (viewerId === targetId) return true;
  const viewer = db
    .prepare("SELECT role FROM users WHERE id = ?")
    .get(viewerId) as { role?: string } | undefined;
  if (viewer?.role === "admin") return true;
  return usersShareAProject(db, viewerId, targetId);
}

function currentAvatarRow(
  db: Db,
  userId: number,
): { id: string; storage_path: string } | undefined {
  return db
    .prepare(
      `SELECT pm.id, pm.storage_path
       FROM user_profiles up
       JOIN profile_media pm ON pm.id = up.avatar_media_id
       WHERE up.user_id = ?`,
    )
    .get(userId) as { id: string; storage_path: string } | undefined;
}

async function unlinkQuietly(absPath: string): Promise<void> {
  try {
    await fs.unlink(absPath);
  } catch {
    /* best-effort: a missing file is fine */
  }
}

/**
 * Persist a validated avatar, replacing any previous one. The file is written
 * first; the DB rows (media insert, profile pointer + version bump, old-row
 * delete) commit as one transaction; on any DB failure the freshly written
 * file is removed and the previous avatar is left untouched.
 */
export async function storeAvatar(
  db: Db,
  cfg: AppConfig,
  userId: number,
  buf: Buffer,
  declaredMime?: string,
): Promise<StoredAvatar> {
  const info: ValidatedImage = validateImage(
    buf,
    avatarLimits(cfg),
    declaredMime,
  );
  const id = randomUUID();
  const ext = extForMime(info.mime);
  const userDir = profileMediaUserDir(cfg, userId);
  const absPath = resolve(userDir, `${id}.${ext}`);
  assertInsideUserDir(userDir, absPath);
  const storagePath = join("profile-media", String(userId), `${id}.${ext}`);

  const previous = currentAvatarRow(db, userId);

  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(absPath, buf);

  let avatarVersion: number;
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO profile_media
         (id, user_id, kind, mime, width, height, bytes, storage_path)
       VALUES (?, ?, 'avatar', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      info.mime,
      info.width,
      info.height,
      info.bytes,
      storagePath,
    );

    db.prepare(
      `INSERT INTO user_profiles (user_id, avatar_media_id, version, updated_at)
       VALUES (?, ?, 1, ${NOW_MS})
       ON CONFLICT(user_id) DO UPDATE SET
         avatar_media_id = excluded.avatar_media_id,
         version         = user_profiles.version + 1,
         updated_at      = ${NOW_MS}`,
    ).run(userId, id);

    if (previous) {
      db.prepare("DELETE FROM profile_media WHERE id = ?").run(previous.id);
    }

    const ver = db
      .prepare("SELECT version FROM user_profiles WHERE user_id = ?")
      .get(userId) as { version: number };
    avatarVersion = ver.version;
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore a rollback that itself fails */
    }
    await unlinkQuietly(absPath);
    throw err;
  }

  if (previous) {
    await unlinkQuietly(resolve(cfg.dataDir, previous.storage_path));
  }

  return {
    id,
    mime: info.mime,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    avatarVersion,
  };
}

/** Clear the user's avatar. Returns false when there was none. */
export async function deleteAvatar(
  db: Db,
  cfg: AppConfig,
  userId: number,
): Promise<boolean> {
  const previous = currentAvatarRow(db, userId);
  if (!previous) return false;

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE user_profiles
       SET avatar_media_id = NULL,
           version = version + 1,
           updated_at = ${NOW_MS}
       WHERE user_id = ?`,
    ).run(userId);
    db.prepare("DELETE FROM profile_media WHERE id = ?").run(previous.id);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }

  await unlinkQuietly(resolve(cfg.dataDir, previous.storage_path));
  return true;
}

/** The on-disk avatar for `userId`, or null. MIME comes from the stored row. */
export function getAvatarFile(
  db: Db,
  cfg: AppConfig,
  userId: number,
): AvatarFile | null {
  const row = db
    .prepare(
      `SELECT pm.mime, pm.bytes, pm.storage_path
       FROM user_profiles up
       JOIN profile_media pm ON pm.id = up.avatar_media_id
       WHERE up.user_id = ? AND pm.kind = 'avatar'`,
    )
    .get(userId) as
    | { mime: AvatarMime; bytes: number; storage_path: string }
    | undefined;
  if (!row) return null;
  const absPath = resolve(cfg.dataDir, row.storage_path);
  assertInsideUserDir(profileMediaUserDir(cfg, userId), absPath);
  return { absPath, mime: row.mime, bytes: row.bytes };
}

/** Best-effort wipe of a user's profile-media directory (on user deletion). */
export async function removeUserMediaDir(
  cfg: AppConfig,
  userId: number,
): Promise<void> {
  try {
    await fs.rm(profileMediaUserDir(cfg, userId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort */
  }
}
