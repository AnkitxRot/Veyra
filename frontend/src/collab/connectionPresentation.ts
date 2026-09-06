// M73 — shared presentation helpers over the canonical CollaborationClient
// connection status. Keeps the roster surfaces (avatar stack, Team panel)
// from presenting a last-known collaborator list as fully live while the
// socket is down / reconnecting / resyncing.
//
// This is the ONE place that decides the roster-staleness copy — the
// editor-region CollabConnectionBanner (M63) keeps its own, longer,
// action-bearing lines; both read the same `status`, so they cannot
// contradict each other.

import type { CollabConnectionStatus } from "./client";

/** True only when the collaborator roster can be trusted as live. */
export function collaborationIsLive(status: CollabConnectionStatus): boolean {
  return status === "connected";
}

/**
 * A short note explaining why the collaborator list on a roster surface may
 * not be current, or `null` in the steady state. Presentation only.
 */
export function rosterStalenessNote(
  status: CollabConnectionStatus,
): string | null {
  switch (status) {
    case "connected":
      return null;
    case "resynchronizing":
      return "Reconnected — this list may be a moment behind.";
    case "connecting":
    case "reconnecting":
      return "Reconnecting — this list may be out of date.";
    case "disconnected":
      return "Disconnected — this list may be out of date.";
    case "forbidden":
      return "Collaboration ended — this list is no longer updating.";
    default:
      return null;
  }
}
