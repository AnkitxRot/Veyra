import React from "react";
import type { Notice } from "../../hooks/useNotices";
import { IconClose } from "./Icons";

/**
 * M64 — shared renderer for `surface: "stack"` notices. Fixed bottom-centre,
 * newest at the bottom. Presentation only: lifecycle (ids, TTL, dedupe,
 * cleanup) belongs to useNotices.
 *
 * Persistent notices (ttl === null) are never hidden by the visible cap;
 * transient notices fill the remaining slots, newest first.
 */
export interface NoticeStackProps {
  /** The caller's `surface === "stack"` slice, in insertion order. */
  notices: Notice[];
  onDismiss: (id: string) => void;
  /** Max rows rendered before older transient notices collapse to "+N more". */
  max?: number;
}

const DEFAULT_MAX = 3;

export default function NoticeStack({
  notices,
  onDismiss,
  max = DEFAULT_MAX,
}: NoticeStackProps) {
  if (notices.length === 0) return null;

  const transient = notices.filter((n) => n.ttl !== null);
  const persistentCount = notices.length - transient.length;
  const transientSlots = Math.max(0, max - persistentCount);
  const shownTransient = new Set(
    transient
      .slice(Math.max(0, transient.length - transientSlots))
      .map((n) => n.id),
  );
  const shown = notices.filter(
    (n) => n.ttl === null || shownTransient.has(n.id),
  );
  const hiddenCount = notices.length - shown.length;

  return (
    <div className="notice-stack" role="region" aria-label="Notifications">
      {shown.map((n) => (
        <div
          key={n.id}
          className={`notice notice-${n.kind}`}
          role={n.role}
          aria-live={n.kind === "error" ? "assertive" : "polite"}
        >
          <span className="notice-text">{n.text}</span>
          {n.actions?.map((a) => (
            <button
              key={a.label}
              type="button"
              className="notice-action"
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
          <button
            type="button"
            className="notice-dismiss"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(n.id)}
          >
            <IconClose size={11} />
          </button>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="notice-more">+{hiddenCount} more</div>
      )}
    </div>
  );
}
