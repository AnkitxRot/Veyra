/**
 * Fixed-window in-memory rate limiter keyed by arbitrary strings (e.g. client IP).
 * Zero dependencies; suitable for a single-instance backend.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  // Entries whose window has elapsed are only ever overwritten on the next
  // hit from the *same* key, never removed. Keyed by request IP on
  // unauthenticated routes, so a long-running server otherwise accumulates
  // one permanent entry per distinct client ever seen. Sweep opportunistically
  // once the map grows large enough that a scan is worth its cost, rather
  // than running a background timer with its own lifecycle to manage.
  private static readonly SWEEP_THRESHOLD = 10_000;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed, false if the limit is exceeded. */
  allow(key: string): boolean {
    const now = Date.now();
    if (this.hits.size >= RateLimiter.SWEEP_THRESHOLD) {
      this.sweepExpired(now);
    }
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }

  /** Current tracked-key count, for tests/diagnostics only. */
  get size(): number {
    return this.hits.size;
  }

  reset(): void {
    this.hits.clear();
  }
}
