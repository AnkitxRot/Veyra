import type { DebugSessionState } from "./types";

/**
 * Status frames from `/ws/debug` are authoritative except for two races:
 * - attach broadcasts `idle` after the client has already sent launch
 * - a stale parent-session `running` must not clobber a real pause
 */
export function shouldApplyStatus(
  current: DebugSessionState,
  next: DebugSessionState,
  expectContinue: boolean,
): boolean {
  if (next === "idle" && current === "starting") return false;
  if (next === "running" && current === "paused" && !expectContinue) {
    return false;
  }
  if (
    (current === "terminated" ||
      current === "failed" ||
      current === "unavailable") &&
    (next === "starting" ||
      next === "running" ||
      next === "paused" ||
      next === "stopping")
  ) {
    return false;
  }
  return true;
}

/** Adapter `continued` is ignored while paused unless the user asked to resume. */
export function shouldApplyContinued(
  current: DebugSessionState,
  expectContinue: boolean,
): boolean {
  if (
    current === "terminated" ||
    current === "failed" ||
    current === "unavailable" ||
    current === "stopping"
  ) {
    return false;
  }
  if (current === "paused" && !expectContinue) return false;
  return true;
}
