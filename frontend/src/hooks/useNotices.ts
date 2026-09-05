import { useCallback, useEffect, useRef, useState } from "react";

/**
 * M64 — one typed transient-notice mechanism for the IDE.
 *
 * This hook owns the *lifecycle* of every notice — stable id, TTL expiry,
 * explicit dismissal, dedupe/replacement, a bounded queue and deterministic
 * timer cleanup. It does NOT own presentation: callers filter `notices` by
 * `surface` and render each group where it belongs (NoticeStack for
 * "stack", the status bar for "statusbar", the editor region for "editor",
 * nothing for "headless" — a lifecycle-managed flag such as the attention
 * rate-limit signal).
 */

export type NoticeKind = "success" | "info" | "warning" | "error";

/**
 * Where the caller renders this notice. The hook treats this as opaque
 * metadata — it never inspects it — so presentation stays with the caller.
 */
export type NoticeSurface = "stack" | "statusbar" | "editor" | "headless";

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface NoticeInput {
  kind: NoticeKind;
  text: string;
  /** ms until auto-dismiss. Omit / null / 0 => persistent (explicit dismissal only). */
  ttl?: number | null;
  /** Defaults to "stack". */
  surface?: NoticeSurface;
  /** Stable key: notify() with a live key replaces that entry in place. */
  dedupeKey?: string;
  /** Contextual actions (e.g. a follow-left notice's Return / Stay). */
  actions?: NoticeAction[];
  /** Fired ONLY on TTL expiry — never on manual dismiss or dedupe-replace. */
  onExpire?: () => void;
  /** ARIA role override. Defaults to "alert" for errors, "status" otherwise. */
  role?: "status" | "alert";
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  ttl: number | null;
  surface: NoticeSurface;
  role: "status" | "alert";
  dedupeKey?: string;
  actions?: NoticeAction[];
  onExpire?: () => void;
}

export interface UseNotices {
  notices: Notice[];
  /** Add (or, with a live dedupeKey, replace) a notice. Returns the new id. */
  notify: (input: NoticeInput) => string;
  /** Remove by id. Does not fire onExpire. */
  dismiss: (id: string) => void;
  /** Remove the entry carrying this dedupeKey. Does not fire onExpire. */
  dismissKey: (dedupeKey: string) => void;
  hasKey: (dedupeKey: string) => boolean;
}

/**
 * Hard ceiling on retained notices. Bounds queue growth under notify spam;
 * eviction takes the oldest transient entry first and only falls back to the
 * oldest overall when every entry is persistent.
 */
export const MAX_NOTICES = 6;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `notice-${seq}`;
}

export function useNotices(): UseNotices {
  const [notices, setNotices] = useState<Notice[]>([]);
  // Kept in sync so an async timer callback can tell a live notice from one
  // that was already dismissed / replaced without reading stale closure state.
  const noticesRef = useRef<Notice[]>(notices);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    noticesRef.current = notices;
  }, [notices]);

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setNotices((prev) => prev.filter((n) => n.id !== id));
    },
    [clearTimer],
  );

  const dismissKey = useCallback(
    (dedupeKey: string) => {
      setNotices((prev) => {
        const found = prev.find((n) => n.dedupeKey === dedupeKey);
        if (!found) return prev;
        clearTimer(found.id);
        return prev.filter((n) => n.id !== found.id);
      });
    },
    [clearTimer],
  );

  const notify = useCallback(
    (input: NoticeInput): string => {
      const id = nextId();
      const ttl = input.ttl ?? null;
      const notice: Notice = {
        id,
        kind: input.kind,
        text: input.text,
        ttl,
        surface: input.surface ?? "stack",
        role: input.role ?? (input.kind === "error" ? "alert" : "status"),
        dedupeKey: input.dedupeKey,
        actions: input.actions,
        onExpire: input.onExpire,
      };

      setNotices((prev) => {
        let next = prev;
        if (input.dedupeKey) {
          const old = prev.find((n) => n.dedupeKey === input.dedupeKey);
          if (old) {
            clearTimer(old.id);
            next = next.filter((n) => n.id !== old.id);
          }
        }
        next = [...next, notice];
        if (next.length > MAX_NOTICES) {
          const oldestTransient = next.findIndex(
            (n) => n.ttl !== null && n.id !== id,
          );
          const victimIdx = oldestTransient >= 0 ? oldestTransient : 0;
          clearTimer(next[victimIdx].id);
          next = next.filter((_, i) => i !== victimIdx);
        }
        return next;
      });

      if (ttl !== null && ttl > 0) {
        const handle = setTimeout(() => {
          timersRef.current.delete(id);
          const live = noticesRef.current.find((n) => n.id === id);
          if (!live) return; // already dismissed / replaced / evicted
          setNotices((prev) => prev.filter((n) => n.id !== id));
          live.onExpire?.();
        }, ttl);
        timersRef.current.set(id, handle);
      }

      return id;
    },
    [clearTimer],
  );

  const hasKey = useCallback(
    (dedupeKey: string) => notices.some((n) => n.dedupeKey === dedupeKey),
    [notices],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => clearTimeout(handle));
      timers.clear();
    };
  }, []);

  return { notices, notify, dismiss, dismissKey, hasKey };
}
