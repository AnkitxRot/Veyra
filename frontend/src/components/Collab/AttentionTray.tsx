import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AttentionEvent } from "../../collab/attention";
import type { CommentMentionWire } from "../../types";

export interface AttentionTrayProps {
  /** The full IDE attention list (points, callouts, requests). */
  events: AttentionEvent[];
  currentUserId: number;
  /** Brief "too many pending requests" flag, cleared by the IDE after ~4s. */
  rateLimited: boolean;
  onNavigate: (e: AttentionEvent) => void;
  onDismiss: (id: string, acted?: boolean) => void;
  /** M59: step into the requester's context AND follow them. */
  onFollow?: (e: AttentionEvent) => void;
  /** M61-A: comment mention pings for "Attention & Mentions". */
  mentionCards?: CommentMentionWire[];
  onMentionGoTo?: (m: CommentMentionWire) => void;
  onMentionDismiss?: (commentId: string) => void;
}

const MAX_VISIBLE = 3;
const SENT_CONFIRM_MS = 4000;

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function rangeLabel(e: AttentionEvent): string {
  const { startLine, endLine } = e.range;
  return startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`;
}

/**
 * M58: bottom-right, non-modal stack of incoming targeted-request cards plus a
 * muted "✓ Sent" confirmation for requests this user authored. Not a generic
 * notification framework — points and callouts render in the editor, not here.
 */
export default function AttentionTray({
  events,
  currentUserId,
  rateLimited,
  onNavigate,
  onDismiss,
  onFollow,
  mentionCards = [],
  onMentionGoTo,
  onMentionDismiss,
}: AttentionTrayProps) {
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  // Per-id "sent" confirmations that self-hide.
  const [visibleSent, setVisibleSent] = useState<Set<string>>(new Set());
  const sentTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      setFocused(true);
      if (t) clearTimeout(t);
      t = setTimeout(() => setFocused(false), 1500);
    };
    document.addEventListener("ide-focus-attention-tray", onFocus);
    return () => {
      document.removeEventListener("ide-focus-attention-tray", onFocus);
      if (t) clearTimeout(t);
    };
  }, []);

  const incoming = useMemo(
    () =>
      events
        .filter(
          (e) =>
            e.kind === "request" &&
            e.targetUserId === currentUserId &&
            e.author.userId !== currentUserId,
        )
        .sort((a, b) => b.createdAt - a.createdAt),
    [events, currentUserId],
  );

  const sent = useMemo(
    () =>
      events.filter(
        (e) => e.kind === "request" && e.author.userId === currentUserId,
      ),
    [events, currentUserId],
  );

  useEffect(() => {
    const timers = sentTimers.current;
    for (const e of sent) {
      if (timers.has(e.id)) continue;
      setVisibleSent((prev) => new Set(prev).add(e.id));
      const t = setTimeout(() => {
        setVisibleSent((prev) => {
          const next = new Set(prev);
          next.delete(e.id);
          return next;
        });
        timers.delete(e.id);
      }, SENT_CONFIRM_MS);
      timers.set(e.id, t);
    }
    // drop timers for sent events that vanished
    for (const [id, t] of timers) {
      if (!sent.some((e) => e.id === id)) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [sent]);

  const activeSent = sent.filter((e) => visibleSent.has(e.id));

  const hasMentions = mentionCards.length > 0;

  if (incoming.length === 0 && activeSent.length === 0 && !rateLimited && !hasMentions) {
    return null;
  }

  const visible = expanded ? incoming : incoming.slice(0, MAX_VISIBLE);
  const hiddenCount = incoming.length - visible.length;

  return (
    <div
      className={`attention-tray${focused ? " is-focused" : ""}`}
      role="region"
      aria-label="Attention requests"
    >
      {rateLimited && (
        <div className="attention-tray-banner" role="status">
          Too many pending requests — wait a moment.
        </div>
      )}

      {visible.map((e) => (
        <div className="attention-tray-card" key={e.id}>
          <div className="attention-tray-head">
            <span
              className="attention-tray-dot"
              style={{ background: e.author.color }}
              aria-hidden="true"
            />
            <span className="attention-tray-title">
              📣 {e.author.username} wants your attention
            </span>
          </div>
          <div className="attention-tray-loc">
            {basename(e.file)} · {rangeLabel(e)}
          </div>
          {e.message && (
            <div className="attention-tray-msg">{e.message}</div>
          )}
          <div className="attention-tray-actions">
            <button
              type="button"
              onClick={() => {
                onNavigate(e);
                onDismiss(e.id, true);
              }}
            >
              Go there
            </button>
            {onFollow && (
              <button
                type="button"
                className="attention-tray-follow"
                onClick={() => onFollow(e)}
              >
                Follow
              </button>
            )}
            <button type="button" onClick={() => onDismiss(e.id, undefined)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {hiddenCount > 0 && !expanded && (
        <button
          type="button"
          className="attention-tray-more"
          onClick={() => setExpanded(true)}
        >
          +{hiddenCount} earlier
        </button>
      )}

      {activeSent.map((e) => (
        <div className="attention-tray-sent" key={`sent-${e.id}`}>
          ✓ Sent{e.message ? ` — "${e.message}"` : ""}
        </div>
      ))}

      {hasMentions && (
        <div className="attention-tray-section">
          <div className="attention-tray-section-title">💬 Mentions</div>
          {mentionCards.map((m) => (
            <div className="mention-card" key={m.commentId}>
              <span>
                💬 {m.author.username} mentioned you — {m.filePath.split("/").pop()} L{m.line}
              </span>
              {m.preview && (
                <div className="mention-card-text">
                  "{m.preview.slice(0, 100)}"
                </div>
              )}
              <div className="mention-card-actions">
                {onMentionGoTo && (
                  <button type="button" onClick={() => onMentionGoTo(m)}>
                    Go to comment
                  </button>
                )}
                {onMentionDismiss && (
                  <button
                    type="button"
                    className="mention-card-dismiss"
                    onClick={() => onMentionDismiss(m.commentId)}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
