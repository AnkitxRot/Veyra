import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeRange,
  rangesOverlap,
  parseAttentionEvent,
  AttentionStore,
  ATTENTION_POINT_TTL_MS,
  ATTENTION_CALLOUT_TTL_MS,
  ATTENTION_CALLOUT_MAX_TTL_MS,
} from "../src/collab/attention";

const R = (sl: number, sc: number, el: number, ec: number) => ({
  startLine: sl,
  startColumn: sc,
  endLine: el,
  endColumn: ec,
});

describe("M58 client — constants match the backend", () => {
  it("pins the client TTLs", () => {
    expect(ATTENTION_POINT_TTL_MS).toBe(6_000);
    expect(ATTENTION_CALLOUT_TTL_MS).toBe(45_000);
    expect(ATTENTION_CALLOUT_MAX_TTL_MS).toBe(90_000);
  });
});

describe("M58 client — normalizeRange / rangesOverlap parity", () => {
  it("rejects reversed and non-finite", () => {
    expect(normalizeRange(R(9, 1, 2, 1))).toBeNull();
    expect(normalizeRange(R(1, 1, NaN, 1))).toBeNull();
  });
  it("accepts a zero-width cursor range", () => {
    expect(normalizeRange(R(10, 5, 10, 5))).toEqual(R(10, 5, 10, 5));
  });
  it("touching columns do not overlap; interior lines do", () => {
    expect(rangesOverlap(R(5, 2, 5, 10), R(5, 10, 5, 20))).toBe(false);
    expect(rangesOverlap(R(40, 1, 50, 1), R(45, 1, 60, 1))).toBe(true);
  });
  it("zero-width cursor inside overlaps; at exclusive end does not", () => {
    expect(rangesOverlap(R(5, 5, 5, 5), R(5, 2, 5, 10))).toBe(true);
    expect(rangesOverlap(R(5, 10, 5, 10), R(5, 2, 5, 10))).toBe(false);
  });
  it("identical ranges overlap; disjoint columns do not", () => {
    expect(rangesOverlap(R(40, 1, 52, 1), R(40, 1, 52, 1))).toBe(true);
    expect(rangesOverlap(R(5, 2, 5, 6), R(5, 12, 5, 20))).toBe(false);
  });
});

describe("M58 client — parseAttentionEvent", () => {
  const good = {
    type: "attention_event",
    id: "a1b2c3d4e5f60718",
    kind: "callout",
    author: { userId: 7, username: "rahul", color: "#89b4fa" },
    file: "auth/session.ts",
    range: R(40, 1, 52, 1),
    message: "race here",
    createdAt: 1000,
    expiresAt: 91000,
  };
  it("parses a valid event", () => {
    expect(parseAttentionEvent(good)?.id).toBe("a1b2c3d4e5f60718");
  });
  it("rejects a bad range / missing author / bad kind", () => {
    expect(parseAttentionEvent({ ...good, range: R(9, 1, 2, 1) })).toBeNull();
    expect(parseAttentionEvent({ ...good, author: null })).toBeNull();
    expect(parseAttentionEvent({ ...good, kind: "zzz" })).toBeNull();
  });
  it("never throws on garbage", () => {
    expect(parseAttentionEvent(null)).toBeNull();
    expect(parseAttentionEvent(42)).toBeNull();
  });
});

describe("M58 — AttentionStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ev = (over: Record<string, unknown> = {}) => ({
    type: "attention_event",
    id: (over.id as string) ?? Math.random().toString(16).slice(2),
    kind: (over.kind as string) ?? "point",
    author:
      (over.author as unknown) ?? {
        userId: 7,
        username: "rahul",
        color: "#89b4fa",
      },
    file: "a.ts",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: over.message,
    targetUserId: over.targetUserId,
    createdAt: (over.createdAt as number) ?? Date.now(),
    expiresAt: (over.expiresAt as number) ?? Date.now() + 9_999_999,
  });

  it("removes a point after the local TTL (6s)", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "point", id: "p1" }));
    expect(s.list()).toHaveLength(1);
    vi.advanceTimersByTime(5_999);
    expect(s.list()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(s.list()).toHaveLength(0);
  });

  it("removes a callout after 45s by default", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "callout", id: "c1", message: "x" }));
    vi.advanceTimersByTime(45_001);
    expect(s.list()).toHaveLength(0);
  });

  it("honours the server hard ceiling even if the client keeps touching it", () => {
    const s = new AttentionStore();
    const created = Date.now();
    s.apply(
      ev({
        kind: "callout",
        id: "c2",
        message: "x",
        createdAt: created,
        expiresAt: created + 90_000,
      }),
    );
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(40_000);
      s.touchCallout("c2");
    }
    expect(s.list()).toHaveLength(0);
  });

  it("a request has no local timer — it stays until cleared", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "request", id: "r1", message: "look", targetUserId: 12 }));
    vi.advanceTimersByTime(10 * 60_000);
    expect(s.list()).toHaveLength(1);
    s.apply({ type: "attention_cleared", id: "r1", reason: "dismissed" });
    expect(s.list()).toHaveLength(0);
  });

  it("dismissLocal removes immediately without the server", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "request", id: "r2", message: "x", targetUserId: 12 }));
    s.dismissLocal("r2");
    expect(s.list()).toHaveLength(0);
  });

  it("incomingRequestCount counts only requests targeted at me", () => {
    const s = new AttentionStore();
    s.apply(ev({ kind: "point", id: "p" }));
    s.apply(ev({ kind: "callout", id: "c", message: "x" }));
    s.apply(
      ev({
        kind: "request",
        id: "r-me",
        message: "x",
        targetUserId: 12,
        author: { userId: 7, username: "r", color: "#1" },
      }),
    );
    s.apply(
      ev({
        kind: "request",
        id: "r-other",
        message: "x",
        targetUserId: 99,
        author: { userId: 7, username: "r", color: "#1" },
      }),
    );
    expect(s.incomingRequestCount(12)).toBe(1);
  });

  it("clear() drops everything and fires change", () => {
    const s = new AttentionStore();
    const seen = vi.fn();
    s.onChange(seen);
    s.apply(ev({ kind: "point", id: "p" }));
    s.clear();
    expect(s.list()).toHaveLength(0);
    expect(seen).toHaveBeenCalled();
  });

  it("ignores a malformed attention_event", () => {
    const s = new AttentionStore();
    s.apply({ type: "attention_event", id: "bad", kind: "zzz" });
    expect(s.list()).toHaveLength(0);
  });
});
