// M60: per-user, per-project "last seen here" boundary for While You Were Away.
// Keyed by the authenticated userId — NEVER a Yjs clientId. Updated only at
// meaningful lifecycle boundaries (session end, while-away ack, first connect),
// never on a heartbeat. See spec §10.1 / §14.

import type { Db } from "../db.js";

export function getLastSeen(
  db: Db,
  projectId: string,
  userId: number,
): string | null {
  const row = db
    .prepare(
      "SELECT last_seen_at FROM collab_last_seen WHERE project_id = ? AND user_id = ?",
    )
    .get(projectId, userId) as { last_seen_at: string } | undefined;
  return row?.last_seen_at ?? null;
}

/**
 * Upsert `last_seen_at` to `max(existing, atIso ?? now)` — monotonic, so a late
 * or out-of-order caller can never rewind the boundary and re-surface events the
 * user has already acknowledged.
 */
export function touchLastSeen(
  db: Db,
  projectId: string,
  userId: number,
  atIso?: string,
): void {
  const at = atIso ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO collab_last_seen (project_id, user_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET
       last_seen_at = CASE WHEN excluded.last_seen_at > last_seen_at
                           THEN excluded.last_seen_at ELSE last_seen_at END`,
  ).run(projectId, userId, at);
}

/**
 * Insert `now` only when no row exists — a first-time collaborator has no
 * "away" backlog. Called on collab connect; a no-op on every subsequent connect.
 */
export function insertLastSeenIfAbsent(
  db: Db,
  projectId: string,
  userId: number,
): void {
  db.prepare(
    `INSERT INTO collab_last_seen (project_id, user_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id, user_id) DO NOTHING`,
  ).run(projectId, userId, new Date().toISOString());
}
