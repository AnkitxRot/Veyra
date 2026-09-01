// M60: CollaborationHistorian — derived, metadata-only collaboration history.
//
// Pattern mirrors execution/historian.ts (TelemetryHistorian): a bounded
// in-memory accumulator feeds a bounded write queue that is flushed to SQLite
// in one batched transaction on an interval / at a size threshold / on
// shutdown. NOTHING here does synchronous I/O on the Yjs `afterTransaction`
// hot path — `recordEdit` only mutates in-memory state.
//
// Spec: docs/superpowers/specs/2026-08-31-m60-change-attribution-history-design.md §6.

import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import {
  burstKey,
  openBurst,
  extendBurst,
  shouldCloseForNextEdit,
  isStale,
  markContaminated,
  closeBurst,
  type EditInput,
  type OpenBurst,
  type ClosedBurst,
  type CloseReason,
} from "./changeAttribution.js";

/** The shape broadcast over MESSAGE_CUSTOM `collab_change` and echoed by REST. */
export interface CollabChangeWire {
  id: string;
  kind: "edit_burst" | "callout";
  at: string;
  actor: { userId: number; username: string };
  filePath: string;
  lineRange: { startLine: number; endLine: number } | null;
  updateCount: number;
  linesAdded: number;
  linesRemoved: number;
  calloutPreview?: string;
}

interface StoredRow {
  id: string;
  project_id: string;
  author_user_id: number;
  username: string; // carried for the wire event; NOT a stored column
  file_path: string;
  kind: "edit_burst" | "callout";
  started_at: string;
  ended_at: string;
  update_count: number;
  lines_added: number;
  lines_removed: number;
  start_line: number | null;
  end_line: number | null;
  detail: string | null;
}

export class CollaborationHistorian {
  private static instance: CollaborationHistorian;

  private db: Db | null = null;
  private cfg: AppConfig | null = null;

  private open = new Map<string, OpenBurst>();
  private queue: StoredRow[] = [];
  private touchedProjects = new Set<string>();

  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;

  private broadcaster:
    | ((projectId: string, ev: CollabChangeWire) => void)
    | null = null;

  static getInstance(): CollaborationHistorian {
    if (!CollaborationHistorian.instance) {
      CollaborationHistorian.instance = new CollaborationHistorian();
    }
    return CollaborationHistorian.instance;
  }

  init(db: Db, cfg: AppConfig): void {
    // Idempotent: createApp() runs once per test API instance and re-inits the
    // singleton. Clear any prior timers so they cannot stack.
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.db = db;
    this.cfg = cfg;
    this.flushTimer = setInterval(
      () => this.flushQueue(),
      cfg.collabHistoryFlushIntervalMs,
    );
    this.flushTimer.unref?.();
    this.sweepTimer = setInterval(() => this.sweep(), cfg.collabBurstSweepMs);
    this.sweepTimer.unref?.();
    this.purgeTimer = setInterval(
      () => this.purgeExpired(),
      15 * 60 * 1000,
    );
    this.purgeTimer.unref?.();
  }

  setBroadcaster(
    fn: (projectId: string, ev: CollabChangeWire) => void,
  ): void {
    this.broadcaster = fn;
  }

  // --- attribution intake (called from the room's afterTransaction hook) -----

  recordEdit(input: EditInput): void {
    if (!this.cfg) return;
    const idle = this.cfg.collabBurstIdleMs;
    const max = this.cfg.collabBurstMaxMs;

    // Different-author contamination: close any OTHER author's open burst for
    // this same file+project, flagged contaminated so it persists file-level.
    for (const [k, b] of this.open) {
      if (
        b.projectId === input.projectId &&
        b.filePath === input.filePath &&
        b.authorUserId !== input.authorUserId
      ) {
        markContaminated(b);
        this.enqueueClose(closeBurst(b, "author_switch"));
        this.open.delete(k);
      }
    }

    const key = burstKey(
      input.projectId,
      input.authorUserId,
      input.filePath,
    );
    const existing = this.open.get(key);
    if (existing && !shouldCloseForNextEdit(existing, input.at, idle, max)) {
      extendBurst(existing, input);
    } else {
      if (existing) {
        this.enqueueClose(closeBurst(existing, "idle"));
        this.open.delete(key);
      }
      this.open.set(key, openBurst(input));
    }

    if (this.open.size > this.cfg.collabOpenBurstsMax) {
      this.forceCloseOldest(this.cfg.collabOpenBurstsMax);
    }
  }

  /** Mark every open burst for this file+project contaminated (external/disk mutation). */
  contaminateFile(projectId: string, filePath: string): void {
    for (const b of this.open.values()) {
      if (b.projectId === projectId && b.filePath === filePath) {
        markContaminated(b);
      }
    }
  }

  recordCallout(i: {
    projectId: string;
    authorUserId: number;
    username: string;
    filePath: string;
    startLine: number | null;
    endLine: number | null;
    messagePreview: string;
    targeted: boolean;
    at: number;
  }): void {
    const iso = new Date(i.at).toISOString();
    const row: StoredRow = {
      id: randomUUID(),
      project_id: i.projectId,
      author_user_id: i.authorUserId,
      username: i.username,
      file_path: i.filePath,
      kind: "callout",
      started_at: iso,
      ended_at: iso,
      update_count: 0,
      lines_added: 0,
      lines_removed: 0,
      start_line: i.startLine,
      end_line: i.endLine,
      // ALLOWLIST — only these two fields, ever.
      detail: JSON.stringify({
        messagePreview: String(i.messagePreview ?? "").slice(0, 120),
        targeted: !!i.targeted,
      }),
    };
    this.enqueue(row);
  }

  // --- lifecycle close triggers --------------------------------------------

  closeAuthorBursts(
    projectId: string,
    userId: number,
    reason: CloseReason,
  ): void {
    for (const [k, b] of this.open) {
      if (b.projectId === projectId && b.authorUserId === userId) {
        this.enqueueClose(closeBurst(b, reason));
        this.open.delete(k);
      }
    }
  }

  closeProjectBursts(projectId: string, reason: CloseReason): void {
    for (const [k, b] of this.open) {
      if (b.projectId === projectId) {
        this.enqueueClose(closeBurst(b, reason));
        this.open.delete(k);
      }
    }
  }

  disposeProject(projectId: string): void {
    this.closeProjectBursts(projectId, "dispose");
    this.flushQueue();
  }

  private forceCloseOldest(cap: number): void {
    const sorted = [...this.open.values()].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    for (const b of sorted) {
      if (this.open.size <= cap) break;
      this.enqueueClose(closeBurst(b, "cap"));
      this.open.delete(b.key);
    }
  }

  private sweep(): void {
    if (!this.cfg) return;
    const now = Date.now();
    const idle = this.cfg.collabBurstIdleMs;
    const max = this.cfg.collabBurstMaxMs;
    for (const [k, b] of this.open) {
      if (isStale(b, now, idle, max)) {
        const reason: CloseReason =
          now - b.startedAt > max ? "max_age" : "idle";
        this.enqueueClose(closeBurst(b, reason));
        this.open.delete(k);
      }
    }
  }

  // --- persistence --------------------------------------------------------

  private enqueueClose(c: ClosedBurst): void {
    const iso = (n: number) => new Date(n).toISOString();
    this.enqueue({
      id: randomUUID(),
      project_id: c.projectId,
      author_user_id: c.authorUserId,
      username: c.username,
      file_path: c.filePath,
      kind: "edit_burst",
      started_at: iso(c.startedAt),
      ended_at: iso(c.endedAt),
      update_count: c.updateCount,
      lines_added: c.linesAdded,
      lines_removed: c.linesRemoved,
      start_line: c.startLine,
      end_line: c.endLine,
      detail: null,
    });
  }

  private enqueue(row: StoredRow): void {
    this.queue.push(row);
    this.touchedProjects.add(row.project_id);
    this.emitWire(row);
    if (this.queue.length >= 100) this.flushQueue();
  }

  private emitWire(row: StoredRow): void {
    if (!this.broadcaster) return;
    const detail = row.detail ? safeParse(row.detail) : null;
    const ev: CollabChangeWire = {
      id: `collab:${row.id}`,
      kind: row.kind,
      at: row.ended_at,
      actor: { userId: row.author_user_id, username: row.username },
      filePath: row.file_path,
      lineRange:
        row.start_line != null && row.end_line != null
          ? { startLine: row.start_line, endLine: row.end_line }
          : null,
      updateCount: row.update_count,
      linesAdded: row.lines_added,
      linesRemoved: row.lines_removed,
      calloutPreview: detail?.messagePreview,
    };
    try {
      this.broadcaster(row.project_id, ev);
    } catch {
      // never throw into a collaboration room
    }
  }

  flushQueue(): void {
    if (!this.db || this.queue.length === 0) return;
    const rows = this.queue;
    this.queue = [];
    try {
      this.db.exec("BEGIN TRANSACTION;");
      const stmt = this.db.prepare(
        `INSERT INTO collaboration_changes
         (id,project_id,author_user_id,file_path,kind,started_at,ended_at,
          update_count,lines_added,lines_removed,start_line,end_line,detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const r of rows) {
        stmt.run(
          r.id,
          r.project_id,
          r.author_user_id,
          r.file_path,
          r.kind,
          r.started_at,
          r.ended_at,
          r.update_count,
          r.lines_added,
          r.lines_removed,
          r.start_line,
          r.end_line,
          r.detail,
        );
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* original error is what matters */
      }
      console.error("[CollabHistorian] flush failed:", err);
    }
    this.enforceCaps();
  }

  private enforceCaps(): void {
    if (!this.db || !this.cfg) return;
    const cap = this.cfg.collabHistoryMaxPerProject;
    for (const pid of this.touchedProjects) {
      try {
        this.db
          .prepare(
            `DELETE FROM collaboration_changes
             WHERE project_id = ? AND id NOT IN (
               SELECT id FROM collaboration_changes WHERE project_id = ?
               ORDER BY ended_at DESC, id DESC LIMIT ?)`,
          )
          .run(pid, pid, cap);
      } catch (err) {
        console.warn("[CollabHistorian] cap enforcement warning:", err);
      }
    }
    this.touchedProjects.clear();
  }

  purgeExpired(): void {
    if (!this.db || !this.cfg) return;
    const days = Math.max(1, Math.floor(this.cfg.collabHistoryRetentionDays));
    try {
      this.db
        .prepare(
          `DELETE FROM collaboration_changes
           WHERE ended_at < datetime('now', '-${days} days')`,
        )
        .run();
    } catch (err) {
      console.warn("[CollabHistorian] purge warning:", err);
    }
    this.enforceCaps();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.flushTimer = this.sweepTimer = this.purgeTimer = null;
    for (const [k, b] of this.open) {
      this.enqueueClose(closeBurst(b, "shutdown"));
      this.open.delete(k);
    }
    this.flushQueue();
  }

  // --- test hooks -------------------------------------------------------

  _openBurstCount(): number {
    return this.open.size;
  }
  _queueLength(): number {
    return this.queue.length;
  }
}

function safeParse(s: string): { messagePreview?: string } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const collaborationHistorian = CollaborationHistorian.getInstance();
