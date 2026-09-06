import React, { useEffect, useState } from "react";
import type { TimelineEvent } from "../../types";
import { formatTimelineEvent } from "../../collab/timeline";
import { displayLabel } from "../../collab/presence";
import UserAvatar from "../common/UserAvatar";

/** M73: userId → presentation identity, so a timeline actor renders the same
 *  avatar + display name as every other collaboration surface. `username`
 *  stays the fallback and the stable attribution key. */
export type ActorIdentityMap = Map<
  number,
  { displayName?: string | null; avatarVersion?: number }
>;

export interface ActivityTimelineProps {
  events: TimelineEvent[];
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  onNavigate: (ev: TimelineEvent) => void;
  /** M73: optional identity lookup for actor rows. */
  actorIdentity?: ActorIdentityMap;
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
  actorIdentity,
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
            const id =
              ev.actor.userId != null
                ? actorIdentity?.get(ev.actor.userId)
                : undefined;
            const actorName = displayLabel({
              name: f.actor,
              displayName: id?.displayName ?? null,
            });
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
                {ev.actor.userId != null && (
                  <UserAvatar
                    userId={ev.actor.userId}
                    username={f.actor}
                    avatarVersion={id?.avatarVersion}
                    size={16}
                    className="tat-avatar"
                  />
                )}
                <span className="tat-icon" aria-hidden="true">
                  {f.icon}
                </span>
                <span className="tat-body">
                  <span className="tat-actor">{actorName}</span>{" "}
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
