import type { Db } from "../db.js";
import type { ProfileField, ProfilePatch } from "./validate.js";

/**
 * M62-2 — all `user_profiles` SQL for the self-service identity API lives
 * here. `display_name`, `pronouns` and `bio` are the writable text fields;
 * `avatar_media_id` is read only to derive the `avatarVersion` cache-buster
 * (M72). Every other column (banners, accent, effect, visibility, `show_*`,
 * `location`) is never selected and never touched, so dormant profile state
 * cannot leak through this endpoint.
 *
 * `version` is DB-controlled: `+1` on every successful UPSERT, never
 * request-supplied. `updated_at` is an ISO-8601 millisecond timestamp set by
 * SQLite on each write.
 */

export interface ProfileResponse {
  displayName: string | null;
  pronouns: string | null;
  bio: string | null;
  updatedAt: string | null;
  /** M72: 0 when no avatar is set; otherwise `user_profiles.version` at the
   *  time of the read, used purely as a client-side URL cache-buster. Never
   *  a media id or a filesystem path. */
  avatarVersion: number;
}

interface ProfileRow {
  display_name: string | null;
  pronouns: string | null;
  bio: string | null;
  updated_at: string | null;
  avatar_media_id: string | null;
  version: number;
}

const NULL_PROFILE: ProfileResponse = {
  displayName: null,
  pronouns: null,
  bio: null,
  updatedAt: null,
  avatarVersion: 0,
};

/** The one canonical row -> response mapping. Missing row => all-null. */
function toResponse(row: ProfileRow | undefined): ProfileResponse {
  if (!row) return { ...NULL_PROFILE };
  return {
    displayName: row.display_name ?? null,
    pronouns: row.pronouns ?? null,
    bio: row.bio ?? null,
    updatedAt: row.updated_at ?? null,
    avatarVersion: row.avatar_media_id ? row.version : 0,
  };
}

// ISO-8601 with millisecond precision so two PUTs in the same wall-clock
// second still produce a strictly changed `updated_at`.
const NOW_MS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function getProfile(db: Db, userId: number): ProfileResponse {
  const row = db
    .prepare(
      `SELECT display_name, pronouns, bio, updated_at, avatar_media_id, version
       FROM user_profiles WHERE user_id = ?`,
    )
    .get(userId) as ProfileRow | undefined;
  return toResponse(row);
}

/**
 * M72: the avatar cache-buster integer for `userId` (0 = no avatar). Used by
 * the collaboration room's per-room identity cache — never the awareness
 * hot path, and never returns a media id or path.
 */
export function getAvatarVersion(db: Db, userId: number): number {
  const row = db
    .prepare(
      "SELECT avatar_media_id, version FROM user_profiles WHERE user_id = ?",
    )
    .get(userId) as
    | { avatar_media_id: string | null; version: number }
    | undefined;
  if (!row || !row.avatar_media_id) return 0;
  return row.version;
}

/**
 * Just the raw `display_name` column for `userId` (nullable). Used by the
 * collaboration layer to (re)populate its per-room effective-display-name
 * cache — a single narrow column read, never run inside an awareness frame.
 * Resolve to an effective display string via `effectiveDisplayName`.
 */
export function getDisplayName(db: Db, userId: number): string | null {
  const row = db
    .prepare("SELECT display_name FROM user_profiles WHERE user_id = ?")
    .get(userId) as { display_name: string | null } | undefined;
  return row?.display_name ?? null;
}

export interface ProfileUpdateResult {
  profile: ProfileResponse;
  /** Field names that were present in the patch — for the audit row only. */
  changedFields: ProfileField[];
}

/**
 * UPSERT the three writable identity columns for `userId`. Keys absent from
 * `patch` keep their current persisted value (partial patch). `version` is
 * incremented and `updated_at` refreshed by the DB on every call.
 */
export function updateProfile(
  db: Db,
  userId: number,
  patch: ProfilePatch,
): ProfileUpdateResult {
  const changedFields = Object.keys(patch) as ProfileField[];

  const current = db
    .prepare(
      "SELECT display_name, pronouns, bio FROM user_profiles WHERE user_id = ?",
    )
    .get(userId) as
    | { display_name: string | null; pronouns: string | null; bio: string | null }
    | undefined;

  const displayName =
    "displayName" in patch
      ? patch.displayName ?? null
      : current?.display_name ?? null;
  const pronouns =
    "pronouns" in patch ? patch.pronouns ?? null : current?.pronouns ?? null;
  const bio = "bio" in patch ? patch.bio ?? null : current?.bio ?? null;

  db.prepare(
    `INSERT INTO user_profiles (user_id, display_name, pronouns, bio, version, updated_at)
     VALUES (?, ?, ?, ?, 1, ${NOW_MS})
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = excluded.display_name,
       pronouns     = excluded.pronouns,
       bio          = excluded.bio,
       version      = user_profiles.version + 1,
       updated_at   = ${NOW_MS}`,
  ).run(userId, displayName, pronouns, bio);

  return { profile: getProfile(db, userId), changedFields };
}
