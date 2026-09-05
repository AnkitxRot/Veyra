import type { Db } from "../db.js";
import type { ProfileField, ProfilePatch } from "./validate.js";

/**
 * M62-2 — all `user_profiles` SQL for the self-service identity API lives
 * here. Only `display_name`, `pronouns` and `bio` are read or written;
 * every other column on the row (avatar, banners, accent, effect,
 * visibility, `show_*`, `location`) is never selected and never touched, so
 * dormant profile state cannot leak through this endpoint.
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
}

interface ProfileRow {
  display_name: string | null;
  pronouns: string | null;
  bio: string | null;
  updated_at: string | null;
}

const NULL_PROFILE: ProfileResponse = {
  displayName: null,
  pronouns: null,
  bio: null,
  updatedAt: null,
};

/** The one canonical row -> response mapping. Missing row => all-null. */
function toResponse(row: ProfileRow | undefined): ProfileResponse {
  if (!row) return { ...NULL_PROFILE };
  return {
    displayName: row.display_name ?? null,
    pronouns: row.pronouns ?? null,
    bio: row.bio ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

// ISO-8601 with millisecond precision so two PUTs in the same wall-clock
// second still produce a strictly changed `updated_at`.
const NOW_MS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function getProfile(db: Db, userId: number): ProfileResponse {
  const row = db
    .prepare(
      "SELECT display_name, pronouns, bio, updated_at FROM user_profiles WHERE user_id = ?",
    )
    .get(userId) as ProfileRow | undefined;
  return toResponse(row);
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
