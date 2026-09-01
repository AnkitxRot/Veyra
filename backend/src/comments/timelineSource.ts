import type { Db } from "../db.js";
import type { TimelineEvent } from "../collab/timeline.js";

// Local copy of the timeline cursor decoder — kept here to avoid an import
// cycle with collab/timeline.ts (which imports this module).
function decodeCursor(c: string): { at: string; id: string } | null {
  const i = c.indexOf("|");
  if (i < 0) return null;
  return { at: c.slice(0, i), id: c.slice(i + 1) };
}

/**
 * M61-A: comment lifecycle as a 5th M60-timeline source. ONLY these events —
 * root created, reply added, thread resolved. Never composer keystrokes,
 * edits, reactions, or anchor-status pings. Reads `comment_threads` +
 * `comments` directly with an explicit safe column list (spec §4.9); audit
 * rows are supplementary, not the source (avoids double-count).
 */

function relFile(p: string): string {
  return p.split("/").pop() || p;
}

function preview(body: string): string | undefined {
  return body.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
}

export function queryCommentTimeline(
  db: Db,
  projectId: string,
  opts: { limit: number; before?: string | null; since?: string | null },
): TimelineEvent[] {
  const since = opts.since ?? "0000-01-01T00:00:00.000Z";
  const cur = opts.before ? decodeCursor(opts.before) : null;
  const fetch = Math.max(1, Math.min(200, opts.limit + 1));
  const out: TimelineEvent[] = [];

  const curClause = (tsCol: string, idExpr: string): string =>
    cur ? ` AND (${tsCol} < ? OR (${tsCol} = ? AND ${idExpr} < ?))` : "";
  const curParams: string[] = cur ? [cur.at, cur.at, cur.id] : [];

  // 1. root comments → "commented on <file> L<line>"
  const rootRows = db
    .prepare(
      `SELECT c.id, c.author_id, c.body, c.created_at, u.username,
              t.file_path, t.anchor_start_line, t.anchor_end_line
       FROM comments c
       JOIN comment_threads t ON t.id = c.thread_id
       LEFT JOIN users u ON u.id = c.author_id
       WHERE c.project_id = ? AND c.parent_comment_id IS NULL
         AND c.created_at > ?${curClause("c.created_at", "('comment:' || c.id)")}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: string;
    author_id: number | null;
    body: string;
    created_at: string;
    username: string | null;
    file_path: string;
    anchor_start_line: number;
    anchor_end_line: number;
  }>;
  for (const r of rootRows) {
    out.push({
      id: `comment:${r.id}`,
      kind: "comment",
      at: r.created_at,
      actor: {
        userId: r.author_id ?? null,
        username: r.username ?? "(removed user)",
      },
      filePath: r.file_path,
      lineRange: {
        startLine: r.anchor_start_line,
        endLine: r.anchor_end_line,
      },
      title: `commented on ${relFile(r.file_path)} L${r.anchor_start_line}`,
      subtitle: preview(r.body),
      navigable: true,
    });
  }

  // 2. replies → "replied on <file>"
  const replyRows = db
    .prepare(
      `SELECT c.id, c.author_id, c.body, c.created_at, u.username, t.file_path,
              t.anchor_start_line, t.anchor_end_line
       FROM comments c
       JOIN comment_threads t ON t.id = c.thread_id
       LEFT JOIN users u ON u.id = c.author_id
       WHERE c.project_id = ? AND c.parent_comment_id IS NOT NULL
         AND c.created_at > ?${curClause("c.created_at", "('comment:' || c.id)")}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: string;
    author_id: number | null;
    body: string;
    created_at: string;
    username: string | null;
    file_path: string;
    anchor_start_line: number;
    anchor_end_line: number;
  }>;
  for (const r of replyRows) {
    out.push({
      id: `comment:${r.id}`,
      kind: "comment",
      at: r.created_at,
      actor: {
        userId: r.author_id ?? null,
        username: r.username ?? "(removed user)",
      },
      filePath: r.file_path,
      lineRange: {
        startLine: r.anchor_start_line,
        endLine: r.anchor_end_line,
      },
      title: `replied on ${relFile(r.file_path)}`,
      subtitle: preview(r.body),
      navigable: true,
    });
  }

  // 3. resolved threads → "resolved a comment thread"
  const resolvedRows = db
    .prepare(
      `SELECT t.id, t.resolved_by, t.resolved_at, t.file_path,
              t.anchor_start_line, t.anchor_end_line, t.root_comment_id,
              u.username, rc.body AS root_body
       FROM comment_threads t
       LEFT JOIN users u ON u.id = t.resolved_by
       LEFT JOIN comments rc ON rc.id = t.root_comment_id
       WHERE t.project_id = ? AND t.resolved_at IS NOT NULL
         AND t.resolved_at > ?${curClause(
           "t.resolved_at",
           "('comment:res:' || t.id)",
         )}
       ORDER BY t.resolved_at DESC, t.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: string;
    resolved_by: number | null;
    resolved_at: string;
    file_path: string;
    anchor_start_line: number;
    anchor_end_line: number;
    root_comment_id: string;
    username: string | null;
    root_body: string | null;
  }>;
  for (const r of resolvedRows) {
    out.push({
      id: `comment:res:${r.id}`,
      kind: "comment",
      at: r.resolved_at,
      actor: {
        userId: r.resolved_by ?? null,
        username: r.username ?? "(removed user)",
      },
      filePath: r.file_path,
      lineRange: {
        startLine: r.anchor_start_line,
        endLine: r.anchor_end_line,
      },
      title: "resolved a comment thread",
      subtitle: r.root_body ? preview(r.root_body) : undefined,
      navigable: true,
    });
  }

  return out;
}
