import React, { useState, useRef, useEffect } from "react";
import type {
  CollaboratorPresence,
  CollabConnectionStatus,
  AvailabilityStatus,
} from "../../collab/client";
import type { RunStatusEntry } from "../../types";
import type { AttentionEvent } from "../../collab/attention";
import { buildFocusContext } from "../../collab/focus";
import { displayLabel, secondaryHandle } from "../../collab/presence";
import { IconUsers, IconSparkles } from "../common/Icons";
import UserAvatar from "../common/UserAvatar";
import ProfileCard, {
  type ProfilePresenceTone,
} from "../common/ProfileCard";
import { rosterStalenessNote } from "../../collab/connectionPresentation";
import { pickRunForUser, formatRunText } from "./runActivity";

/** M73: map the availability axis onto a ProfileCard presence chip. */
const PRESENCE_TONE: Record<AvailabilityStatus, ProfilePresenceTone> = {
  online: "online",
  idle: "idle",
  away: "away",
  dnd: "dnd",
};
const PRESENCE_LABEL: Record<AvailabilityStatus, string> = {
  online: "Online",
  idle: "Idle",
  away: "Away",
  dnd: "Do not disturb",
};

export interface CollaboratorAvatarStackProps {
  collaborators: CollaboratorPresence[];
  runStatuses?: RunStatusEntry[];
  status: CollabConnectionStatus;
  currentUserId: number;
  isDnd?: boolean;
  followingUserId?: number | null;
  onToggleDnd?: (dnd: boolean) => void;
  onFollowCollaborator?: (collaborator: CollaboratorPresence) => void;
  onJumpToCollaborator?: (collaborator: CollaboratorPresence) => void;
  onOpenShareModal?: () => void;
  /** M57: open the full Team roster panel (count chip + avatar click). */
  onOpenTeamPanel?: () => void;
  /** M58: count of actionable incoming targeted attention requests. */
  incomingRequestCount?: number;
  /** M59: full attention list — drives the popover focus-context block. */
  attention?: AttentionEvent[];
}

export default function CollaboratorAvatarStack({
  collaborators,
  runStatuses = [],
  status,
  currentUserId,
  isDnd = false,
  followingUserId = null,
  onToggleDnd,
  onFollowCollaborator,
  onJumpToCollaborator,
  onOpenShareModal,
  onOpenTeamPanel,
  incomingRequestCount = 0,
  attention = [],
}: CollaboratorAvatarStackProps) {
  // M54: local 1s tick for the elapsed clock — only while some run is active.
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = runStatuses.some((e) => e.state === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyRunning]);
  const [selectedCollaborator, setSelectedCollaborator] =
    useState<CollaboratorPresence | null>(null);
  const [isSelfMenuOpen, setIsSelfMenuOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const staleNote = rosterStalenessNote(status);
  const otherCollaborators = collaborators.filter(
    (c) => c.userId !== currentUserId,
  );
  const selfCollaborator = collaborators.find(
    (c) => c.userId === currentUserId,
  );

  // Close popover on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setSelectedCollaborator(null);
        setIsSelfMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getStatusBadge = () => {
    switch (status) {
      case "connected":
        return (
          <span
            className="collab-status-badge synced"
            title="Real-Time CRDT Synchronization Active"
            aria-label="Real-Time Synchronization Active"
          >
            <span className="status-dot green" />
            <span className="status-label">Synced</span>
          </span>
        );
      case "connecting":
      case "reconnecting":
        return (
          <span
            className="collab-status-badge reconnecting"
            title="Reconnecting to Collaboration Room..."
            aria-label="Reconnecting..."
          >
            <span className="status-dot amber pulse" />
            <span className="status-label">Reconnecting…</span>
          </span>
        );
      case "resynchronizing":
        return (
          <span
            className="collab-status-badge resyncing"
            title="Resynchronizing CRDT Deltas..."
            aria-label="Resynchronizing..."
          >
            <span className="status-dot cyan pulse" />
            <span className="status-label">Resyncing…</span>
          </span>
        );
      case "forbidden":
        return (
          <span
            className="collab-status-badge error"
            title="Collaboration Access Revoked / Forbidden"
            aria-label="Access Forbidden"
          >
            <span className="status-dot red" />
            <span className="status-label">Access Revoked</span>
          </span>
        );
      default:
        return (
          <span
            className="collab-status-badge offline"
            title="Offline / Disconnected"
            aria-label="Offline"
          >
            <span className="status-dot gray" />
            <span className="status-label">Offline</span>
          </span>
        );
    }
  };

  const renderStatusDot = (availability: AvailabilityStatus) => {
    switch (availability) {
      case "online":
        return (
          <span
            className="collab-avatar-status online"
            title="Online & Active"
          />
        );
      case "idle":
        return (
          <span className="collab-avatar-status idle" title="Idle" />
        );
      case "away":
        return (
          <span className="collab-avatar-status idle" title="Away" />
        );
      case "dnd":
        return (
          <span className="collab-avatar-status dnd" title="Do Not Disturb" />
        );
      default:
        return null;
    }
  };

  const formatActivityText = (c: CollaboratorPresence): string => {
    // M54: a real server-owned run status supersedes the coarse M48 activity.
    const run = pickRunForUser(runStatuses, c.userId);
    if (run) return formatRunText(run, now);

    // M73: an idle / away / DND collaborator is not actively editing — report
    // the availability, not a stale "Editing foo.ts" (matches TeamPanel).
    if (c.status && c.status !== "online") {
      return PRESENCE_LABEL[c.status] ?? "Away";
    }

    const act = c.activity?.type || "viewing";
    const file = c.activeFile ? c.activeFile.split("/").pop() : null;
    const line = c.cursor?.line;

    switch (act) {
      case "editing":
        return file
          ? `Editing ${file}${line ? ` · L${line}` : ""}`
          : "Editing code";
      case "viewing":
        return file
          ? `Viewing ${file}${line ? ` · L${line}` : ""}`
          : "Viewing project";
      case "running":
        return "Running code / execution";
      case "terminal":
        return "Using terminal";
      case "searching":
        return "Searching workspace";
      case "reviewing":
        return "Reviewing changes";
      default:
        return "Active";
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "11px",
        position: "relative",
      }}
      role="region"
      aria-label="Collaborator Presence & Sync Status"
      ref={popoverRef}
    >
      {/* Sync Status Badge */}
      {getStatusBadge()}

      {/* Collaborator Avatars Stack — dimmed with a spoken caveat while the
          link is down / reconnecting, so a last-known roster is never
          presented as fully live (M73). */}
      {otherCollaborators.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginLeft: "4px",
            opacity: staleNote ? 0.5 : 1,
            transition: "opacity 150ms ease",
          }}
          role="group"
          aria-label={
            staleNote ? `Active Collaborators — ${staleNote}` : "Active Collaborators"
          }
          title={staleNote ?? undefined}
        >
          {otherCollaborators.map((c) => {
            // M62/M72: the avatar glyph stays username-derived (initials
            // fallback) so a rename never churns it. Colour stays `c.color`.
            const label = displayLabel(c);
            const handle = secondaryHandle(c);
            const identity = handle ? `${label} (${handle})` : label;
            const isFollowing = followingUserId === c.userId;
            const activitySummary = formatActivityText(c);
            const isRunningNow = runStatuses.some(
              (e) => e.userId === c.userId && e.state === "running",
            );

            return (
              <div
                key={c.clientId}
                style={{ position: "relative", marginLeft: "-6px" }}
              >
                <button
                  onClick={() => {
                    setIsSelfMenuOpen(false);
                    setSelectedCollaborator(
                      selectedCollaborator?.clientId === c.clientId ? null : c,
                    );
                  }}
                  style={{
                    width: "24px",
                    height: "24px",
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: isFollowing
                      ? "2px solid #89b4fa"
                      : "2px solid rgba(17, 19, 28, 0.9)",
                    cursor: "pointer",
                    padding: 0,
                    transition: "transform 120ms ease, box-shadow 120ms ease",
                    boxShadow: isFollowing
                      ? "0 0 8px rgba(137, 180, 250, 0.6)"
                      : "0 2px 6px rgba(0,0,0,0.3)",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.transform =
                      "translateY(-2px) scale(1.1)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.transform = "translateY(0) scale(1)")
                  }
                  title={`${identity} — ${(c.role || "collaborator").toUpperCase()} — ${activitySummary} [${(c.status || "online").toUpperCase()}]`}
                  aria-label={`Collaborator ${identity}, ${c.role || "collaborator"}, ${c.status || "online"}. ${activitySummary}.`}
                >
                  <UserAvatar
                    userId={c.userId}
                    username={c.name}
                    avatarVersion={c.avatarVersion}
                    color={c.color}
                    size={20}
                  />
                </button>
                {renderStatusDot(c.status)}
                {isRunningNow && (
                  <span
                    aria-hidden="true"
                    title={`${identity} — ${activitySummary}`}
                    style={{
                      position: "absolute",
                      bottom: "-2px",
                      left: "-4px",
                      fontSize: "9px",
                      lineHeight: 1,
                      color: "#a6e3a1",
                      textShadow: "0 0 3px rgba(0,0,0,0.8)",
                    }}
                  >
                    ▶
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* M57: collaborator count — opens the full Team roster panel. The
          per-avatar quick popover above is preserved for fast Follow/Jump. */}
      {onOpenTeamPanel && (
        <button
          type="button"
          className="collab-count"
          onClick={() => {
            onOpenTeamPanel();
            // M58: nudge the AttentionTray into view when there are requests.
            if (incomingRequestCount > 0) {
              document.dispatchEvent(
                new CustomEvent("ide-focus-attention-tray"),
              );
            }
          }}
          title="Open team panel"
          aria-label={`${collaborators.length} collaborator${
            collaborators.length === 1 ? "" : "s"
          } — open team panel`}
        >
          {collaborators.length}
          {incomingRequestCount > 0 && (
            <span
              className="collab-attn-badge"
              aria-label={`${incomingRequestCount} attention request${
                incomingRequestCount === 1 ? "" : "s"
              }`}
            >
              {incomingRequestCount}
            </span>
          )}
        </button>
      )}

      {/* Selected Collaborator Activity Popover */}
      {selectedCollaborator && (
        <div
          className="collab-popover liquid-card"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 1000,
            width: "240px",
            padding: "12px",
            background: "rgba(24, 26, 38, 0.95)",
            backdropFilter: "blur(12px)",
            borderRadius: "8px",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
            color: "var(--fg-primary, #cdd6f4)",
          }}
          role="dialog"
          aria-label={`Collaborator Details: ${
            secondaryHandle(selectedCollaborator)
              ? `${displayLabel(selectedCollaborator)} (${secondaryHandle(selectedCollaborator)})`
              : displayLabel(selectedCollaborator)
          }`}
        >
          {/* M73: the one canonical identity card — avatar + display name +
              @username + pronouns — reused rather than re-implemented. The
              role chip and Follow/Jump actions stay as popover chrome around
              it (collaboration context, not profile identity). */}
          <div style={{ marginBottom: "8px" }}>
            <ProfileCard
              userId={selectedCollaborator.userId}
              username={selectedCollaborator.name}
              displayName={selectedCollaborator.displayName}
              avatarVersion={selectedCollaborator.avatarVersion}
              pronouns={selectedCollaborator.pronouns}
              avatarSize={32}
              presence={{
                label: PRESENCE_LABEL[selectedCollaborator.status] ?? "Online",
                tone: PRESENCE_TONE[selectedCollaborator.status] ?? "online",
              }}
            />
            <div
              style={{
                fontSize: "9px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--fg-muted, #a6adc8)",
                fontWeight: 600,
                marginTop: "4px",
              }}
            >
              {selectedCollaborator.role || "collaborator"}
            </div>
          </div>

          <div
            style={{
              padding: "6px 8px",
              background: "rgba(0, 0, 0, 0.25)",
              borderRadius: "6px",
              fontSize: "11px",
              marginBottom: "10px",
              border: "1px solid rgba(255, 255, 255, 0.05)",
            }}
          >
            <div
              style={{
                color: "var(--fg-muted, #a6adc8)",
                fontSize: "10px",
                marginBottom: "2px",
              }}
            >
              CURRENT ACTIVITY
            </div>
            {(() => {
              const run = pickRunForUser(
                runStatuses,
                selectedCollaborator.userId,
              );
              const runColor = !run
                ? "#89b4fa"
                : run.state === "success"
                  ? "#a6e3a1"
                  : run.state === "failed"
                    ? "#f38ba8"
                    : run.state === "stopped"
                      ? "#a6adc8"
                      : "#a6e3a1";
              return (
                <div style={{ color: runColor, fontWeight: 500 }}>
                  {run ? "▶ " : ""}
                  {formatActivityText(selectedCollaborator)}
                </div>
              );
            })()}
            {selectedCollaborator.activeFile && (
              <div
                style={{
                  color: "var(--fg-muted, #a6adc8)",
                  fontSize: "10px",
                  marginTop: "2px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedCollaborator.activeFile}
              </div>
            )}
          </div>

          {(() => {
            // M59: derived collaborative-focus context — file, range, latest
            // callout message, and a UI-only state chip. Pure over the existing
            // presence + attention sources; no store.
            const fc = buildFocusContext(
              selectedCollaborator,
              attention,
              currentUserId,
              followingUserId ?? null,
            );
            if (!fc.range && !fc.attention?.message) return null;
            return (
              <div
                className={`collab-popover-focus focus-state-${fc.state}`}
                style={{
                  padding: "6px 8px",
                  background: "rgba(137, 180, 250, 0.08)",
                  borderRadius: "6px",
                  fontSize: "11px",
                  marginBottom: "10px",
                  border: "1px solid rgba(137, 180, 250, 0.18)",
                }}
              >
                <div
                  style={{
                    color: "var(--fg-muted, #a6adc8)",
                    fontSize: "10px",
                    marginBottom: "2px",
                  }}
                >
                  FOCUS
                </div>
                {fc.range && (
                  <div style={{ fontWeight: 500 }}>
                    {fc.range.startLine === fc.range.endLine
                      ? `Line ${fc.range.startLine}`
                      : `Lines ${fc.range.startLine}–${fc.range.endLine}`}
                  </div>
                )}
                {fc.attention?.message && (
                  <div
                    style={{
                      color: "var(--fg-secondary, #bac2de)",
                      marginTop: "2px",
                    }}
                  >
                    📣 “{fc.attention.message}”
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ display: "flex", gap: "6px" }}>
            <button
              className="glass-btn glass-btn-primary"
              style={{
                flex: 1,
                padding: "5px",
                fontSize: "11px",
                justifyContent: "center",
              }}
              onClick={() => {
                onFollowCollaborator?.(selectedCollaborator);
                setSelectedCollaborator(null);
              }}
              title={`Follow ${displayLabel(selectedCollaborator)}'s editor and navigation`}
            >
              {followingUserId === selectedCollaborator.userId
                ? "Unfollow"
                : "Follow"}
            </button>
            {selectedCollaborator.activeFile && onJumpToCollaborator && (
              <button
                className="glass-btn"
                style={{
                  flex: 1,
                  padding: "5px",
                  fontSize: "11px",
                  justifyContent: "center",
                }}
                onClick={() => {
                  onJumpToCollaborator(selectedCollaborator);
                  setSelectedCollaborator(null);
                }}
                title={`Jump directly to ${selectedCollaborator.activeFile}`}
              >
                Jump to File
              </button>
            )}
          </div>
        </div>
      )}

      {/* DND Toggle & Self Status Button */}
      {onToggleDnd && (
        <button
          className={`glass-btn ${isDnd ? "dnd-active" : ""}`}
          onClick={() => onToggleDnd(!isDnd)}
          style={{
            padding: "4px 8px",
            fontSize: "11px",
            background: isDnd
              ? "rgba(203, 166, 247, 0.15)"
              : "rgba(255, 255, 255, 0.04)",
            color: isDnd ? "#cba6f7" : "var(--fg-muted, #a6adc8)",
            border: isDnd
              ? "1px solid rgba(203, 166, 247, 0.4)"
              : "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            alignItems: "center",
            gap: "5px",
          }}
          title={
            isDnd
              ? "Do Not Disturb active (Click to disable)"
              : "Set Do Not Disturb"
          }
          aria-label={
            isDnd ? "Disable Do Not Disturb" : "Enable Do Not Disturb"
          }
          aria-pressed={isDnd}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: isDnd ? "#cba6f7" : "#a6e3a1",
            }}
          />
          <span>{isDnd ? "DND" : "Online"}</span>
        </button>
      )}

      {/* Share / Invite Trigger Button */}
      {onOpenShareModal && (
        <button
          className="glass-btn"
          onClick={onOpenShareModal}
          style={{
            padding: "4px 10px",
            fontSize: "11px",
            background: "rgba(137, 180, 250, 0.1)",
            color: "#89b4fa",
            border: "1px solid rgba(137, 180, 250, 0.3)",
            display: "flex",
            alignItems: "center",
            gap: "5px",
          }}
          title="Share Project & Manage Collaborators"
          aria-label="Share Project & Manage Collaborators"
        >
          <IconUsers size={12} />
          <span>Share</span>
        </button>
      )}
    </div>
  );
}
