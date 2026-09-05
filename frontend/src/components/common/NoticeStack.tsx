import React from "react";
import type { Notice } from "../../hooks/useNotices";
import { IconClose } from "./Icons";

/**
 * M64 — shared renderer for `surface: "stack"` notices. Fixed bottom-centre,
 * newest at the bottom. Presentation only: lifecycle (ids, TTL, dedupe,
 * cleanup) belongs to useNotices.
 *
 * The default view shows at most `max` rows. Persistent notices (ttl === null)
 * are prioritised over transient ones and are never *dropped* — anything that
 * does not fit collapses behind an expand control so every notice stays
 * reachable and dismissible.
 */
export interface NoticeStackProps {
  /** The caller's `surface === "stack"` slice, in insertion order. */
  notices: Notice[];
  onDismiss: (id: string) => void;
  /** Max rows in the collapsed view (default 3). */
  max?: number;
}

const DEFAULT_MAX = 3;

export default function NoticeStack({
  notices,
  onDismiss,
  max = DEFAULT_MAX,
}: NoticeStackProps) {
  const [expanded, setExpanded] = React.useState(false);

  if (notices.length === 0) {
    // reset the toggle so it doesn't linger for the next batch
    if (expanded) setExpanded(false);
    return null;
  }

  let visible: Notice[];
  if (expanded || notices.length <= max) {
    visible = notices;
  } else {
    const persistent = notices.filter((n) => n.ttl === null);
    const transient = notices.filter((n) => n.ttl !== null);
    const shownPersistent = persistent.slice(Math.max(0, persistent.length - max));
    const slots = Math.max(0, max - shownPersistent.length);
    const shownTransient = transient.slice(
      Math.max(0, transient.length - slots),
    );
    const shownIds = new Set(
      [...shownPersistent, ...shownTransient].map((n) => n.id),
    );
    visible = notices.filter((n) => shownIds.has(n.id));
  }
  const hiddenCount = notices.length - visible.length;

  return (
    <div className="notice-stack" role="region" aria-label="Notifications">
      {visible.map((n) => (
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
      {(hiddenCount > 0 || expanded) && notices.length > max && (
        <button
          type="button"
          className="notice-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `+${hiddenCount} more`}
        </button>
      )}
    </div>
  );
}
