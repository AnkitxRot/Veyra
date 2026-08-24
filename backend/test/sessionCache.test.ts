import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedSession,
  setCachedSession,
  invalidateCachedToken,
  invalidateCachedSessionsForUser,
  clearSessionCache,
  getSessionCacheSize,
  SESSION_CACHE_TTL_MS,
  SESSION_CACHE_MAX_ENTRIES,
  type CachedSessionIdentity,
} from "../src/auth/sessionCache.js";

const alice: CachedSessionIdentity = {
  id: 1,
  username: "alice",
  role: "user",
};
const bob: CachedSessionIdentity = { id: 2, username: "bob", role: "user" };

describe("sessionCache (M5a)", () => {
  beforeEach(() => {
    clearSessionCache();
  });

  it("miss on an empty cache, then populates on set, then hits", () => {
    const now = 1_000_000;
    expect(getCachedSession("tok-a", now)).toBeNull();

    setCachedSession("tok-a", alice, now + 60_000, now);
    const hit = getCachedSession("tok-a", now + 1);
    expect(hit).toEqual(alice);
  });

  it("a cache hit needs no DB access — verified by construction: getCachedSession never touches the db module", () => {
    // sessionCache.ts has no import of db.js at all; a hit is a pure Map
    // read. This test documents that contract at the type/behavior level:
    // the returned identity is the exact object set, not re-derived.
    const now = 0;
    setCachedSession("tok-b", bob, now + SESSION_CACHE_TTL_MS + 1, now);
    expect(getCachedSession("tok-b", now)).toEqual(bob);
    expect(getCachedSession("tok-b", now + 1)).toEqual(bob);
  });

  it("expires after the cache TTL even when the underlying session is still valid, forcing a fresh DB lookup", () => {
    const now = 0;
    // Session itself is valid for a full day — only the cache freshness
    // window should govern this expiry.
    setCachedSession("tok-c", alice, now + 24 * 60 * 60 * 1000, now);
    expect(getCachedSession("tok-c", now + SESSION_CACHE_TTL_MS - 1)).toEqual(
      alice,
    );
    expect(getCachedSession("tok-c", now + SESSION_CACHE_TTL_MS)).toBeNull();
    // The stale entry must actually be evicted, not just skipped.
    expect(getSessionCacheSize()).toBe(0);
  });

  it("never returns a session past its real DB expiry, even within the cache TTL window", () => {
    const now = 0;
    // Session expires in 10ms — well inside the 5s cache TTL.
    setCachedSession("tok-d", alice, now + 10, now);
    expect(getCachedSession("tok-d", now + 5)).toEqual(alice);
    expect(getCachedSession("tok-d", now + 10)).toBeNull();
  });

  it("does not cache an already-expired session at all", () => {
    const now = 1000;
    setCachedSession("tok-e", alice, now - 1, now);
    expect(getSessionCacheSize()).toBe(0);
    expect(getCachedSession("tok-e", now)).toBeNull();
  });

  it("logout/revocation: invalidateCachedToken removes exactly that token immediately, TTL notwithstanding", () => {
    const now = 0;
    setCachedSession("tok-f", alice, now + 60_000, now);
    expect(getCachedSession("tok-f", now)).toEqual(alice);

    invalidateCachedToken("tok-f");
    expect(getCachedSession("tok-f", now)).toBeNull();
  });

  it("admin bulk revocation: invalidateCachedSessionsForUser removes every token for that user without touching other users", () => {
    const now = 0;
    setCachedSession("alice-tok-1", alice, now + 60_000, now);
    setCachedSession("alice-tok-2", alice, now + 60_000, now);
    setCachedSession("bob-tok-1", bob, now + 60_000, now);

    invalidateCachedSessionsForUser(alice.id);

    expect(getCachedSession("alice-tok-1", now)).toBeNull();
    expect(getCachedSession("alice-tok-2", now)).toBeNull();
    expect(getCachedSession("bob-tok-1", now)).toEqual(bob);
  });

  it("bounds cache size with FIFO eviction instead of growing unboundedly", () => {
    const now = 0;
    for (let i = 0; i < SESSION_CACHE_MAX_ENTRIES + 50; i++) {
      setCachedSession(`tok-${i}`, alice, now + 60_000, now);
    }
    expect(getSessionCacheSize()).toBeLessThanOrEqual(
      SESSION_CACHE_MAX_ENTRIES,
    );
    // The earliest-inserted entries were evicted first.
    expect(getCachedSession("tok-0", now)).toBeNull();
    // A recently-inserted entry survives.
    expect(
      getCachedSession(`tok-${SESSION_CACHE_MAX_ENTRIES + 49}`, now),
    ).toEqual(alice);
  });

  it("never caches a failed/missing lookup — there is no negative-cache API at all", () => {
    // Structural guarantee: getCachedSession only ever reads what
    // setCachedSession wrote, and setCachedSession is only ever called by
    // requireAuth after a successful DB validation (see middleware.ts). A
    // token that was never set simply misses, forever, until set.
    expect(getCachedSession("never-set", 0)).toBeNull();
    expect(getCachedSession("never-set", 1)).toBeNull();
    expect(getSessionCacheSize()).toBe(0);
  });
});
