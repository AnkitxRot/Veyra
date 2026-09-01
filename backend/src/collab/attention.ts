// backend/src/collab/attention.ts
//
// M58: transient ATTENTION layer. Pure domain logic only — no ws, no Y.Doc,
// no real clock. CollaborationRoom (manager.ts) owns transport, timers, and
// the authenticated session; this module owns validation, server-authoritative
// event construction, opaque IDs, rate limiting, and the bounded request
// registry policy.
//
// Keep the constants below in sync with frontend/src/collab/attention.ts.

import { randomBytes } from "node:crypto";
import { isAwarenessCoord, sanitizeAwarenessFilePath } from "./presence.js";

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

export interface AttentionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
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
    !isAwarenessCoord(startLine) ||
    !isAwarenessCoord(startColumn) ||
    !isAwarenessCoord(endLine) ||
    !isAwarenessCoord(endColumn)
  ) {
    return null;
  }
  if (!beforeOrEqual(startLine, startColumn, endLine, endColumn)) return null;
  return { startLine, startColumn, endLine, endColumn };
}

export function rangesOverlap(a: AttentionRange, b: AttentionRange): boolean {
  // No shared line at all.
  if (a.endLine < b.startLine || b.endLine < a.startLine) return false;
  // Any shared interior line (a full common line) means overlap regardless of
  // columns.
  const sharedStart = Math.max(a.startLine, b.startLine);
  const sharedEnd = Math.min(a.endLine, b.endLine);
  if (sharedEnd - sharedStart >= 1) return true;
  // Exactly one shared line. Reduce each range to its column interval ON that
  // line: if the range starts before this line it covers column 1..∞ up to its
  // own end; if it ends after this line it covers its own start..∞.
  const line = sharedStart; // === sharedEnd
  const aFrom = a.startLine < line ? 1 : a.startColumn;
  const aTo = a.endLine > line ? Number.POSITIVE_INFINITY : a.endColumn;
  const bFrom = b.startLine < line ? 1 : b.startColumn;
  const bTo = b.endLine > line ? Number.POSITIVE_INFINITY : b.endColumn;
  const zeroWidthA = aFrom === aTo;
  const zeroWidthB = bFrom === bTo;
  if (zeroWidthA && zeroWidthB) return aFrom === bFrom;
  if (zeroWidthA) return bFrom <= aFrom && aFrom < bTo;
  if (zeroWidthB) return aFrom <= bFrom && bFrom < aTo;
  // Two positive-width half-open intervals [from, to).
  return aFrom < bTo && bFrom < aTo;
}

// ---------------------------------------------------------------------------
// Task 2 — message sanitization + opaque id + input parsing
// ---------------------------------------------------------------------------

function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

export function sanitizeAttentionMessage(v: unknown): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (let i = 0; i < v.length; i++) {
    out += isControlChar(v.charCodeAt(i)) ? " " : v[i];
  }
  const s = out.replace(/\s+/g, " ").trim();
  return s.length > ATTENTION_MAX_MESSAGE_LEN
    ? s.slice(0, ATTENTION_MAX_MESSAGE_LEN)
    : s;
}

export function newAttentionId(): string {
  return randomBytes(8).toString("hex");
}

export type AttentionKind = "point" | "callout" | "request";

export type AttentionInput =
  | { kind: "point"; file: string; range: AttentionRange }
  | { kind: "callout"; file: string; range: AttentionRange; message: string }
  | {
      kind: "request";
      targetUserId: number;
      file: string;
      range: AttentionRange;
      message: string;
    };

const WIRE_TO_KIND: Record<string, AttentionKind> = {
  attention_point: "point",
  attention_callout: "callout",
  attention_request: "request",
};

export function parseAttentionInput(raw: unknown): AttentionInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.type === "string" ? WIRE_TO_KIND[r.type] : undefined;
  if (!kind) return null;

  const file = sanitizeAwarenessFilePath(r.file);
  if (typeof file !== "string") return null;

  const range = normalizeRange(r.range);
  if (!range) return null;

  if (kind === "point") return { kind, file, range };

  const message = sanitizeAttentionMessage(r.message);
  if (!message) return null;

  if (kind === "callout") return { kind, file, range, message };

  if (!Number.isInteger(r.targetUserId)) return null;
  return { kind, targetUserId: r.targetUserId as number, file, range, message };
}

// ---------------------------------------------------------------------------
// Task 3 — server-authoritative event construction
// ---------------------------------------------------------------------------

export interface AttentionAuthor {
  userId: number;
  username: string;
  color: string;
}

export interface AttentionEvent {
  type: "attention_event";
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

export interface AttentionClearedMsg {
  type: "attention_cleared";
  id: string;
  reason: AttentionClearedReason;
}

const TTL_BY_KIND: Record<AttentionKind, number> = {
  point: ATTENTION_POINT_TTL_MS,
  callout: ATTENTION_CALLOUT_MAX_TTL_MS,
  request: ATTENTION_REQUEST_TTL_MS,
};

export function buildAttentionEvent(
  input: AttentionInput,
  author: AttentionAuthor,
  now: number,
): AttentionEvent {
  const event: AttentionEvent = {
    type: "attention_event",
    id: newAttentionId(),
    kind: input.kind,
    author: {
      userId: author.userId,
      username: author.username,
      color: author.color,
    },
    file: input.file,
    range: input.range,
    createdAt: now,
    expiresAt: now + TTL_BY_KIND[input.kind],
  };
  if (input.kind === "callout" || input.kind === "request") {
    event.message = input.message;
  }
  if (input.kind === "request") {
    event.targetUserId = input.targetUserId;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Task 4 — bounded rate limiter (sliding window)
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly hits: number[] = [];
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  tryConsume(now: number): boolean {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Task 5 — bounded request registry (policy only, no timers, no clock)
// ---------------------------------------------------------------------------

interface RegistryAddOk {
  ok: true;
  evicted: AttentionEvent | null;
}
interface RegistryAddFail {
  ok: false;
  reason: "author_limit";
}

export class AttentionRequestRegistry {
  private readonly byId = new Map<string, AttentionEvent>();
  private readonly maxPerAuthor: number;
  private readonly maxEntries: number;

  constructor(opts: { maxPerAuthor?: number; maxEntries?: number } = {}) {
    this.maxPerAuthor = opts.maxPerAuthor ?? ATTENTION_MAX_OUTSTANDING_REQUESTS;
    this.maxEntries = opts.maxEntries ?? ATTENTION_MAX_REGISTRY_ENTRIES;
  }

  private countByAuthor(userId: number): number {
    let n = 0;
    for (const e of this.byId.values()) {
      if (e.author.userId === userId) n++;
    }
    return n;
  }

  tryAdd(event: AttentionEvent): RegistryAddOk | RegistryAddFail {
    if (this.countByAuthor(event.author.userId) >= this.maxPerAuthor) {
      return { ok: false, reason: "author_limit" };
    }
    let evicted: AttentionEvent | null = null;
    if (this.byId.size >= this.maxEntries) {
      let oldest: AttentionEvent | null = null;
      for (const e of this.byId.values()) {
        if (!oldest || e.createdAt < oldest.createdAt) oldest = e;
      }
      if (oldest) {
        this.byId.delete(oldest.id);
        evicted = oldest;
      }
    }
    this.byId.set(event.id, event);
    return { ok: true, evicted };
  }

  get(id: string): AttentionEvent | undefined {
    return this.byId.get(id);
  }

  delete(id: string): AttentionEvent | undefined {
    const e = this.byId.get(id);
    if (e) this.byId.delete(id);
    return e;
  }

  byTarget(userId: number): AttentionEvent[] {
    const out: AttentionEvent[] = [];
    for (const e of this.byId.values()) {
      if (e.targetUserId === userId) out.push(e);
    }
    return out;
  }

  deleteByAuthor(userId: number): AttentionEvent[] {
    const removed: AttentionEvent[] = [];
    for (const e of [...this.byId.values()]) {
      if (e.author.userId === userId) {
        this.byId.delete(e.id);
        removed.push(e);
      }
    }
    return removed;
  }

  deleteByTarget(userId: number): AttentionEvent[] {
    const removed: AttentionEvent[] = [];
    for (const e of [...this.byId.values()]) {
      if (e.targetUserId === userId) {
        this.byId.delete(e.id);
        removed.push(e);
      }
    }
    return removed;
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }
}

// ---------------------------------------------------------------------------
// Used by CollaborationRoom to stamp an author colour before the author has
// published awareness. Same 8-colour Catppuccin palette as
// frontend/src/collab/presence.ts:getUserColor.
// ---------------------------------------------------------------------------

const USER_COLORS = [
  "#89b4fa",
  "#a6e3a1",
  "#fab387",
  "#f38ba8",
  "#cba6f7",
  "#f9e2af",
  "#94e2d5",
  "#f5c2e7",
];

export function fallbackUserColor(userId: number): string {
  return USER_COLORS[Math.abs(userId) % USER_COLORS.length];
}
