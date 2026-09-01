// M60: read-side timeline. Unions the derived collaboration_changes table with
// already-persisted execution (runs) and audited Git/snapshot events into one
// deterministically-ordered, stable-paginated TimelineEvent[]. Every source
// query is project-scoped first and selects an EXPLICIT safe column list —
// never SELECT * from runs / audit_logs (spec §7.3, §9).

import type { Db } from "../db.js";
import { queryCommentTimeline } from "../comments/timelineSource.js";

export interface TimelineEvent {
  /** "<source>:<sourceId>" — globally unique, the pagination tie-break key */
  id: string;
  kind: "edit_burst" | "callout" | "run" | "commit" | "snapshot" | "comment";
  /** ISO ms — the primary sort key (ended_at / created_at of the source row) */
  at: string;
  actor: { userId: number | null; username: string };
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  title: string;
  subtitle?: string;
  navigable: boolean;
}

export interface TimelinePage {
  events: TimelineEvent[];
  nextBefore: string | null;
}

const MAX_PAGE = 100;
const DEFAULT_PAGE = 40;

function clampLimit(n: number | undefined): number {
  if (!Number.isFinite(n as number)) return DEFAULT_PAGE;
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(n as number)));
}

export function encodeCursor(at: string, id: string): string {
  return `${at}|${id}`;
}

export function decodeCursor(
  c: string,
): { at: string; id: string } | null {
  const i = c.indexOf("|");
  if (i < 0) return null;
  return { at: c.slice(0, i), id: c.slice(i + 1) };
}

// Total order: at DESC, then id DESC. Immutable rows + tail-only retention ⇒
// a page boundary is stable across requests.
function cmp(a: TimelineEvent, b: TimelineEvent): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function beforePred(cur: { at: string; id: string } | null) {
  return (e: TimelineEvent): boolean =>
    !cur || e.at < cur.at || (e.at === cur.at && e.id < cur.id);
}

function relFile(p: string): string {
  return p.split("/").pop() || p;
}

function safeParse(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function queryTimeline(
  db: Db,
  projectId: string,
  opts: { limit?: number; before?: string | null; since?: string | null },
): TimelinePage {
  const limit = clampLimit(opts.limit);
  const cur = opts.before ? decodeCursor(opts.before) : null;
  const since = opts.since ?? "0000-01-01T00:00:00.000Z";
  const fetch = limit + 1;
  const out: TimelineEvent[] = [];

  // Push the (at,id) cursor into EVERY source query so each source returns its
  // newest `fetch` rows that are strictly before the cursor in the total order
  // — not its newest `fetch` rows overall. Without this, a source with more
  // than `fetch` rows newer than the cursor drops all of its older rows from
  // this and every later page (they are never fetched, so they can never be
  // merged back in). The id comparison is on the wire id (`<prefix>:<rowId>`),
  // matching `cmp`'s tie-break; the prefixes below are constants, never input.
  const curClause = (tsCol: string, idExpr: string): string =>
    cur ? ` AND (${tsCol} < ? OR (${tsCol} = ? AND ${idExpr} < ?))` : "";
  const curParams: string[] = cur ? [cur.at, cur.at, cur.id] : [];

  // 1. collaboration_changes (edit bursts + callouts)
  const ccRows = db
    .prepare(
      `SELECT cc.id, cc.author_user_id, cc.file_path, cc.kind, cc.ended_at,
              cc.update_count, cc.lines_added, cc.lines_removed,
              cc.start_line, cc.end_line, cc.detail, u.username
       FROM collaboration_changes cc
       LEFT JOIN users u ON u.id = cc.author_user_id
       WHERE cc.project_id = ? AND cc.ended_at > ?${curClause(
         "cc.ended_at",
         "('collab:' || cc.id)",
       )}
       ORDER BY cc.ended_at DESC, cc.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: string;
    author_user_id: number | null;
    file_path: string;
    kind: "edit_burst" | "callout";
    ended_at: string;
    update_count: number;
    lines_added: number;
    lines_removed: number;
    start_line: number | null;
    end_line: number | null;
    detail: string | null;
    username: string | null;
  }>;
  for (const r of ccRows) {
    const lineRange =
      r.start_line != null && r.end_line != null
        ? { startLine: r.start_line, endLine: r.end_line }
        : undefined;
    const detail = safeParse(r.detail);
    const changedLines = r.lines_added + r.lines_removed;
    out.push({
      id: `collab:${r.id}`,
      kind: r.kind,
      at: r.ended_at,
      actor: {
        userId: r.author_user_id ?? null,
        username: r.username ?? "(removed user)",
      },
      filePath: r.file_path,
      lineRange,
      title:
        r.kind === "callout"
          ? "left a callout"
          : lineRange
            ? `changed lines ${lineRange.startLine}–${lineRange.endLine}`
            : changedLines > 0
              ? `changed ${relFile(r.file_path)} (~${changedLines} lines)`
              : `changed ${relFile(r.file_path)}`,
      subtitle:
        r.kind === "callout" && typeof detail?.messagePreview === "string"
          ? (detail.messagePreview as string)
          : undefined,
      navigable: true,
    });
  }

  // 2. runs — SAFE COLUMNS ONLY (no stdout/stderr/signal/peak_memory/duration)
  const runRows = db
    .prepare(
      `SELECT r.id, r.user_id, r.language, r.file_path, r.status, r.exit_code,
              r.created_at, u.username
       FROM runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.project_id = ? AND r.created_at > ?${curClause(
         "r.created_at",
         "('run:' || r.id)",
       )}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: string;
    user_id: number | null;
    language: string;
    file_path: string;
    status: string;
    exit_code: number | null;
    created_at: string;
    username: string | null;
  }>;
  for (const r of runRows) {
    let outcome: string;
    if (r.status === "success") outcome = `exit ${r.exit_code ?? 0}`;
    else if (r.status === "cancelled") outcome = "cancelled";
    else if (r.status === "timeout") outcome = "timed out";
    else if (r.status === "killed") outcome = "killed";
    else outcome = "failed";
    out.push({
      id: `run:${r.id}`,
      kind: "run",
      at: r.created_at,
      actor: {
        userId: r.user_id ?? null,
        username: r.username ?? "(removed user)",
      },
      filePath: r.file_path,
      title: `ran ${relFile(r.file_path)} — ${outcome}`,
      navigable: true,
    });
  }

  // 3. Git commits — from audit_logs only, safe details fields only
  const commitRows = db
    .prepare(
      `SELECT a.id, a.user_id, a.details, a.created_at, u.username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.project_id = ? AND a.event_type = 'GIT_COMMIT' AND a.created_at > ?${curClause(
         "a.created_at",
         "('commit:' || a.id)",
       )}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: number;
    user_id: number | null;
    details: string | null;
    created_at: string;
    username: string | null;
  }>;
  for (const r of commitRows) {
    const d = safeParse(r.details) ?? {};
    const subject = String(d.subjectPreview ?? "").slice(0, 120);
    out.push({
      id: `commit:${r.id}`,
      kind: "commit",
      at: r.created_at,
      actor: {
        userId: r.user_id ?? null,
        username: r.username ?? "(removed user)",
      },
      title: subject ? `committed "${subject}"` : "committed",
      subtitle:
        typeof d.shortHash === "string" ? (d.shortHash as string) : undefined,
      navigable: false,
    });
  }

  // 4. Snapshots — from audit_logs only
  const snapRows = db
    .prepare(
      `SELECT a.id, a.user_id, a.event_type, a.details, a.created_at, u.username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.project_id = ?
         AND a.event_type IN ('SNAPSHOT_CREATED','SNAPSHOT_RESTORED')
         AND a.created_at > ?${curClause("a.created_at", "('snap:' || a.id)")}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(projectId, since, ...curParams, fetch) as Array<{
    id: number;
    user_id: number | null;
    event_type: string;
    details: string | null;
    created_at: string;
    username: string | null;
  }>;
  for (const r of snapRows) {
    const d = safeParse(r.details) ?? {};
    const restored = r.event_type === "SNAPSHOT_RESTORED";
    const name =
      typeof d.snapshotName === "string"
        ? String(d.snapshotName).slice(0, 80)
        : "";
    out.push({
      id: `snap:${r.id}`,
      kind: "snapshot",
      at: r.created_at,
      actor: {
        userId: r.user_id ?? null,
        username: r.username ?? "(removed user)",
      },
      title: `${restored ? "restored" : "created"} snapshot${name ? ` "${name}"` : ""}`,
      navigable: false,
    });
  }

  // 5. Comment lifecycle (M61-A) — created / replied / resolved.
  out.push(
    ...queryCommentTimeline(db, projectId, {
      limit,
      before: opts.before,
      since,
    }),
  );

  out.sort(cmp);
  const filtered = out.filter(beforePred(cur));
  const page = filtered.slice(0, limit);
  const nextBefore =
    filtered.length > limit && page.length > 0
      ? encodeCursor(page[page.length - 1].at, page[page.length - 1].id)
      : null;
  return { events: page, nextBefore };
}

const MEANINGFUL_KINDS = new Set<TimelineEvent["kind"]>([
  "edit_burst",
  "callout",
  "run",
  "commit",
  "snapshot",
  "comment",
]);

export function queryWhileAway(
  db: Db,
  projectId: string,
  callerUserId: number,
  since: string,
  maxEvents: number,
): { since: string; events: TimelineEvent[] } {
  const { events } = queryTimeline(db, projectId, {
    limit: Math.min(Math.max(1, maxEvents), MAX_PAGE),
    since,
  });
  return {
    since,
    events: events.filter(
      (e) => e.actor.userId !== callerUserId && MEANINGFUL_KINDS.has(e.kind),
    ),
  };
}
