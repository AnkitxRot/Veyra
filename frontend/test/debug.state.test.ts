import { describe, it, expect } from "vitest";
import { shouldApplyContinued, shouldApplyStatus } from "../src/debug/state";

describe("debugger UI state races", () => {
  it("ignores attach idle while the user has already started", () => {
    expect(shouldApplyStatus("starting", "idle", false)).toBe(false);
  });

  it("does not let a stale running status clobber a pause", () => {
    expect(shouldApplyStatus("paused", "running", false)).toBe(false);
    expect(shouldApplyStatus("paused", "running", true)).toBe(true);
  });

  it("applies a real running status from handshake before pause", () => {
    expect(shouldApplyStatus("starting", "running", false)).toBe(true);
  });

  it("does not resurrect a stopped session from a late live status", () => {
    expect(shouldApplyStatus("terminated", "stopping", false)).toBe(false);
    expect(shouldApplyStatus("terminated", "paused", false)).toBe(false);
    expect(shouldApplyStatus("failed", "running", false)).toBe(false);
  });

  it("ignores adapter continued while paused unless the user continued", () => {
    expect(shouldApplyContinued("paused", false)).toBe(false);
    expect(shouldApplyContinued("paused", true)).toBe(true);
    expect(shouldApplyContinued("starting", false)).toBe(true);
    expect(shouldApplyContinued("terminated", true)).toBe(false);
  });
});
