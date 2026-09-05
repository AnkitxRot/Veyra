import React from "react";
import type { CollabConnectionStatus } from "../../collab/client";

/**
 * M63 — editor-region collaboration connection & sync-state banner.
 *
 * Independent of the collaborator avatar stack: it takes no collaborator list,
 * so a solo editor whose socket drops still sees it. Renders nothing in the
 * steady state (connected, nothing pending) to avoid persistent clutter.
 *
 * Text is truthful and actionable. The unsynced-changes line never claims data
 * loss — Yjs still holds the local edits; the risk is only that closing the
 * tab before they reach the server would strand them.
 */
export interface CollabConnectionBannerProps {
  status: CollabConnectionStatus;
  /** Local Yjs update batches that have not yet reached the server (from
   *  CollaborationClient.pendingLocalUpdates). Not a keystroke count. */
  pendingLocalUpdates: number;
  /** True once automatic reconnection has been given up (the ceiling was hit). */
  reconnectExhausted: boolean;
  /** Manual reconnect — wired to CollaborationClient.retry(). */
  onRetry: () => void;
}

type Line = {
  key: string;
  tone: "info" | "warn" | "error";
  text: string;
  action?: { label: string; onClick: () => void };
};

function connectionLine(
  status: CollabConnectionStatus,
  reconnectExhausted: boolean,
  onRetry: () => void,
): Line | null {
  if (status === "forbidden") {
    return {
      key: "forbidden",
      tone: "error",
      text: "Collaboration access has ended. Changes you make now won't be shared with others.",
    };
  }
  if (status === "disconnected" && reconnectExhausted) {
    return {
      key: "exhausted",
      tone: "error",
      text: "Can't reach the collaboration server. Automatic reconnection has stopped.",
      action: { label: "Retry", onClick: onRetry },
    };
  }
  if (status === "disconnected") {
    return {
      key: "disconnected",
      tone: "warn",
      text: "Disconnected from the collaboration server — trying to reconnect…",
    };
  }
  if (status === "connecting" || status === "reconnecting") {
    return { key: "reconnecting", tone: "info", text: "Reconnecting…" };
  }
  if (status === "resynchronizing") {
    return {
      key: "resynchronizing",
      tone: "info",
      text: "Reconnected — syncing your changes…",
    };
  }
  return null; // connected
}

const TONE_COLOR: Record<Line["tone"], string> = {
  info: "var(--accent, #89b4fa)",
  warn: "#fab387",
  error: "#f38ba8",
};

export default function CollabConnectionBanner({
  status,
  pendingLocalUpdates,
  reconnectExhausted,
  onRetry,
}: CollabConnectionBannerProps) {
  const lines: Line[] = [];

  const conn = connectionLine(status, reconnectExhausted, onRetry);
  if (conn) lines.push(conn);

  if (pendingLocalUpdates > 0) {
    lines.push({
      key: "pending",
      tone: "warn",
      text: "You have unsynced local changes. Keep this tab open until they reach the server.",
    });
  }

  if (lines.length === 0) return null;

  const isAlert = lines.some((l) => l.tone === "error");

  return (
    <div
      className="collab-connection-banner"
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "6px 12px",
        fontSize: "12px",
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
        background: "var(--surface-0, #11131c)",
      }}
    >
      {lines.map((l) => (
        <div
          key={l.key}
          style={{ display: "flex", alignItems: "center", gap: "8px" }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              flex: "0 0 auto",
              background: TONE_COLOR[l.tone],
            }}
          />
          <span style={{ color: "var(--text, #cdd6f4)" }}>{l.text}</span>
          {l.action && (
            <button
              type="button"
              className="glass-btn glass-btn-ghost"
              style={{ fontSize: "11px", padding: "2px 8px" }}
              onClick={l.action.onClick}
            >
              {l.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
