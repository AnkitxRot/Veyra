// M5a: tiny TTL-bounded in-memory cache in front of the per-request session
// DB lookup in requireAuth(). Every authenticated request was doing one
// synchronous SQLite JOIN just to resolve who the caller is — this removes
// that DB round-trip on cache hits without weakening revocation semantics:
// entries are bounded by both a short freshness TTL (so any staleness window
// is small even if a revocation path is ever missed) and immediate,
// explicit invalidation from every known revocation path (logout, admin
// password-reset/user-delete bulk session revocation).
//
// Deliberately caches only successful, validated sessions. Failed/missing
// tokens are never cached (nothing to invalidate, nothing to go stale).

export interface CachedSessionIdentity {
  id: number;
  username: string;
  role: "user" | "admin";
}

interface CacheEntry {
  identity: CachedSessionIdentity;
  cachedAtMs: number;
  sessionExpiresAtMs: number;
}

export const SESSION_CACHE_TTL_MS = 5000;
export const SESSION_CACHE_MAX_ENTRIES = 5000;

const cache = new Map<string, CacheEntry>();

/**
 * Returns the cached identity for `hashedToken`, or null on a cache miss —
 * including when the entry has outlived either the cache's own freshness
 * TTL or the session's real DB expiry, whichever is sooner. A null return
 * means the caller must fall back to the authoritative DB lookup.
 */
export function getCachedSession(
  hashedToken: string,
  now: number = Date.now(),
): CachedSessionIdentity | null {
  const entry = cache.get(hashedToken);
  if (!entry) return null;
  const freshUntilMs = entry.cachedAtMs + SESSION_CACHE_TTL_MS;
  if (now >= freshUntilMs || now >= entry.sessionExpiresAtMs) {
    cache.delete(hashedToken);
    return null;
  }
  return entry.identity;
}

/**
 * Populates the cache after a real DB validation. Never caches a session
 * that is already expired. Bounded FIFO eviction (oldest insertion first —
 * Map iteration order is insertion order) keeps the cache from growing
 * unboundedly under many distinct sessions.
 */
export function setCachedSession(
  hashedToken: string,
  identity: CachedSessionIdentity,
  sessionExpiresAtMs: number,
  now: number = Date.now(),
): void {
  if (sessionExpiresAtMs <= now) return;
  if (!cache.has(hashedToken) && cache.size >= SESSION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(hashedToken, { identity, cachedAtMs: now, sessionExpiresAtMs });
}

/** Immediate invalidation for a single revoked/logged-out session token. */
export function invalidateCachedToken(hashedToken: string): void {
  cache.delete(hashedToken);
}

/**
 * Immediate invalidation for every cached session belonging to a user —
 * used by admin bulk session revocation (password reset, account deletion),
 * which revokes by user_id rather than by a single token.
 */
export function invalidateCachedSessionsForUser(userId: number): void {
  for (const [key, entry] of cache) {
    if (entry.identity.id === userId) cache.delete(key);
  }
}

/** Test-only: reset all cached state between test cases. */
export function clearSessionCache(): void {
  cache.clear();
}

/** Test/observability-only: current cache population. */
export function getSessionCacheSize(): number {
  return cache.size;
}
