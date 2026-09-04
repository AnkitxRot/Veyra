import React, { useRef, useState } from "react";
import type { CommentDTO, CommentThreadDTO } from "../../types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { mentionText } from "./mentionText";
import CommentComposer, { type ComposerMember } from "./CommentComposer";

export const REACTION_EMOJI = [
  "\u{1F44D}",
  "\u{1F44E}",
  "\u{1F389}",
  "\u{1F440}",
  "\u{2764}\u{FE0F}",
  "\u{1F680}",
] as const;

export interface CommentThreadProps {
  thread: CommentThreadDTO;
  currentUserId: number;
  members: ComposerMember[];
  projectOwnerId?: number;
  onReply: (input: { body: string; mentions: number[] }) => void;
  onEdit: (commentId: string, input: { body: string; mentions: number[] }) => void;
  onDelete: (commentId: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onReact: (commentId: string, emoji: string) => void;
  onUnreact: (commentId: string, emoji: string) => void;
  onClose: () => void;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export default function CommentThread({
  thread,
  currentUserId,
  members,
  projectOwnerId,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReopen,
  onReact,
  onUnreact,
  onClose,
}: CommentThreadProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  // M62: username stays the mention token + stable identity; displayName is
  // presentation only. The @username suffix shows only when it differs.
  const memberOf = (userId: number) => members.find((m) => m.userId === userId);
  const usernameOf = (userId: number) =>
    memberOf(userId)?.username ?? `user ${userId}`;
  const labelOf = (userId: number) => {
    const d = memberOf(userId)?.displayName;
    return typeof d === "string" && d.trim().length > 0 ? d : usernameOf(userId);
  };
  const knownUsernames = new Set(members.map((m) => m.username));

  const rows: CommentDTO[] = [thread.root, ...thread.replies];
  const resolved = thread.resolvedAt != null;

  const renderComment = (c: CommentDTO, isRoot: boolean) => {
    const authorUsername = usernameOf(c.authorId);
    const authorLabel = labelOf(c.authorId);
    const showAuthorHandle = authorLabel !== authorUsername;
    const canEdit = c.authorId === currentUserId && c.deletedAt == null;
    const canDelete =
      c.deletedAt == null &&
      (c.authorId === currentUserId || currentUserId === projectOwnerId);
    if (editingId === c.id) {
      return (
        <li key={c.id} className="comment-row is-editing">
          <CommentComposer
            members={members}
            value={c.body}
            autoFocus
            submitLabel="Save"
            onSubmit={(input) => {
              onEdit(c.id, input);
              setEditingId(null);
            }}
          />
          <button
            type="button"
            className="glass-btn glass-btn-ghost"
            onClick={() => setEditingId(null)}
          >
            Cancel
          </button>
        </li>
      );
    }
    return (
      <li key={c.id} className="comment-row" data-comment-id={c.id} tabIndex={-1}>
        <div className="comment-row-head">
          <span className="c-avatar" aria-hidden="true">
            {initials(authorUsername)}
          </span>
          <span className="comment-author">{authorLabel}</span>
          {showAuthorHandle && (
            <span className="comment-author-handle">@{authorUsername}</span>
          )}
          <span className="comment-time">{relTime(c.createdAt)}</span>
          {c.editedAt && <span className="comment-flag">edited</span>}
          {c.deletedAt && <span className="comment-flag">deleted</span>}
        </div>
        <div className="comment-body">
          {c.deletedAt ? (
            <em className="comment-deleted-placeholder">comment deleted</em>
          ) : (
            mentionText(c.body, knownUsernames)
          )}
        </div>
        {c.deletedAt == null && (
          <div className="comment-reactions">
            {c.reactions.map((r) => {
              const mine = r.userIds.includes(currentUserId);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  className={
                    mine ? "reaction-chip is-mine" : "reaction-chip"
                  }
                  onClick={() =>
                    mine
                      ? onUnreact(c.id, r.emoji)
                      : onReact(c.id, r.emoji)
                  }
                >
                  {r.emoji} {r.userIds.length}
                </button>
              );
            })}
            <button
              type="button"
              className="reaction-add"
              aria-label="Add reaction"
              onClick={() =>
                setPickerFor(pickerFor === c.id ? null : c.id)
              }
            >
              +
            </button>
            {pickerFor === c.id && (
              <span className="reaction-picker" role="menu">
                {REACTION_EMOJI.map((em) => (
                  <button
                    key={em}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onReact(c.id, em);
                      setPickerFor(null);
                    }}
                  >
                    {em}
                  </button>
                ))}
              </span>
            )}
          </div>
        )}
        {(canEdit || canDelete) && (
          <div className="comment-row-actions">
            {canEdit && (
              <button
                type="button"
                className="glass-btn glass-btn-ghost"
                onClick={() => setEditingId(c.id)}
              >
                Edit
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="glass-btn glass-btn-ghost"
                onClick={() => onDelete(c.id)}
              >
                Delete
              </button>
            )}
          </div>
        )}
        {isRoot && thread.anchorStatus === "stale" && (
          <div className="comment-anchor-warning" role="note">
            ⚠ Original code location changed
          </div>
        )}
      </li>
    );
  };

  return (
    <div
      className="comment-thread glass-floating"
      role="dialog"
      aria-label="Comment thread"
      ref={ref}
    >
      <div className="comment-thread-head">
        <span>{resolved ? "Resolved thread" : "Comment thread"}</span>
        <div>
          {resolved ? (
            <button
              type="button"
              className="glass-btn glass-btn-ghost"
              onClick={onReopen}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="glass-btn glass-btn-ghost"
              onClick={onResolve}
            >
              Resolve
            </button>
          )}
          <button
            type="button"
            className="glass-btn glass-btn-icon"
            aria-label="Close thread"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      <ul className="comment-thread-list">
        {rows.map((c, i) => renderComment(c, i === 0))}
      </ul>

      {!resolved && (
        <CommentComposer
          members={members}
          placeholder="Reply…"
          submitLabel="Reply"
          onSubmit={onReply}
        />
      )}
    </div>
  );
}
