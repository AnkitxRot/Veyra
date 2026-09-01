import React, { useEffect, useState } from "react";
import type { TimelineEvent } from "../../types";
import { formatTimelineEvent } from "../../collab/timeline";

export interface ActivityTimelineProps {
  events: TimelineEvent[];
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  onNavigate: (ev: TimelineEvent) => void;
}

/**
 * M60: the "TEAM ACTIVITY" section rendered INSIDE TeamPanel — the project's
 * meaningful engineering story (edit bursts, runs, commits, callouts,
 * snapshots), newest first. Not a raw telemetry feed: cursor/selection/
 * navigation events never reach here (there is no source for them).
 */
export default function ActivityTimeline({
  events,
  hasMore,
  loadingMore = false,
  onLoadMore,
  onNavigate,
}: ActivityTimelineProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="team-activity-timeline">
      <div className="tat-title">TEAM ACTIVITY</div>
      {events.length === 0 ? (
        <div className="tat-empty">No recent activity.</div>
      ) : (
        <ul className="tat-list">
          {events.map((ev) => {
            const f = formatTimelineEvent(ev, now);
            return (
              <li
                key={ev.id}
                className={`tat-row${f.navigable ? " tat-navigable" : ""}`}
                {...(f.navigable
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
                title={ev.filePath ?? undefined}
              >
                <span className="tat-time">{f.time}</span>
                <span className="tat-icon" aria-hidden="true">
                  {f.icon}
                </span>
                <span className="tat-body">
                  <span className="tat-actor">{f.actor}</span>{" "}
                  <span className="tat-text">{f.text}</span>
                  {ev.filePath && ev.kind !== "commit" && ev.kind !== "snapshot" && (
                    <span className="tat-file"> · {ev.filePath.split("/").pop()}</span>
                  )}
                  {ev.subtitle && (
                    <span className="tat-sub"> — {ev.subtitle}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <button
          type="button"
          className="tat-more"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
