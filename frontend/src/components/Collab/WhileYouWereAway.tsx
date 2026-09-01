import React, { useEffect } from "react";
import type { TimelineEvent } from "../../types";

export interface WhileAwayCardGroup {
  userId: number | null;
  username: string;
  lines: string[];
  events: TimelineEvent[];
}

export interface WhileYouWereAwayProps {
  groups: WhileAwayCardGroup[];
  colorForUser?: (userId: number | null) => string;
  onNavigate: (ev: TimelineEvent) => void;
  onDismiss: () => void;
  autoDismissMs?: number;
}

/**
 * M60: a compact, dismissible card shown on reconnect after a real absence.
 * NOT a dashboard. Grouped by author, each line navigable when its event has a
 * code location. Dismiss (and auto-dismiss) both acknowledge exactly once via
 * the parent's onDismiss.
 */
export default function WhileYouWereAway({
  groups,
  colorForUser,
  onNavigate,
  onDismiss,
  autoDismissMs = 20000,
}: WhileYouWereAwayProps) {
  useEffect(() => {
    if (!autoDismissMs) return;
    const id = window.setTimeout(onDismiss, autoDismissMs);
    return () => window.clearTimeout(id);
  }, [autoDismissMs, onDismiss]);

  return (
    <div className="while-away-card" role="dialog" aria-label="While you were away">
      <div className="while-away-header">
        <span>WHILE YOU WERE AWAY</span>
        <button
          type="button"
          className="while-away-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      {groups.map((g) => (
        <div className="while-away-group" key={g.userId ?? g.username}>
          <div className="while-away-author">
            <span
              className="while-away-dot"
              style={{ background: colorForUser?.(g.userId) ?? "#89b4fa" }}
              aria-hidden="true"
            />
            {g.username}
          </div>
          {g.lines.map((line, i) => {
            const ev = g.events[i];
            const navigable = !!ev && ev.navigable && !!ev.filePath;
            return (
              <div
                key={`${g.userId}-${i}`}
                className={`while-away-line${navigable ? " navigable" : ""}`}
                {...(navigable
                  ? {
                      role: "button",
                      tabIndex: 0,
                      onClick: () => onNavigate(ev),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onNavigate(ev);
                        }
                      },
                    }
                  : {})}
              >
                {line}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
