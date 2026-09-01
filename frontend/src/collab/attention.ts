// M58: client-side transient ATTENTION model. Mirrors backend/src/collab/
// attention.ts — keep the constants and range logic in sync (the repo
// hand-syncs frontend/src/types.ts with backend types the same way).
//
// The client NEVER authors id/author/createdAt/expiresAt — those arrive
// server-stamped. This module renders and locally expires. A callout's local
// presentation life is always min(local TTL, expiresAt - now); the server's
// 90 s hard ceiling (baked into expiresAt) can never be exceeded.

export const ATTENTION_MAX_MESSAGE_LEN = 280;
export const ATTENTION_POINT_TTL_MS = 6_000;
export const ATTENTION_CALLOUT_TTL_MS = 45_000;
export const ATTENTION_CALLOUT_MAX_TTL_MS = 90_000;
export const ATTENTION_REQUEST_TTL_MS = 120_000;
export const ATTENTION_RATE_WINDOW_MS = 10_000;
export const ATTENTION_MAX_EVENTS_PER_WINDOW = 10;
export const ATTENTION_MAX_OUTSTANDING_REQUESTS = 3;
export const ATTENTION_MAX_REGISTRY_ENTRIES = 200;
export const RANGE_NEAR_LINES = 5;

export type AttentionKind = "point" | "callout" | "request";

export interface AttentionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface AttentionAuthor {
  userId: number;
  username: string;
  color: string;
}

export interface AttentionEvent {
  id: string;
  kind: AttentionKind;
  author: AttentionAuthor;
  file: string;
  range: AttentionRange;
  message?: string;
  targetUserId?: number;
  createdAt: number;
  expiresAt: number;
}

export type AttentionClearedReason =
  | "dismissed"
  | "expired"
  | "acted"
  | "author_gone";

// --- range helpers (byte-parity with the backend) --------------------------

function isCoord(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 5_000_000;
}

function beforeOrEqual(
  aL: number,
  aC: number,
  bL: number,
  bC: number,
): boolean {
  return aL < bL || (aL === bL && aC <= bC);
}

export function normalizeRange(v: unknown): AttentionRange | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const { startLine, startColumn, endLine, endColumn } = r;
  if (
    !isCoord(startLine) ||
    !isCoord(startColumn) ||
    !isCoord(endLine) ||
    !isCoord(endColumn)
  ) {
    return null;
  }
  if (!beforeOrEqual(startLine, startColumn, endLine, endColumn)) return null;
  return { startLine, startColumn, endLine, endColumn };
}

export function rangesOverlap(a: AttentionRange, b: AttentionRange): boolean {
  if (a.endLine < b.startLine || b.endLine < a.startLine) return false;
  const sharedStart = Math.max(a.startLine, b.startLine);
  const sharedEnd = Math.min(a.endLine, b.endLine);
  if (sharedEnd - sharedStart >= 1) return true;
  const line = sharedStart;
  const aFrom = a.startLine < line ? 1 : a.startColumn;
  const aTo = a.endLine > line ? Number.POSITIVE_INFINITY : a.endColumn;
  const bFrom = b.startLine < line ? 1 : b.startColumn;
  const bTo = b.endLine > line ? Number.POSITIVE_INFINITY : b.endColumn;
  const zeroWidthA = aFrom === aTo;
  const zeroWidthB = bFrom === bTo;
  if (zeroWidthA && zeroWidthB) return aFrom === bFrom;
  if (zeroWidthA) return bFrom <= aFrom && aFrom < bTo;
  if (zeroWidthB) return aFrom <= bFrom && bFrom < aTo;
  return aFrom < bTo && bFrom < aTo;
}

// --- inbound event parsing (client-side shape guard) -----------------------

const KINDS: ReadonlySet<string> = new Set(["point", "callout", "request"]);

export function parseAttentionEvent(raw: unknown): AttentionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;

  const a = r.author as Record<string, unknown> | undefined;
  if (
    !a ||
    typeof a !== "object" ||
    typeof a.userId !== "number" ||
    typeof a.username !== "string" ||
    typeof a.color !== "string"
  ) {
    return null;
  }

  if (typeof r.file !== "string" || !r.file) return null;
  const range = normalizeRange(r.range);
  if (!range) return null;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) {
    return null;
  }
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) {
    return null;
  }

  const event: AttentionEvent = {
    id: r.id,
    kind: r.kind as AttentionKind,
    author: {
      userId: a.userId,
      username: a.username,
      color: a.color,
    },
    file: r.file,
    range,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
  if (typeof r.message === "string") event.message = r.message;
  if (typeof r.targetUserId === "number") event.targetUserId = r.targetUserId;
  return event;
}

// --- AttentionStore -------------------------------------------------------

export type AttentionInboundMsg =
  | ({ type: "attention_event" } & Partial<AttentionEvent>)
  | { type: "attention_cleared"; id: string; reason: AttentionClearedReason };

const LOCAL_TTL: Record<AttentionKind, number | null> = {
  point: ATTENTION_POINT_TTL_MS,
  callout: ATTENTION_CALLOUT_TTL_MS,
  request: null,
};

/**
 * Holds the transient attention events currently visible to this client and
 * expires point/callout events locally. Requests have no local timer — they
 * live until the server sends `attention_cleared` or the user dismisses them.
 * Every timer is cleared on removal / clear() / dispose().
 */
export class AttentionStore {
  private readonly events = new Map<string, AttentionEvent>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fireAt = new Map<string, number>();
  private readonly subs = new Set<() => void>();

  apply(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "attention_cleared") {
      if (typeof m.id === "string") this.remove(m.id);
      return;
    }
    if (m.type !== "attention_event") return;
    const event = parseAttentionEvent(m);
    if (!event) return;
    this.events.set(event.id, event);
    this.scheduleLocalExpiry(event);
    this.emit();
  }

  private scheduleLocalExpiry(event: AttentionEvent): void {
    const existing = this.timers.get(event.id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(event.id);
      this.fireAt.delete(event.id);
    }
    const local = LOCAL_TTL[event.kind];
    if (local == null) return; // requests: server-driven only
    const now = Date.now();
    const fireInMs = Math.max(0, Math.min(local, event.expiresAt - now));
    const t = setTimeout(() => {
      this.timers.delete(event.id);
      this.fireAt.delete(event.id);
      if (this.events.delete(event.id)) this.emit();
    }, fireInMs);
    this.timers.set(event.id, t);
    this.fireAt.set(event.id, now + fireInMs);
  }

  /**
   * Callout only: extend the local presentation window (e.g. while the range
   * is on-screen), clamped to the server's expiresAt ceiling. Never shortens
   * an existing timer; never pushes past expiresAt.
   */
  touchCallout(id: string): void {
    const event = this.events.get(id);
    if (!event || event.kind !== "callout") return;
    const now = Date.now();
    const target = Math.min(now + ATTENTION_CALLOUT_TTL_MS, event.expiresAt);
    if (target <= now) {
      this.remove(id);
      return;
    }
    const currentFireAt = this.fireAt.get(id) ?? 0;
    if (target <= currentFireAt) return; // only ever extends
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.fireAt.delete(id);
      if (this.events.delete(id)) this.emit();
    }, target - now);
    this.timers.set(id, t);
    this.fireAt.set(id, target);
  }

  /** Remove immediately without waiting for the server (local "×" / optimistic). */
  dismissLocal(id: string): void {
    this.remove(id);
  }

  private remove(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.fireAt.delete(id);
    if (this.events.delete(id)) this.emit();
  }

  list(): AttentionEvent[] {
    return [...this.events.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  incomingRequestCount(currentUserId: number): number {
    let n = 0;
    for (const e of this.events.values()) {
      if (
        e.kind === "request" &&
        e.targetUserId === currentUserId &&
        e.author.userId !== currentUserId
      ) {
        n++;
      }
    }
    return n;
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) {
      try {
        cb();
      } catch {
        /* subscriber errors must not break the store */
      }
    }
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.fireAt.clear();
    this.events.clear();
    this.emit();
  }

  dispose(): void {
    this.clear();
    this.subs.clear();
  }
}
