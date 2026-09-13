/**
 * M79 — terminal session constants + types. Kept in a `.ts` module so the
 * `useTerminalSession` hook file exports only a hook (react-refresh),
 * mirroring the `terminalThemes.ts` split.
 */

export const TERMINAL_STATES = {
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
  reconnect_exhausted: "reconnect_exhausted",
  ended: "ended",
} as const;

export type TerminalConnectionState =
  (typeof TERMINAL_STATES)[keyof typeof TERMINAL_STATES];

// Bounded reconnect policy. Cumulative backoff before the ceiling:
// 1.0 + 1.8 + 3.24 + 5.83 + 10.5 + 15.0 ≈ 37.4s — comfortably inside the
// server's TERMINAL_DETACH_GRACE_MS (90s) so an actively-reconnecting client
// always finds its detached PTY.
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_FACTOR = 1.8;
export const RECONNECT_MAX_MS = 15_000;
export const RECONNECT_MAX_ATTEMPTS = 6;

export type TerminalEndedReason =
  | "grace_expired"
  | "process_exited"
  | "container_stopped"
  | "authorization_revoked"
  | "server_shutdown"
  | "session_gone"
  | "unknown";

export const TERMINAL_ENDED_REASONS: TerminalEndedReason[] = [
  "grace_expired",
  "process_exited",
  "container_stopped",
  "authorization_revoked",
  "server_shutdown",
  "session_gone",
];

export interface TerminalSession {
  state: TerminalConnectionState;
  endedReason: TerminalEndedReason | null;
  /** Attach (or detach with `null`) the XTerm's host element. */
  bindContainer: (el: HTMLElement | null) => void;
  /** Start the session on first use. Idempotent; a no-op once started. */
  ensureStarted: () => void;
  /** Clear the visible XTerm buffer (does not touch the PTY). */
  clear: () => void;
  /** Manual retry from `reconnect_exhausted` or `ended`. From `ended` this is
   *  an explicit request for a brand-new shell. */
  retry: () => void;
  /** Re-fit the XTerm to its host (call when the panel becomes visible). */
  fit: () => void;
}

export function newTerminalId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    /* fall through */
  }
  return (
    "tid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  );
}
