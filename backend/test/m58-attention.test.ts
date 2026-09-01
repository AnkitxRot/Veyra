import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebSocket } from "ws";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
} from "../src/collab/manager.js";
import {
  normalizeRange,
  rangesOverlap,
  sanitizeAttentionMessage,
  newAttentionId,
  parseAttentionInput,
  buildAttentionEvent,
  RateLimiter,
  AttentionRequestRegistry,
  fallbackUserColor,
  ATTENTION_POINT_TTL_MS,
  ATTENTION_CALLOUT_MAX_TTL_MS,
  ATTENTION_REQUEST_TTL_MS,
} from "../src/collab/attention.js";

/**
 * M58 — transient ATTENTION layer. Pure-domain tests plus real-CollaborationRoom
 * pipeline tests: author forcing, targeting, validation, rate limiting, registry
 * bounds, expiry, dismissal, disconnect cleanup, reconnect snapshot, project
 * isolation, no-persistence, and a Yjs-convergence regression guard.
 */

const R = (sl: number, sc: number, el: number, ec: number) => ({
  startLine: sl,
  startColumn: sc,
  endLine: el,
  endColumn: ec,
});

// ---------------------------------------------------------------------------
// Task 1 — range normalization + overlap
// ---------------------------------------------------------------------------

describe("M58 — normalizeRange", () => {
  it("passes an ordered range through unchanged", () => {
    expect(normalizeRange(R(40, 1, 52, 1))).toEqual(R(40, 1, 52, 1));
  });
  it("accepts a zero-width cursor range", () => {
    expect(normalizeRange(R(10, 5, 10, 5))).toEqual(R(10, 5, 10, 5));
  });
  it("rejects a reversed range (does not swap)", () => {
    expect(normalizeRange(R(52, 1, 40, 1))).toBeNull();
    expect(normalizeRange(R(10, 9, 10, 3))).toBeNull();
  });
  it("rejects non-finite / negative / out-of-range coords", () => {
    expect(normalizeRange(R(NaN, 1, 2, 1))).toBeNull();
    expect(normalizeRange(R(1, 1, Infinity, 1))).toBeNull();
    expect(normalizeRange(R(-1, 1, 2, 1))).toBeNull();
    expect(normalizeRange(R(1, 1, 9_000_000, 1))).toBeNull();
  });
  it("rejects a non-object / missing keys", () => {
    expect(normalizeRange(null)).toBeNull();
    expect(normalizeRange({ startLine: 1 })).toBeNull();
    expect(normalizeRange("x")).toBeNull();
  });
});

describe("M58 — rangesOverlap", () => {
  it("different, non-touching line spans do not overlap", () => {
    expect(rangesOverlap(R(40, 1, 50, 1), R(100, 1, 120, 1))).toBe(false);
  });
  it("shared interior lines overlap", () => {
    expect(rangesOverlap(R(40, 1, 50, 1), R(45, 1, 60, 1))).toBe(true);
  });
  it("same single line, overlapping columns overlap", () => {
    expect(rangesOverlap(R(5, 2, 5, 10), R(5, 8, 5, 20))).toBe(true);
  });
  it("same single line, touching columns do NOT overlap", () => {
    expect(rangesOverlap(R(5, 2, 5, 10), R(5, 10, 5, 20))).toBe(false);
  });
  it("same single line, disjoint columns do not overlap", () => {
    expect(rangesOverlap(R(5, 2, 5, 6), R(5, 12, 5, 20))).toBe(false);
  });
  it("identical ranges overlap", () => {
    expect(rangesOverlap(R(40, 1, 52, 1), R(40, 1, 52, 1))).toBe(true);
  });
  it("zero-width cursor inside a range overlaps", () => {
    expect(rangesOverlap(R(5, 5, 5, 5), R(5, 2, 5, 10))).toBe(true);
  });
  it("zero-width cursor at the exclusive end does not overlap", () => {
    expect(rangesOverlap(R(5, 10, 5, 10), R(5, 2, 5, 10))).toBe(false);
  });
  it("two identical zero-width cursors overlap", () => {
    expect(rangesOverlap(R(5, 5, 5, 5), R(5, 5, 5, 5))).toBe(true);
  });
  it("multi-line ranges that share only the boundary line overlap when columns allow", () => {
    expect(rangesOverlap(R(1, 1, 10, 5), R(10, 3, 20, 1))).toBe(true);
    expect(rangesOverlap(R(1, 1, 10, 3), R(10, 3, 20, 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — message sanitization + opaque id + input parsing
// ---------------------------------------------------------------------------

describe("M58 — sanitizeAttentionMessage", () => {
  it("trims, collapses whitespace, strips control chars", () => {
    expect(sanitizeAttentionMessage("  the\n\trace is here  ")).toBe(
      "the race is here",
    );
  });
  it("caps at 280 chars", () => {
    expect(sanitizeAttentionMessage("x".repeat(500))).toHaveLength(280);
  });
  it("returns empty for non-strings and whitespace-only", () => {
    expect(sanitizeAttentionMessage(42)).toBe("");
    expect(sanitizeAttentionMessage(null)).toBe("");
    expect(sanitizeAttentionMessage("   \n\t ")).toBe("");
  });
});

describe("M58 — newAttentionId", () => {
  it("is 16 lowercase hex chars", () => {
    expect(newAttentionId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it("does not collide across 5000 calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newAttentionId());
    expect(seen.size).toBe(5000);
  });
});

describe("M58 — parseAttentionInput", () => {
  const range = { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 };
  it("parses a valid point", () => {
    expect(
      parseAttentionInput({ type: "attention_point", file: "a/b.ts", range }),
    ).toEqual({ kind: "point", file: "a/b.ts", range });
  });
  it("parses a valid callout and cleans the message", () => {
    expect(
      parseAttentionInput({
        type: "attention_callout",
        file: "a/b.ts",
        range,
        message: "  race\nhere ",
      }),
    ).toEqual({ kind: "callout", file: "a/b.ts", range, message: "race here" });
  });
  it("parses a valid request", () => {
    expect(
      parseAttentionInput({
        type: "attention_request",
        targetUserId: 12,
        file: "a/b.ts",
        range,
        message: "look",
      }),
    ).toEqual({
      kind: "request",
      targetUserId: 12,
      file: "a/b.ts",
      range,
      message: "look",
    });
  });
  it("rejects an unknown type", () => {
    expect(
      parseAttentionInput({ type: "attention_zzz", file: "a", range }),
    ).toBeNull();
  });
  it("rejects a traversal / absolute file path", () => {
    expect(
      parseAttentionInput({ type: "attention_point", file: "../etc", range }),
    ).toBeNull();
    expect(
      parseAttentionInput({
        type: "attention_point",
        file: "/etc/passwd",
        range,
      }),
    ).toBeNull();
  });
  it("rejects a reversed range", () => {
    expect(
      parseAttentionInput({
        type: "attention_point",
        file: "a",
        range: { startLine: 9, startColumn: 1, endLine: 2, endColumn: 1 },
      }),
    ).toBeNull();
  });
  it("rejects a callout with an empty-after-clean message", () => {
    expect(
      parseAttentionInput({
        type: "attention_callout",
        file: "a",
        range,
        message: "  \n ",
      }),
    ).toBeNull();
  });
  it("rejects a request with a non-integer targetUserId", () => {
    expect(
      parseAttentionInput({
        type: "attention_request",
        targetUserId: "12",
        file: "a",
        range,
        message: "x",
      }),
    ).toBeNull();
  });
  it("never throws on garbage", () => {
    expect(parseAttentionInput(null)).toBeNull();
    expect(parseAttentionInput(42)).toBeNull();
    expect(parseAttentionInput({ type: "attention_point" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3 — server-authoritative event construction
// ---------------------------------------------------------------------------

describe("M58 — buildAttentionEvent", () => {
  const author = { userId: 7, username: "rahul", color: "#89b4fa" };
  const rng = { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 };

  it("builds a point event with the point TTL and no message/target", () => {
    const e = buildAttentionEvent(
      { kind: "point", file: "a.ts", range: rng },
      author,
      1000,
    );
    expect(e).toMatchObject({
      type: "attention_event",
      kind: "point",
      author,
      file: "a.ts",
      range: rng,
      createdAt: 1000,
      expiresAt: 1000 + ATTENTION_POINT_TTL_MS,
    });
    expect(e.message).toBeUndefined();
    expect(e.targetUserId).toBeUndefined();
    expect(e.id).toMatch(/^[0-9a-f]{16}$/);
  });
  it("builds a callout with the HARD ceiling TTL", () => {
    const e = buildAttentionEvent(
      { kind: "callout", file: "a.ts", range: rng, message: "race" },
      author,
      1000,
    );
    expect(e.expiresAt).toBe(1000 + ATTENTION_CALLOUT_MAX_TTL_MS);
    expect(e.message).toBe("race");
  });
  it("builds a request with the request TTL and target", () => {
    const e = buildAttentionEvent(
      {
        kind: "request",
        targetUserId: 12,
        file: "a.ts",
        range: rng,
        message: "look",
      },
      author,
      1000,
    );
    expect(e.expiresAt).toBe(1000 + ATTENTION_REQUEST_TTL_MS);
    expect(e.targetUserId).toBe(12);
  });
  it("ignores any author-like field smuggled through input", () => {
    const dirty = {
      kind: "point",
      file: "a.ts",
      range: rng,
      author: { userId: 999 },
      id: "deadbeef",
    } as never;
    const e = buildAttentionEvent(dirty, author, 1000);
    expect(e.author).toEqual(author);
    expect(e.id).not.toBe("deadbeef");
  });
  it("two events built from the same input have different ids", () => {
    const mk = () =>
      buildAttentionEvent(
        { kind: "point", file: "a.ts", range: rng },
        author,
        1000,
      );
    expect(mk().id).not.toBe(mk().id);
  });
});

// ---------------------------------------------------------------------------
// Task 4 — RateLimiter
// ---------------------------------------------------------------------------

describe("M58 — RateLimiter", () => {
  it("allows up to `max` in a window then blocks", () => {
    const rl = new RateLimiter(10_000, 3);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(1)).toBe(true);
    expect(rl.tryConsume(2)).toBe(true);
    expect(rl.tryConsume(3)).toBe(false);
    expect(rl.tryConsume(9_999)).toBe(false);
  });
  it("refills as the window slides", () => {
    const rl = new RateLimiter(10_000, 2);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(5_000)).toBe(true);
    expect(rl.tryConsume(6_000)).toBe(false);
    expect(rl.tryConsume(10_001)).toBe(true);
  });
  it("a burst of 50 in one window yields exactly `max` accepts", () => {
    const rl = new RateLimiter(10_000, 10);
    let ok = 0;
    for (let i = 0; i < 50; i++) if (rl.tryConsume(i)) ok++;
    expect(ok).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Task 5 — AttentionRequestRegistry
// ---------------------------------------------------------------------------

describe("M58 — AttentionRequestRegistry", () => {
  const rng = { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 };
  const mkReq = (over: { author?: number; target?: number; at?: number }) =>
    buildAttentionEvent(
      {
        kind: "request",
        targetUserId: over.target ?? 2,
        file: "a.ts",
        range: rng,
        message: "x",
      },
      { userId: over.author ?? 1, username: "u", color: "#111" },
      over.at ?? 0,
    );

  it("adds and looks up by id and by target", () => {
    const reg = new AttentionRequestRegistry();
    const e = mkReq({ author: 1, target: 2 });
    expect(reg.tryAdd(e)).toEqual({ ok: true, evicted: null });
    expect(reg.get(e.id)).toBe(e);
    expect(reg.byTarget(2).map((x) => x.id)).toEqual([e.id]);
    expect(reg.byTarget(9)).toEqual([]);
  });
  it("enforces the per-author outstanding cap (drop the new one)", () => {
    const reg = new AttentionRequestRegistry({ maxPerAuthor: 3 });
    for (let i = 0; i < 3; i++) {
      expect(reg.tryAdd(mkReq({ author: 1, at: i })).ok).toBe(true);
    }
    expect(reg.tryAdd(mkReq({ author: 1, at: 4 }))).toEqual({
      ok: false,
      reason: "author_limit",
    });
    expect(reg.size).toBe(3);
    expect(reg.tryAdd(mkReq({ author: 5, at: 5 })).ok).toBe(true);
  });
  it("frees an author slot on delete", () => {
    const reg = new AttentionRequestRegistry({ maxPerAuthor: 1 });
    const e = mkReq({ author: 1, at: 0 });
    reg.tryAdd(e);
    expect(reg.tryAdd(mkReq({ author: 1, at: 1 })).ok).toBe(false);
    reg.delete(e.id);
    expect(reg.tryAdd(mkReq({ author: 1, at: 2 })).ok).toBe(true);
  });
  it("evicts the oldest when the room cap is hit", () => {
    const reg = new AttentionRequestRegistry({
      maxPerAuthor: 99,
      maxEntries: 2,
    });
    const a = mkReq({ author: 1, at: 10 });
    const b = mkReq({ author: 2, at: 20 });
    reg.tryAdd(a);
    reg.tryAdd(b);
    const res = reg.tryAdd(mkReq({ author: 3, at: 30 }));
    expect(res).toEqual({ ok: true, evicted: a });
    expect(reg.get(a.id)).toBeUndefined();
    expect(reg.size).toBe(2);
  });
  it("deleteByAuthor / deleteByTarget return and remove matches", () => {
    const reg = new AttentionRequestRegistry();
    const a = mkReq({ author: 1, target: 2, at: 1 });
    const b = mkReq({ author: 1, target: 3, at: 2 });
    const c = mkReq({ author: 4, target: 2, at: 3 });
    [a, b, c].forEach((e) => reg.tryAdd(e));
    expect(
      reg
        .deleteByAuthor(1)
        .map((e) => e.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(reg.size).toBe(1);
    expect(reg.deleteByTarget(2).map((e) => e.id)).toEqual([c.id]);
    expect(reg.size).toBe(0);
  });
});

describe("M58 — fallbackUserColor", () => {
  it("is deterministic and in-palette", () => {
    expect(fallbackUserColor(5)).toBe(fallbackUserColor(5));
    expect(fallbackUserColor(5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — real CollaborationRoom pipeline
// ---------------------------------------------------------------------------

const MESSAGE_CUSTOM = 3;
const MESSAGE_SYNC = 0;

function customFrame(obj: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_CUSTOM);
  encoding.writeVarString(enc, JSON.stringify(obj));
  return encoding.toUint8Array(enc);
}

function makeWs() {
  const sent: Uint8Array[] = [];
  return {
    readyState: 1,
    send: (d: Uint8Array) => sent.push(d),
    close: () => {},
    sent,
    // Cast through `unknown` to the `ws` WebSocket the room API expects; the
    // extra `sent` field stays reachable for the assertion helpers below.
  } as unknown as WebSocket & { sent: Uint8Array[] };
}

function customMessages(ws: { sent: Uint8Array[] }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const buf of ws.sent) {
    try {
      const dec = decoding.createDecoder(buf);
      if (decoding.readVarUint(dec) !== MESSAGE_CUSTOM) continue;
      out.push(JSON.parse(decoding.readVarString(dec)));
    } catch {}
  }
  return out;
}

function attnEvents(ws: { sent: Uint8Array[] }): Record<string, unknown>[] {
  return customMessages(ws).filter((m) => m.type === "attention_event");
}
function attnCleared(ws: { sent: Uint8Array[] }): Record<string, unknown>[] {
  return customMessages(ws).filter((m) => m.type === "attention_cleared");
}

const RNG = { startLine: 40, startColumn: 1, endLine: 52, endColumn: 1 };
const CUR = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };

describe("M58 — attention through the real room pipeline", () => {
  let db: ReturnType<typeof openDb>;
  let cfg: ReturnType<typeof resolveConfig>;
  let tmp: string;
  const rooms: CollaborationRoom[] = [];

  const makeRoom = (projectId: string) => {
    const r = new CollaborationRoom(projectId, cfg, db, () => {});
    rooms.push(r);
    return r;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m58-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp } as never;
    collaborationManager.init(cfg, db);
  });

  afterEach(() => {
    for (const r of rooms.splice(0)) {
      try {
        r.dispose();
      } catch {}
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // --- Task 6: point + callout broadcast --------------------------------

  it("broadcasts a valid point to peers but not the author", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_point",
        file: "auth/session.ts",
        range: { startLine: 47, startColumn: 1, endLine: 47, endColumn: 1 },
      }),
    );

    const toB = attnEvents(wsB);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({
      kind: "point",
      file: "auth/session.ts",
      author: { userId: 1, username: "alice" },
    });
    expect(toB[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(attnEvents(wsA)).toHaveLength(0);
  });

  it("broadcasts a callout with a cleaned message and the 90s ceiling", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const t0 = Date.now();
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_callout",
        file: "a.ts",
        range: RNG,
        message: "  the\n\trace is here  ",
      }),
    );
    const ev = attnEvents(wsB)[0];
    expect(ev.message).toBe("the race is here");
    expect((ev.expiresAt as number) - (ev.createdAt as number)).toBe(90_000);
    expect(ev.createdAt as number).toBeGreaterThanOrEqual(t0);
  });

  it("forces author identity — a spoofed author/userId/id in the payload is ignored", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_point",
        file: "a.ts",
        author: { userId: 999, username: "eve" },
        userId: 999,
        id: "cafebabecafebabe",
        range: CUR,
      }),
    );
    const ev = attnEvents(wsB)[0];
    expect(ev.author).toEqual({
      userId: 1,
      username: "alice",
      color: expect.any(String),
    });
    expect(ev.id).not.toBe("cafebabecafebabe");
  });

  it("drops malformed attention frames without throwing or broadcasting", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const before = room.doc.share.size;
    expect(() => {
      room.handleMessage(
        wsA,
        customFrame({ type: "attention_point", file: "../etc", range: {} }),
      );
      room.handleMessage(
        wsA,
        customFrame({
          type: "attention_callout",
          file: "a.ts",
          range: CUR,
          message: "   ",
        }),
      );
      room.handleMessage(wsA, customFrame({ type: "attention_zzz" }));
    }).not.toThrow();
    expect(attnEvents(wsB)).toHaveLength(0);
    expect(room.doc.share.size).toBe(before);
  });

  it("rate-limits at 10 events / 10s per connection (burst of 50 → 10)", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    for (let i = 0; i < 50; i++) {
      room.handleMessage(
        wsA,
        customFrame({ type: "attention_point", file: "a.ts", range: CUR }),
      );
    }
    expect(attnEvents(wsB)).toHaveLength(10);
  });

  // --- Task 7: targeted request ----------------------------------------

  it("delivers a request to the target and echoes it to the author", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    const wsC = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    await room.addClient(wsC, { userId: 3, username: "cara", role: "editor" });

    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "auth/session.ts",
        range: RNG,
        message: "I think the race is here.",
      }),
    );

    const toB = attnEvents(wsB);
    const toA = attnEvents(wsA);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({
      kind: "request",
      targetUserId: 2,
      message: "I think the race is here.",
    });
    expect(toA).toHaveLength(1);
    expect(toA[0].id).toBe(toB[0].id);
    expect(attnEvents(wsC)).toHaveLength(0);
  });

  it("drops a request to a non-member userId", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 4242,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    expect(attnEvents(wsB)).toHaveLength(0);
    expect(attnEvents(wsA)).toHaveLength(0);
  });

  it("drops a self-targeted request", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 1,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    expect(attnEvents(wsA)).toHaveLength(0);
  });

  it("rejects the 4th outstanding request from one author and tells only the author", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const send = () =>
      room.handleMessage(
        wsA,
        customFrame({
          type: "attention_request",
          targetUserId: 2,
          file: "a.ts",
          range: CUR,
          message: "x",
        }),
      );
    send();
    send();
    send();
    send();
    expect(attnEvents(wsB)).toHaveLength(3);
    const limited = customMessages(wsA).filter(
      (m) => m.type === "attention_rate_limited",
    );
    expect(limited).toHaveLength(1);
    expect(limited[0].scope).toBe("outstanding_requests");
  });

  // --- Task 8: dismiss / acted authorization + expiry -------------------

  it("lets the target dismiss its own request and notifies both sides", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    const id = attnEvents(wsB)[0].id as string;
    room.handleMessage(wsB, customFrame({ type: "attention_dismiss", id }));
    expect(attnCleared(wsB).at(-1)).toMatchObject({ id, reason: "dismissed" });
    expect(attnCleared(wsA).at(-1)).toMatchObject({ id, reason: "dismissed" });
    expect(room.hasAttentionRequest(id)).toBe(false);
  });

  it("marks reason 'acted' when acted:true", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    const id = attnEvents(wsB)[0].id as string;
    room.handleMessage(
      wsB,
      customFrame({ type: "attention_dismiss", id, acted: true }),
    );
    expect(attnCleared(wsB).at(-1)!.reason).toBe("acted");
  });

  it("ignores a dismiss from a non-target or with a wrong id (no id-guessing)", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    const wsC = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    await room.addClient(wsC, { userId: 3, username: "cara", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    const id = attnEvents(wsB)[0].id as string;
    room.handleMessage(wsC, customFrame({ type: "attention_dismiss", id }));
    room.handleMessage(wsA, customFrame({ type: "attention_dismiss", id }));
    room.handleMessage(
      wsB,
      customFrame({ type: "attention_dismiss", id: "0000000000000000" }),
    );
    expect(room.hasAttentionRequest(id)).toBe(true);
  });

  it("expires a request after the request TTL and never re-delivers", async () => {
    vi.useFakeTimers();
    try {
      const room = makeRoom("p1");
      const wsA = makeWs();
      const wsB = makeWs();
      await room.addClient(wsA, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
      room.handleMessage(
        wsA,
        customFrame({
          type: "attention_request",
          targetUserId: 2,
          file: "a.ts",
          range: CUR,
          message: "x",
        }),
      );
      const id = attnEvents(wsB)[0].id as string;
      vi.advanceTimersByTime(120_000 - 1);
      expect(attnCleared(wsB)).toHaveLength(0);
      vi.advanceTimersByTime(2);
      expect(attnCleared(wsB).at(-1)).toMatchObject({ id, reason: "expired" });
      expect(room.hasAttentionRequest(id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Task 9: snapshot / disconnect / dispose / isolation --------------

  it("reconnecting target after a drop receives none (target-leave cleared it)", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "auth/session.ts",
        range: RNG,
        message: "look",
      }),
    );
    room.removeClient(wsB);
    const wsB2 = makeWs();
    await room.addClient(wsB2, { userId: 2, username: "bob", role: "editor" });
    expect(attnEvents(wsB2)).toHaveLength(0);
  });

  it("author disconnect withdraws the request (author_gone) and reconnect does not resurrect it", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    room.removeClient(wsA);
    expect(attnCleared(wsB).at(-1)).toMatchObject({ reason: "author_gone" });
    const wsA2 = makeWs();
    await room.addClient(wsA2, { userId: 1, username: "alice", role: "editor" });
    expect(attnEvents(wsB)).toHaveLength(1);
  });

  it("snapshots a still-valid request to a fresh connection of the same target (multi-tab / quick reconnect)", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "auth/session.ts",
        range: RNG,
        message: "look",
      }),
    );
    const id = attnEvents(wsB)[0].id as string;
    const wsB2 = makeWs();
    await room.addClient(wsB2, { userId: 2, username: "bob", role: "editor" });
    const snap = attnEvents(wsB2);
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe(id);
  });

  it("does not replay an expired request on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const room = makeRoom("p1");
      const wsA = makeWs();
      const wsB = makeWs();
      await room.addClient(wsA, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
      room.handleMessage(
        wsA,
        customFrame({
          type: "attention_request",
          targetUserId: 2,
          file: "a.ts",
          range: CUR,
          message: "x",
        }),
      );
      vi.advanceTimersByTime(120_001);
      const wsB2 = makeWs();
      await room.addClient(wsB2, { userId: 2, username: "bob", role: "editor" });
      expect(attnEvents(wsB2)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("project isolation — room B never sees room A's attention", async () => {
    const roomA = makeRoom("pA");
    const roomB = makeRoom("pB");
    const a1 = makeWs();
    const a2 = makeWs();
    const b1 = makeWs();
    await roomA.addClient(a1, { userId: 1, username: "alice", role: "editor" });
    await roomA.addClient(a2, { userId: 2, username: "bob", role: "editor" });
    await roomB.addClient(b1, { userId: 3, username: "cara", role: "editor" });
    roomA.handleMessage(
      a1,
      customFrame({ type: "attention_point", file: "a.ts", range: CUR }),
    );
    roomA.handleMessage(
      a1,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    expect(
      customMessages(b1).filter((m) => String(m.type).startsWith("attention_")),
    ).toHaveLength(0);
  });

  it("dispose clears all attention expiry timers and the registry", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    const id = attnEvents(wsB)[0].id as string;
    room.dispose();
    expect(room.hasAttentionRequest(id)).toBe(false);
  });

  it("no persistence — a full point/callout/request cycle writes no Y.Doc keys", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const before = room.doc.share.size;
    room.handleMessage(
      wsA,
      customFrame({ type: "attention_point", file: "a.ts", range: CUR }),
    );
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_callout",
        file: "a.ts",
        range: CUR,
        message: "hi",
      }),
    );
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "hi",
      }),
    );
    expect(room.doc.share.size).toBe(before);
  });

  it("concurrent Yjs edits still converge with attention frames interleaved", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const applyToRoom = (u: Uint8Array, from: Parameters<typeof room.handleMessage>[0]) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, u);
      room.handleMessage(from, encoding.toUint8Array(enc));
    };
    docA.getText("f.ts").insert(0, "AAAA");
    applyToRoom(Y.encodeStateAsUpdate(docA), wsA);
    room.handleMessage(
      wsA,
      customFrame({ type: "attention_point", file: "f.ts", range: CUR }),
    );
    docB.getText("f.ts").insert(0, "BB");
    applyToRoom(Y.encodeStateAsUpdate(docB), wsB);

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(room.doc));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(room.doc));
    expect(docA.getText("f.ts").toString()).toBe(
      room.doc.getText("f.ts").toString(),
    );
    expect(docB.getText("f.ts").toString()).toBe(
      room.doc.getText("f.ts").toString(),
    );
    expect(room.doc.getText("f.ts").toString()).toContain("AAAA");
    expect(room.doc.getText("f.ts").toString()).toContain("BB");
  });

  // --- Task 19 (consolidated security) --------------------------------

  it("a forged event id on create is ignored — server generates its own", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        id: "1111111111111111",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    const ev = attnEvents(wsB)[0];
    expect(ev.id).not.toBe("1111111111111111");
    expect(ev.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("caps an oversized message at 280 in the delivered event", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_callout",
        file: "a.ts",
        range: CUR,
        message: "x".repeat(100_000),
      }),
    );
    expect((attnEvents(wsB)[0].message as string).length).toBe(280);
  });

  it("strips control chars from the delivered message", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_callout",
        file: "a.ts",
        range: CUR,
        message: "a\u0000\u0007b\tc",
      }),
    );
    expect(attnEvents(wsB)[0].message).toBe("a b c");
  });

  it("rejects a variety of invalid file paths", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    for (const file of ["/etc/passwd", "..\\..\\x", "C:\\x", "a\u0000b"]) {
      room.handleMessage(
        wsA,
        customFrame({ type: "attention_point", file, range: CUR }),
      );
    }
    expect(attnEvents(wsB)).toHaveLength(0);
  });

  it("multi-tab: per-author outstanding cap bounds requests across a user's sockets", async () => {
    const room = makeRoom("p1");
    const wsA1 = makeWs();
    const wsA2 = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA1, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsA2, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const req = (ws: ReturnType<typeof makeWs>) =>
      room.handleMessage(
        ws,
        customFrame({
          type: "attention_request",
          targetUserId: 2,
          file: "a.ts",
          range: CUR,
          message: "x",
        }),
      );
    req(wsA1);
    req(wsA1);
    req(wsA1);
    req(wsA2); // 4th from the same user, different socket
    expect(attnEvents(wsB)).toHaveLength(3);
    expect(
      customMessages(wsA2).filter((m) => m.type === "attention_rate_limited"),
    ).toHaveLength(1);
  });

  it("no DB rows are created by any attention path", async () => {
    const room = makeRoom("p1");
    const wsA = makeWs();
    const wsB = makeWs();
    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });
    const tableNames = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    const countAll = () =>
      tableNames.map(
        (t) =>
          (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number })
            .c,
      );
    const before = countAll();
    room.handleMessage(
      wsA,
      customFrame({ type: "attention_point", file: "a.ts", range: CUR }),
    );
    room.handleMessage(
      wsA,
      customFrame({
        type: "attention_request",
        targetUserId: 2,
        file: "a.ts",
        range: CUR,
        message: "x",
      }),
    );
    expect(countAll()).toEqual(before);
  });
});
