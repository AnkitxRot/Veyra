import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { throttleLatest } from "../src/utils/throttleLatest";

describe("throttleLatest — presence-update throttle primitive (200ms boundary)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a rapid burst into a single call carrying only the latest value", () => {
    const fn = vi.fn();
    const throttled = throttleLatest(fn, 200);

    throttled("a");
    throttled("b");
    throttled("c");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("does not fire before the 200ms boundary", () => {
    const fn = vi.fn();
    const throttled = throttleLatest(fn, 200);

    throttled("a");
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not permanently suppress state: a later burst after the window fires again with its own latest value", () => {
    const fn = vi.fn();
    const throttled = throttleLatest(fn, 200);

    throttled("first-burst-1");
    throttled("first-burst-2");
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("first-burst-2");

    throttled("second-burst-1");
    throttled("second-burst-2");
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("second-burst-2");
  });

  it("cancel() drops any pending call and prevents it from firing", () => {
    const fn = vi.fn();
    const throttled = throttleLatest(fn, 200);

    throttled("a");
    throttled.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
