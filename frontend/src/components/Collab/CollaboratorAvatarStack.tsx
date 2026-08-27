import React, { useState, useRef, useEffect } from "react";
import type {
  CollaboratorPresence,
  CollabConnectionStatus,
  AvailabilityStatus,
} from "../../collab/client";
import type { RunStatusEntry } from "../../types";
import { IconUsers, IconSparkles } from "../common/Icons";

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
}

// M54: a collaborator's most relevant run — an active run wins over a
// lingering terminal one; among terminal ones the most recent.
function pickRunForUser(
  entries: RunStatusEntry[],
  userId: number,
): RunStatusEntry | null {
  const mine = entries.filter((e) => e.userId === userId);
  if (mine.length === 0) return null;
  const running = mine.find((e) => e.state === "running");
  if (running) return running;
  return mine.reduce((a, b) =>
    (b.endedAt ?? b.startedAt) > (a.endedAt ?? a.startedAt) ? b : a,
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatRunText(entry: RunStatusEntry, now: number): string {
  const base = entry.file ? entry.file.split("/").pop() : null;
  if (entry.state === "running") {
    return `Running ${base ?? "code"}${entry.language ? ` · ${entry.language}` : ""} · ${formatElapsed(now - entry.startedAt)}`;
  }
  const label = base ?? "run";
  if (entry.state === "success")
    return `${label} exited ${entry.exitCode ?? 0}`;
  if (entry.state === "failed") return `${label} failed`;
  return `${label} stopped`;
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
          <span className="collab-avatar-status idle" title="Idle (Away)" />
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

      {/* Collaborator Avatars Stack */}
      {otherCollaborators.length > 0 && (
        <div
          style={{ display: "flex", alignItems: "center", marginLeft: "4px" }}
          role="group"
          aria-label="Active Collaborators"
        >
          {otherCollaborators.map((c) => {
            const initials = c.name.slice(0, 2).toUpperCase();
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
                    background: c.color,
                    color: "#11131c",
                    fontWeight: 700,
                    fontSize: "10px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
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
                  title={`${c.name} (${(c.role || "collaborator").toUpperCase()}) — ${activitySummary} [${(c.status || "online").toUpperCase()}]`}
                  aria-label={`Collaborator ${c.name}, ${c.role || "collaborator"}, ${c.status || "online"}. ${activitySummary}.`}
                >
                  {initials}
                </button>
                {renderStatusDot(c.status)}
                {isRunningNow && (
                  <span
                    aria-hidden="true"
                    title={`${c.name} — ${activitySummary}`}
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
          aria-label={`Collaborator Details: ${selectedCollaborator.name}`}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                background: selectedCollaborator.color,
                color: "#11131c",
                fontWeight: 700,
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {selectedCollaborator.name.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{ display: "flex", alignItems: "center", gap: "6px" }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: "12px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {selectedCollaborator.name}
                </span>
                <span
                  style={{
                    fontSize: "9px",
                    textTransform: "uppercase",
                    padding: "1px 4px",
                    borderRadius: "4px",
                    background: "rgba(255,255,255,0.08)",
                    color: "var(--fg-muted, #a6adc8)",
                    fontWeight: 600,
                  }}
                >
                  {selectedCollaborator.role || "collaborator"}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "10.5px",
                  color: "var(--fg-muted, #a6adc8)",
                  marginTop: "2px",
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background:
                      selectedCollaborator.status === "online"
                        ? "#a6e3a1"
                        : selectedCollaborator.status === "idle"
                          ? "#fab387"
                          : "#cba6f7",
                  }}
                />
                <span style={{ textTransform: "capitalize" }}>
                  {selectedCollaborator.status}
                </span>
              </div>
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
              title={`Follow ${selectedCollaborator.name}'s editor and navigation`}
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
