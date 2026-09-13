import React, { useEffect } from "react";
import type { CollaboratorPresence } from "../../collab/client";
import { displayLabel } from "../../collab/presence";
import { IconClose } from "../common/Icons";
import UserAvatar from "../common/UserAvatar";

export interface FollowBannerProps {
  followedUser: CollaboratorPresence;
  isPaused?: boolean;
  pauseReason?: string;
  onStopFollowing: () => void;
  /** M59: an anchor was captured when Follow started — offer to return to it. */
  hasAnchor?: boolean;
  onReturnToLocation?: () => void;
  /** M59: the followed collaborator's current focus range, if any. */
  followedRange?: { startLine: number; endLine: number } | null;
}

export default function FollowBanner({
  followedUser,
  isPaused = false,
  pauseReason = "You have unsaved local changes",
  onStopFollowing,
  hasAnchor = false,
  onReturnToLocation,
  followedRange = null,
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

  // M62: label = effective display name; the avatar glyph stays
  // username-derived so a rename never churns it.
  const label = displayLabel(followedUser);
  const fileName = followedUser.activeFile
    ? followedUser.activeFile.split("/").pop()
    : null;
  const line = followedUser.cursor?.line;
  const rangeText = followedRange
    ? followedRange.startLine === followedRange.endLine
      ? ` · Line ${followedRange.startLine}`
      : ` · Lines ${followedRange.startLine}–${followedRange.endLine}`
    : line
      ? ` · Line ${line}`
      : "";

  return (
    <div
      className={`follow-banner ${isPaused ? "paused" : "active"}`}
      role="status"
      aria-live="polite"
      aria-label={
        isPaused
          ? `Follow paused for ${label}: ${pauseReason}`
          : `Following ${label}`
      }
    >
      <div className="follow-banner-content">
        <div
          className="follow-avatar"
          style={{
            background: "transparent",
            borderColor: isPaused ? "#fab387" : followedUser.color,
          }}
        >
          <UserAvatar
            userId={followedUser.userId}
            username={followedUser.name}
            avatarVersion={followedUser.avatarVersion}
            color={followedUser.color}
            size={18}
          />
        </div>

        <div className="follow-info">
          <div className="follow-title">
            <span className="follow-status-dot" />
            <span className="follow-user-name">
              {isPaused ? "Follow Paused" : `Following ${label}`}
            </span>
          </div>

          <div className="follow-subtext">
            {isPaused ? (
              <span className="follow-paused-reason">{pauseReason}</span>
            ) : fileName ? (
              <span className="follow-location">
                {fileName}
                {rangeText}
              </span>
            ) : (
              <span className="follow-location">
                Workspace navigation{rangeText}
              </span>
            )}
          </div>
        </div>

        <div className="follow-actions">
          <span className="follow-kbd-hint">Esc to stop</span>
          {hasAnchor && onReturnToLocation && (
            <button
              className="glass-btn follow-return-btn"
              onClick={onReturnToLocation}
              title="Return to my location"
              aria-label="Return to my location"
            >
              <span>Return to my location</span>
            </button>
          )}
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
