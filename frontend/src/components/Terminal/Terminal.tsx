import { useEffect, useRef } from "react";
import { IconTrash, IconRefresh } from "../common/Icons";
import { useTerminalSession } from "../../hooks/useTerminalSession";
import {
  TERMINAL_STATES,
  type TerminalConnectionState,
} from "../../hooks/terminalSessionState";

/**
 * M79 — thin presentation layer over `useTerminalSession`.
 *
 * The session (XTerm + WebSocket + PTY) is owned by the hook and lives for the
 * project's lifetime. This component is mounted by IDE.tsx regardless of the
 * bottom-panel tab or collapse state; `visible` only toggles `display`, never
 * the session. Switching bottom tabs / collapsing the drawer therefore does
 * NOT close the socket, dispose the XTerm, or kill the PTY.
 */

const BADGE: Record<
  TerminalConnectionState,
  { text: string; kind: "success" | "error" | "warn" }
> = {
  [TERMINAL_STATES.connecting]: { text: "Connecting…", kind: "warn" },
  [TERMINAL_STATES.connected]: { text: "bash (sandbox)", kind: "success" },
  [TERMINAL_STATES.reconnecting]: { text: "Reconnecting…", kind: "warn" },
  [TERMINAL_STATES.reconnect_exhausted]: {
    text: "Disconnected",
    kind: "error",
  },
  [TERMINAL_STATES.ended]: { text: "Session ended", kind: "error" },
};

export default function Terminal({
  projectId,
  userId,
  resolvedTheme = "dark",
  visible = true,
}: {
  projectId: string;
  /** Authenticated user id. Required for M88 same-tab PTY resume. */
  userId?: number;
  resolvedTheme?: "dark" | "light";
  visible?: boolean;
}) {
  const { state, endedReason, bindContainer, ensureStarted, clear, retry, fit } =
    useTerminalSession(projectId, resolvedTheme, userId);

  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bindContainer(hostRef.current);
    return () => bindContainer(null);
  }, [bindContainer]);

  // `projectId` is a dependency so a project change (which resets the session
  // in the hook) re-arms `ensureStarted` on the next visible frame.
  useEffect(() => {
    if (visible) {
      ensureStarted();
      fit();
    }
  }, [visible, projectId, ensureStarted, fit]);

  const badge = BADGE[state];
  const connected = state === TERMINAL_STATES.connected;
  const showRetry =
    state === TERMINAL_STATES.reconnect_exhausted ||
    state === TERMINAL_STATES.ended;

  return (
    <div
      className="panel-content"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {/* Terminal Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          background: "var(--glass-surface-2)",
          borderBottom: "1px solid var(--glass-border)",
          fontSize: "var(--text-xs)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            className={`glass-badge glass-badge-${
              badge.kind === "success"
                ? "success"
                : badge.kind === "warn"
                  ? "warn"
                  : "error"
            }`}
          >
            <span
              className={`capability-dot ${connected ? "ready" : "error"}`}
            />
            <span>{badge.text}</span>
          </span>
          <span style={{ color: "var(--fg-muted)", fontSize: "11px" }}>
            {state === TERMINAL_STATES.ended && endedReason
              ? `reason: ${endedReason}`
              : "Docker container: /workspace"}
          </span>
        </div>

        <div style={{ display: "flex", gap: "4px" }}>
          {showRetry && (
            <button
              className="glass-btn"
              style={{ fontSize: "11px", padding: "2px 8px" }}
              onClick={retry}
              title={
                state === TERMINAL_STATES.ended
                  ? "Start a new terminal"
                  : "Retry connection"
              }
            >
              {state === TERMINAL_STATES.ended
                ? "Start new terminal"
                : "Retry"}
            </button>
          )}
          <button
            className="glass-btn glass-btn-icon"
            onClick={clear}
            title="Clear Terminal"
            aria-label="Clear Terminal"
          >
            <IconTrash size={12} />
          </button>
          <button
            className="glass-btn glass-btn-icon"
            onClick={retry}
            title="Reconnect Terminal"
            aria-label="Reconnect Terminal"
          >
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <div ref={hostRef} className="terminal-container" />
    </div>
  );
}
