import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../src/auth/ratelimit.js";

describe("RateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces the max within a window and resets after it elapses", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(limiter.allow("a")).toBe(true);
  });

  it("sweeps expired entries once the map crosses the size threshold, bounding memory growth", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(5, 1000);

    // Fill past the internal sweep threshold with distinct, short-lived keys
    // (simulating many distinct client IPs hitting an unauthenticated route).
    for (let i = 0; i < 10_000; i++) {
      limiter.allow(`client-${i}`);
    }
    expect(limiter.size).toBe(10_000);

    // Let every existing entry's window elapse.
    vi.advanceTimersByTime(1001);

    // One more call crosses the sweep threshold check and triggers a sweep;
    // all 10,000 now-expired entries must be purged, not retained forever.
    limiter.allow("trigger");
    expect(limiter.size).toBeLessThan(10_000);
    expect(limiter.size).toBe(1);
  });

  it("sweeping does not disturb an unrelated key that is still within its window", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1, 5000);

    // Filler keys are recorded first, so their 5s windows elapse first.
    for (let i = 0; i < 10_000; i++) {
      limiter.allow(`expired-${i}`);
    }

    // Advance partway: filler keys are not expired yet, but this puts
    // "still-active"'s window far enough ahead that a later advance can
    // expire the fillers without expiring it.
    vi.advanceTimersByTime(4000);
    limiter.allow("still-active");
    expect(limiter.allow("still-active")).toBe(false); // already at max

    // Now expire the filler keys (their windows started at t=0) without
    // expiring "still-active" (its window started at t=4000).
    vi.advanceTimersByTime(1001);
    expect(limiter.size).toBeGreaterThanOrEqual(10_000); // sweep not run yet

    // One more call crosses the sweep threshold and triggers a sweep.
    limiter.allow("sweep-trigger");
    expect(limiter.size).toBeLessThan(100);

    // The still-active key must still be rate-limited: its entry survived
    // the sweep since its own window had not elapsed yet.
    expect(limiter.allow("still-active")).toBe(false);
  });
});
