import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AnchorPayload } from "./validate.js";

/**
 * M61-A comment thread DB layer. All functions synchronous, `db` first,
 * returning plain rows. No auth, no validation, no broadcast — the route
 * (`comments/routes.ts`) owns those. A "thread" is a root comment
 * (`parent_comment_id IS NULL`) plus an anchor and resolution state;
 * replies are exactly one level deep.
 */

export interface ThreadRow {
  id: string;
  project_id: string;
  file_path: string;
  anchor_rel_start: string | null;
  anchor_rel_end: string | null;
  anchor_start_line: number;
  anchor_end_line: number;
  anchor_prefix_hash: string;
  anchor_prefix: string;
  anchor_status: string;
  created_by: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: number | null;
  root_comment_id: string;
}

export interface CommentRow {
  id: string;
  thread_id: string;
  project_id: string;
  parent_comment_id: string | null;
  author_id: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface ReactionRow {
  comment_id: string;
  user_id: number;
  emoji: string;
  created_at: string;
}

export interface ThreadWithComments {
  thread: ThreadRow;
  root: CommentRow;
  replies: CommentRow[];
  reactions: ReactionRow[];
  mentions: { userId: number; username: string }[];
}

export type ThreadStatusFilter = "active" | "resolved" | "all";

// ---------------------------------------------------------------------------
// Anchor blob helpers — the base64 the client sends is stored verbatim as an
// opaque BLOB and re-emitted as base64. The server NEVER decodes it as a
// Y.RelativePosition.
// ---------------------------------------------------------------------------

function toBlob(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}
function fromBlob(v: unknown): string | null {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  return null;
}

function mapThread(r: Record<string, unknown>): ThreadRow {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    file_path: r.file_path as string,
    anchor_rel_start: fromBlob(r.anchor_rel_start),
    anchor_rel_end: fromBlob(r.anchor_rel_end),
    anchor_start_line: r.anchor_start_line as number,
    anchor_end_line: r.anchor_end_line as number,
    anchor_prefix_hash: r.anchor_prefix_hash as string,
    anchor_prefix: r.anchor_prefix as string,
    anchor_status: r.anchor_status as string,
    created_by: r.created_by as number,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    resolved_at: (r.resolved_at as string | null) ?? null,
    resolved_by: (r.resolved_by as number | null) ?? null,
    root_comment_id: r.root_comment_id as string,
  };
}

function bumpThread(db: Db, threadId: string): void {
  db.prepare(
    "UPDATE comment_threads SET updated_at = datetime('now') WHERE id = ?",
  ).run(threadId);
}
function bumpThreadByComment(db: Db, commentId: string): void {
  db.prepare(
    `UPDATE comment_threads SET updated_at = datetime('now')
       WHERE id = (SELECT thread_id FROM comments WHERE id = ?)`,
  ).run(commentId);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function createThread(
  db: Db,
  input: {
    projectId: string;
    filePath: string;
    authorId: number;
    body: string;
    anchor: AnchorPayload;
  },
): { threadId: string; rootCommentId: string } {
  const threadId = randomUUID();
  const rootCommentId = randomUUID();
  const { projectId, filePath, authorId, body, anchor } = input;
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO comment_threads
        (id, project_id, file_path, anchor_rel_start, anchor_rel_end,
         anchor_start_line, anchor_end_line, anchor_prefix_hash, anchor_prefix,
         created_by, root_comment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId,
      projectId,
      filePath,
      toBlob(anchor.relStart),
      toBlob(anchor.relEnd),
      anchor.startLine,
      anchor.endLine,
      anchor.prefixHash,
      anchor.slice,
      authorId,
      rootCommentId,
    );
    db.prepare(
      `INSERT INTO comments
        (id, thread_id, project_id, parent_comment_id, author_id, body)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(rootCommentId, threadId, projectId, authorId, body);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  return { threadId, rootCommentId };
}

export function addReply(
  db: Db,
  input: {
    threadId: string;
    projectId: string;
    authorId: number;
    body: string;
  },
): { commentId: string } {
  const thread = db
    .prepare("SELECT root_comment_id FROM comment_threads WHERE id = ?")
    .get(input.threadId) as { root_comment_id: string } | undefined;
  if (!thread) throw new Error("thread not found");
  const commentId = randomUUID();
  db.prepare(
    `INSERT INTO comments
      (id, thread_id, project_id, parent_comment_id, author_id, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    commentId,
    input.threadId,
    input.projectId,
    thread.root_comment_id,
    input.authorId,
    input.body,
  );
  bumpThread(db, input.threadId);
  return { commentId };
}

export function editComment(
  db: Db,
  input: { commentId: string; authorId: number; body: string },
): boolean {
  const row = db
    .prepare("SELECT author_id, deleted_at FROM comments WHERE id = ?")
    .get(input.commentId) as
    | { author_id: number; deleted_at: string | null }
    | undefined;
  if (!row || row.author_id !== input.authorId || row.deleted_at != null) {
    return false;
  }
  db.prepare(
    "UPDATE comments SET body = ?, edited_at = datetime('now') WHERE id = ?",
  ).run(input.body, input.commentId);
  bumpThreadByComment(db, input.commentId);
  return true;
}

export function tombstoneComment(
  db: Db,
  input: { commentId: string; actorId: number; projectOwnerId: number },
): boolean {
  const row = db
    .prepare("SELECT author_id, deleted_at FROM comments WHERE id = ?")
    .get(input.commentId) as
    | { author_id: number; deleted_at: string | null }
    | undefined;
  if (!row) return false;
  if (
    input.actorId !== row.author_id &&
    input.actorId !== input.projectOwnerId
  ) {
    return false;
  }
  if (row.deleted_at != null) return true; // already tombstoned — idempotent
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE comments SET deleted_at = datetime('now'), body = '' WHERE id = ?",
    ).run(input.commentId);
    db.prepare("DELETE FROM comment_mentions WHERE comment_id = ?").run(
      input.commentId,
    );
    db.prepare("DELETE FROM comment_reactions WHERE comment_id = ?").run(
      input.commentId,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  bumpThreadByComment(db, input.commentId);
  return true;
}

export function resolveThread(
  db: Db,
  input: { threadId: string; actorId: number },
): void {
  db.prepare(
    `UPDATE comment_threads
       SET resolved_at = datetime('now'), resolved_by = ?, updated_at = datetime('now')
       WHERE id = ? AND resolved_at IS NULL`,
  ).run(input.actorId, input.threadId);
}

export function reopenThread(db: Db, input: { threadId: string }): void {
  db.prepare(
    `UPDATE comment_threads
       SET resolved_at = NULL, resolved_by = NULL, updated_at = datetime('now')
       WHERE id = ?`,
  ).run(input.threadId);
}

export function setThreadAnchorStatus(
  db: Db,
  threadId: string,
  status: "ok" | "stale",
): void {
  db.prepare("UPDATE comment_threads SET anchor_status = ? WHERE id = ?").run(
    status,
    threadId,
  );
}

export function replaceMentions(
  db: Db,
  commentId: string,
  userIds: number[],
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM comment_mentions WHERE comment_id = ?").run(
      commentId,
    );
    const ins = db.prepare(
      "INSERT INTO comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );
    for (const uid of userIds) ins.run(commentId, uid);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function upsertReaction(
  db: Db,
  commentId: string,
  userId: number,
  emoji: string,
): void {
  db.prepare(
    "INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(commentId, userId, emoji);
  bumpThreadByComment(db, commentId);
}

export function removeReaction(
  db: Db,
  commentId: string,
  userId: number,
  emoji: string,
): void {
  db.prepare(
    "DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?",
  ).run(commentId, userId, emoji);
  bumpThreadByComment(db, commentId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function assemble(db: Db, threads: ThreadRow[]): ThreadWithComments[] {
  if (threads.length === 0) return [];
  const ids = threads.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const comments = db
    .prepare(
      `SELECT * FROM comments WHERE thread_id IN (${placeholders})
         ORDER BY created_at ASC, id ASC`,
    )
    .all(...ids) as unknown as CommentRow[];
  const commentIds = comments.map((c) => c.id);
  const cPlaceholders = commentIds.map(() => "?").join(",") || "NULL";
  const reactions =
    commentIds.length > 0
      ? (db
          .prepare(
            `SELECT * FROM comment_reactions WHERE comment_id IN (${cPlaceholders})
               ORDER BY created_at ASC`,
          )
          .all(...commentIds) as unknown as ReactionRow[])
      : [];
  const mentionRows =
    commentIds.length > 0
      ? (db
          .prepare(
            `SELECT m.comment_id, m.mentioned_user_id AS user_id, u.username
               FROM comment_mentions m JOIN users u ON u.id = m.mentioned_user_id
               WHERE m.comment_id IN (${cPlaceholders})`,
          )
          .all(...commentIds) as unknown as {
          comment_id: string;
          user_id: number;
          username: string;
        }[])
      : [];

  const byThread = new Map<string, CommentRow[]>();
  for (const c of comments) {
    const arr = byThread.get(c.thread_id) ?? [];
    arr.push(c);
    byThread.set(c.thread_id, arr);
  }
  const reactionsByThread = new Map<string, ReactionRow[]>();
  const commentThread = new Map<string, string>();
  for (const c of comments) commentThread.set(c.id, c.thread_id);
  for (const r of reactions) {
    const tid = commentThread.get(r.comment_id);
    if (!tid) continue;
    const arr = reactionsByThread.get(tid) ?? [];
    arr.push(r);
    reactionsByThread.set(tid, arr);
  }
  const mentionsByThread = new Map<string, Map<number, string>>();
  for (const m of mentionRows) {
    const tid = commentThread.get(m.comment_id);
    if (!tid) continue;
    const map = mentionsByThread.get(tid) ?? new Map<number, string>();
    map.set(m.user_id, m.username);
    mentionsByThread.set(tid, map);
  }

  const out: ThreadWithComments[] = [];
  for (const thread of threads) {
    const cs = byThread.get(thread.id) ?? [];
    const root =
      cs.find((c) => c.id === thread.root_comment_id) ??
      cs.find((c) => c.parent_comment_id == null);
    if (!root) continue;
    const replies = cs
      .filter((c) => c.id !== root.id)
      .sort((a, b) =>
        a.created_at === b.created_at
          ? a.id < b.id
            ? -1
            : 1
          : a.created_at < b.created_at
            ? -1
            : 1,
      );
    const mentionMap = mentionsByThread.get(thread.id) ?? new Map();
    out.push({
      thread,
      root,
      replies,
      reactions: reactionsByThread.get(thread.id) ?? [],
      mentions: [...mentionMap.entries()].map(([userId, username]) => ({
        userId,
        username: username as string,
      })),
    });
  }
  return out;
}

export function listThreadsForFile(
  db: Db,
  projectId: string,
  filePath: string,
  status: ThreadStatusFilter,
): ThreadWithComments[] {
  const clause =
    status === "active"
      ? "AND resolved_at IS NULL"
      : status === "resolved"
        ? "AND resolved_at IS NOT NULL"
        : "";
  const rows = db
    .prepare(
      `SELECT * FROM comment_threads
         WHERE project_id = ? AND file_path = ? ${clause}
         ORDER BY updated_at DESC, id DESC`,
    )
    .all(projectId, filePath) as unknown as Record<string, unknown>[];
  return assemble(db, rows.map(mapThread));
}

export function listUnresolved(
  db: Db,
  projectId: string,
  limit: number,
  before: string | null,
): { threads: ThreadWithComments[]; nextBefore: string | null } {
  const cur = before ? decodeCursor(before) : null;
  const lim = Math.max(1, Math.min(100, limit));
  const params: (string | number)[] = [projectId];
  let clause = "";
  if (cur) {
    clause = "AND (updated_at < ? OR (updated_at = ? AND id < ?))";
    params.push(cur.at, cur.at, cur.id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM comment_threads
         WHERE project_id = ? AND resolved_at IS NULL ${clause}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
    )
    .all(...params, lim + 1) as unknown as Record<string, unknown>[];
  const mapped = rows.map(mapThread);
  const page = mapped.slice(0, lim);
  const nextBefore =
    mapped.length > lim && page.length > 0
      ? encodeCursor(
          page[page.length - 1].updated_at,
          page[page.length - 1].id,
        )
      : null;
  return { threads: assemble(db, page), nextBefore };
}

function encodeCursor(at: string, id: string): string {
  return `${at}|${id}`;
}
function decodeCursor(c: string): { at: string; id: string } | null {
  const i = c.indexOf("|");
  if (i < 0) return null;
  return { at: c.slice(0, i), id: c.slice(i + 1) };
}
