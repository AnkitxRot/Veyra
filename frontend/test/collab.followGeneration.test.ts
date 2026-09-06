import { describe, it, expect } from "vitest";
import { FollowGeneration } from "../src/collab/followGeneration";

describe("M73 — FollowGeneration token", () => {
  it("starts at generation 0 and that token is current", () => {
    const g = new FollowGeneration();
    expect(g.current()).toBe(0);
    expect(g.isCurrent(0)).toBe(true);
  });

  it("bump ends the prior session and returns the new token", () => {
    const g = new FollowGeneration();
    const first = g.current();
    const next = g.bump();
    expect(next).toBe(first + 1);
    expect(g.current()).toBe(next);
    // the prior session's token is now stale
    expect(g.isCurrent(first)).toBe(false);
    expect(g.isCurrent(next)).toBe(true);
  });

  it("a continuation captured under session N is inert after any later bump", () => {
    const g = new FollowGeneration();
    const captured = g.current(); // e.g. an absence timer armed now
    g.bump(); // user switches follow target
    g.bump(); // …and again
    expect(g.isCurrent(captured)).toBe(false);
  });

  it("only the exact live token is current — not merely 'the latest so far'", () => {
    const g = new FollowGeneration();
    const a = g.bump();
    const b = g.bump();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
});
