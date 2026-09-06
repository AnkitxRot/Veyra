import React, { useEffect, useMemo, useState } from "react";
import type { CollaboratorPresence } from "../../collab/presence";
import {
  formatRelativeTime,
  groupCollaboratorsByFolder,
  displayLabel,
  secondaryHandle,
} from "../../collab/presence";
import type { CollabConnectionStatus } from "../../collab/client";
import { rosterStalenessNote } from "../../collab/connectionPresentation";
import type { RunStatusEntry, TimelineEvent } from "../../types";
import { pickRunForUser, formatRunText } from "./runActivity";
import ActivityTimeline from "./ActivityTimeline";
import UserAvatar from "../common/UserAvatar";

export interface TeamPanelProps {
  /** ALL collaborators for the project, including the local user. */
  collaborators: CollaboratorPresence[];
  runStatuses: RunStatusEntry[];
  currentUserId: number;
  isDnd: boolean;
  followingUserId: number | null;
  /** M73: the canonical collaboration connection status — drives the
   *  "this list may be out of date" caveat. Defaults to "connected". */
  collabStatus?: CollabConnectionStatus;
  onClose: () => void;
  onSetIntent: (text: string) => void;
  onToggleDnd: (dnd: boolean) => void;
  onFollow: (c: CollaboratorPresence) => void;
  onJump: (c: CollaboratorPresence) => void;
  /** M60: Team Activity timeline (edit bursts, runs, commits, callouts, snapshots). */
  timeline: TimelineEvent[];
  timelineHasMore: boolean;
  timelineLoadingMore?: boolean;
  onTimelineLoadMore: () => void;
  onTimelineNavigate: (ev: TimelineEvent) => void;
  /** M60: newest edit/callout per userId, for the per-collaborator "last change" line. */
  lastChangeByUser?: Map<number, TimelineEvent>;
}

const ACTIVITY_LABEL: Record<string, string> = {
  editing: "✏️ Editing",
  viewing: "👀 Viewing",
  reviewing: "👀 Reviewing",
  navigating: "🧭 Navigating",
  running: "🧪 Running",
  terminal: "💻 Terminal",
  searching: "🔎 Searching",
};

const AVAIL_LABEL: Record<string, string> = {
  online: "Online",
  idle: "Idle",
  away: "Away",
  dnd: "Do not disturb",
};

/** One row per user — the most recently active tab wins for a multi-tab user. */
function rosterByUser(list: CollaboratorPresence[]): CollaboratorPresence[] {
  const byUser = new Map<number, CollaboratorPresence>();
  for (const c of list) {
    const prev = byUser.get(c.userId);
    if (!prev || c.lastActive > prev.lastActive) byUser.set(c.userId, c);
  }
  return [...byUser.values()];
}

export default function TeamPanel({
  collaborators,
  runStatuses,
  currentUserId,
  isDnd,
  followingUserId,
  collabStatus = "connected",
  onClose,
  onSetIntent,
  onToggleDnd,
  onFollow,
  onJump,
  timeline,
  timelineHasMore,
  timelineLoadingMore,
  onTimelineLoadMore,
  onTimelineNavigate,
  lastChangeByUser,
}: TeamPanelProps) {
  // 1 Hz relative-time ticker — LOCAL to this mounted panel, cleared on unmount.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const roster = useMemo(() => rosterByUser(collaborators), [collaborators]);
  const self = roster.find((c) => c.userId === currentUserId) ?? null;
  const others = roster.filter((c) => c.userId !== currentUserId);
  const folders = useMemo(
    () => groupCollaboratorsByFolder(collaborators, currentUserId),
    [collaborators, currentUserId],
  );

  const [intentDraft, setIntentDraft] = useState(self?.intent?.text ?? "");
  useEffect(() => {
    setIntentDraft(self?.intent?.text ?? "");
  }, [self?.intent?.text]);

  const activityText = (c: CollaboratorPresence): string => {
    const run = pickRunForUser(runStatuses, c.userId);
    if (run) return formatRunText(run, now);
    if (c.status !== "online") return AVAIL_LABEL[c.status] ?? "Away";
    return ACTIVITY_LABEL[c.activity?.type ?? "viewing"] ?? "Active";
  };

  const commitIntent = () => {
    const next = intentDraft.trim();
    if (next !== (self?.intent?.text ?? "")) onSetIntent(next);
  };

  const staleNote = rosterStalenessNote(collabStatus);

  return (
    <div className="team-panel liquid-card" role="dialog" aria-label="Team">
      <div className="team-panel-header">
        <span>
          TEAM <span className="team-count">({roster.length})</span>
        </span>
        <button
          type="button"
          className="team-close"
          aria-label="Close team panel"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {staleNote && (
        <div className="team-stale-note" role="status">
          {staleNote}
        </div>
      )}

      {self && (
        <div className="team-row team-row-self">
          <UserAvatar
            userId={self.userId}
            username={self.name}
            avatarVersion={self.avatarVersion}
            color={self.color}
            size={22}
            self
            className="team-avatar"
          />
          <div className="team-row-main">
            <div className="team-row-top">
              <span className="team-name">You</span>
              <button
                type="button"
                className={`team-dnd ${isDnd ? "on" : ""}`}
                aria-pressed={isDnd}
                onClick={() => onToggleDnd(!isDnd)}
              >
                {isDnd ? "DND" : "Online"}
              </button>
            </div>
            <label className="team-intent-edit">
              <span aria-hidden="true">🎯</span>
              <input
                type="text"
                maxLength={120}
                placeholder="What are you working on?"
                value={intentDraft}
                onChange={(e) => setIntentDraft(e.target.value)}
                onBlur={commitIntent}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                aria-label="Your current intent"
              />
            </label>
          </div>
        </div>
      )}

      <div className="team-list">
        {others.length === 0 && (
          <div className="team-empty">No other collaborators here right now.</div>
        )}
        {others.map((c) => {
          const file = c.activeFile ? c.activeFile.split("/").pop() : null;
          return (
            <div className="team-row" key={c.userId}>
              <UserAvatar
                userId={c.userId}
                username={c.name}
                avatarVersion={c.avatarVersion}
                color={c.color}
                size={22}
                className="team-avatar"
              />
              <span
                className={`team-avail team-avail-${c.status}`}
                title={AVAIL_LABEL[c.status] ?? c.status}
              />
              <div className="team-row-main">
                <div className="team-row-top">
                  <span className="team-name">{displayLabel(c)}</span>
                  {secondaryHandle(c) && (
                    <span className="team-handle">{secondaryHandle(c)}</span>
                  )}
                  <span className="team-role">{c.role}</span>
                  <span className="team-time">
                    {formatRelativeTime(c.lastActive, now)}
                  </span>
                </div>
                <div className="team-activity">{activityText(c)}</div>
                {file && (
                  <div className="team-file">
                    {file}
                    {c.cursor ? ` · L${c.cursor.line}` : ""}
                  </div>
                )}
                {c.workingFolder && (
                  <div className="team-folder">📁 {c.workingFolder}</div>
                )}
                {c.intent?.text && (
                  <div className="team-intent">🎯 {c.intent.text}</div>
                )}
                {(() => {
                  const lc = lastChangeByUser?.get(c.userId);
                  if (!lc) return null;
                  return (
                    <div className="team-last-change">
                      Last change:{" "}
                      {lc.kind === "callout"
                        ? "left a callout"
                        : lc.title}
                      {lc.filePath ? ` · ${lc.filePath.split("/").pop()}` : ""}{" "}
                      · {formatRelativeTime(Date.parse(lc.at), now)}
                    </div>
                  );
                })()}
                <div className="team-actions">
                  <button
                    type="button"
                    aria-label={`Follow ${displayLabel(c)}`}
                    onClick={() => onFollow(c)}
                  >
                    {followingUserId === c.userId ? "Unfollow" : "Follow"}
                  </button>
                  {c.activeFile && (
                    <button
                      type="button"
                      aria-label={`Jump to ${displayLabel(c)}`}
                      onClick={() => onJump(c)}
                    >
                      Jump
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {folders.size > 0 && (
        <div className="team-folders">
          <div className="team-folders-title">WORKING IN</div>
          {[...folders.entries()].map(([folder, people]) => (
            <div className="team-folder-row" key={folder}>
              <span className="team-folder-name">{folder}</span>
              <span className="team-folder-people">
                {people.map((p) => displayLabel(p)).join(", ")}
              </span>
            </div>
          ))}
        </div>
      )}

      <ActivityTimeline
        events={timeline}
        hasMore={timelineHasMore}
        loadingMore={timelineLoadingMore}
        onLoadMore={onTimelineLoadMore}
        onNavigate={onTimelineNavigate}
      />
    </div>
  );
}
