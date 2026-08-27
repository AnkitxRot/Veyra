import React, { useEffect } from "react";
import type { CollaboratorPresence } from "../../collab/client";
import { IconClose, IconUsers } from "../common/Icons";

export interface FollowBannerProps {
  followedUser: CollaboratorPresence;
  isPaused?: boolean;
  pauseReason?: string;
  onStopFollowing: () => void;
}

export default function FollowBanner({
  followedUser,
  isPaused = false,
  pauseReason = "You have unsaved local changes",
  onStopFollowing,
}: FollowBannerProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onStopFollowing();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onStopFollowing]);

  const initials = followedUser.name.slice(0, 2).toUpperCase();
  const fileName = followedUser.activeFile
    ? followedUser.activeFile.split("/").pop()
    : null;
  const line = followedUser.cursor?.line;

  return (
    <div
      className={`follow-banner ${isPaused ? "paused" : "active"}`}
      role="status"
      aria-live="polite"
      aria-label={
        isPaused
          ? `Follow paused for ${followedUser.name}: ${pauseReason}`
          : `Following ${followedUser.name}`
      }
    >
      <div className="follow-banner-content">
        <div
          className="follow-avatar"
          style={{
            background: followedUser.color,
            borderColor: isPaused ? "#fab387" : followedUser.color,
          }}
        >
          {initials}
        </div>

        <div className="follow-info">
          <div className="follow-title">
            <span className="follow-status-dot" />
            <span className="follow-user-name">
              {isPaused ? "Follow Paused" : `Following ${followedUser.name}`}
            </span>
          </div>

          <div className="follow-subtext">
            {isPaused ? (
              <span className="follow-paused-reason">{pauseReason}</span>
            ) : fileName ? (
              <span className="follow-location">
                {fileName}
                {line ? ` · Line ${line}` : ""}
              </span>
            ) : (
              <span className="follow-location">Workspace navigation</span>
            )}
          </div>
        </div>

        <div className="follow-actions">
          <span className="follow-kbd-hint">Esc to stop</span>
          <button
            className="glass-btn follow-stop-btn"
            onClick={onStopFollowing}
            title="Stop Following"
            aria-label="Stop Following Collaborator"
          >
            <IconClose size={11} />
            <span>Stop</span>
          </button>
        </div>
      </div>
    </div>
  );
}
