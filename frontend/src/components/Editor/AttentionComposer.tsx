import React, { useEffect, useRef, useState } from "react";
import { ATTENTION_MAX_MESSAGE_LEN } from "../../collab/attention";

export interface AttentionComposerCollaborator {
  userId: number;
  name: string;
  color: string;
}

export interface AttentionComposerProps {
  mode: "callout" | "comeLook";
  /** px offset within the editor container. */
  anchorTop: number;
  anchorLeft: number;
  /** For "comeLook": connected collaborators, excluding self. */
  collaborators: AttentionComposerCollaborator[];
  onSubmit: (message: string, targetUserId?: number) => void;
  onCancel: () => void;
}

/**
 * M58: a small, non-modal message input anchored near the current selection.
 * "Call out" needs a message; "Come look" needs a target then a message.
 * Enter submits, Esc cancels. No backdrop, no focus trap.
 */
export default function AttentionComposer({
  mode,
  anchorTop,
  anchorLeft,
  collaborators,
  onSubmit,
  onCancel,
}: AttentionComposerProps) {
  const [message, setMessage] = useState("");
  const [targetUserId, setTargetUserId] = useState<number | null>(
    mode === "comeLook" && collaborators.length === 1
      ? collaborators[0].userId
      : null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  const needsTarget = mode === "comeLook" && targetUserId == null;

  useEffect(() => {
    if (!needsTarget) inputRef.current?.focus();
  }, [needsTarget]);

  const submit = () => {
    const trimmed = message.trim();
    if (!trimmed && mode === "callout") return;
    if (mode === "comeLook" && targetUserId == null) return;
    onSubmit(trimmed, targetUserId ?? undefined);
  };

  return (
    <div
      className="attention-composer"
      style={{ top: anchorTop, left: anchorLeft }}
      role="dialog"
      aria-label={mode === "callout" ? "Call out selection" : "Come look here"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {needsTarget ? (
        <div className="attention-composer-picker">
          <span className="attention-composer-label">Come look — who?</span>
          {collaborators.map((cb) => (
            <button
              key={cb.userId}
              type="button"
              onClick={() => setTargetUserId(cb.userId)}
            >
              <span
                className="attention-composer-dot"
                style={{ background: cb.color }}
                aria-hidden="true"
              />
              {cb.name}
            </button>
          ))}
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="attention-composer-input">
          <input
            ref={inputRef}
            type="text"
            maxLength={ATTENTION_MAX_MESSAGE_LEN}
            placeholder={
              mode === "callout"
                ? "Call out — what should they see?"
                : "Come look — add a message (optional)"
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            aria-label="Attention message"
          />
          <button type="button" onClick={submit}>
            Send
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
