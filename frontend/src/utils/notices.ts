import type { NoticeInput } from "../hooks/useNotices";

/**
 * M75 — raise a transient notice from a component that is not the notice
 * owner.
 *
 * `useNotices` lives once, in IDE.tsx. Components mounted under it (Sidebar,
 * Output, …) previously reported every async failure through a blocking
 * `window.alert()` — a dated, event-loop-blocking dialog inconsistent with
 * the M64 notice system used everywhere IDE.tsx raises feedback itself.
 *
 * This bridges the gap with the same custom-DOM-event pattern the IDE
 * already uses for cross-component signalling (`ide-save`, `ide-run`,
 * `ide-install`, …): the caller dispatches `ide-notice` carrying a
 * `NoticeInput`, and IDE.tsx's single listener forwards it straight to
 * `notify()`. Lifecycle (id / TTL / dedupe / cleanup / eviction) stays
 * entirely inside `useNotices`.
 *
 * `CustomEvent.detail` is passed by reference within the same realm (no
 * structured clone), so `actions[].onClick` / `onExpire` callbacks survive.
 *
 * No-op when dispatched outside the IDE route (e.g. the standalone admin
 * dashboard), where nothing listens — callers there keep their own feedback.
 */
export const IDE_NOTICE_EVENT = "ide-notice";

export function emitNotice(input: NoticeInput): void {
  document.dispatchEvent(
    new CustomEvent(IDE_NOTICE_EVENT, { detail: input }),
  );
}

/** Convenience for the most common case: a transient error toast. */
export function emitErrorNotice(text: string): void {
  emitNotice({ kind: "error", text, ttl: 6000 });
}
