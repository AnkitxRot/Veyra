/**
 * Fixed-window in-memory rate limiter keyed by arbitrary strings (e.g. client IP).
 * Zero dependencies; suitable for a single-instance backend.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed, false if the limit is exceeded. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  reset(): void {
    this.hits.clear();
  }
}
