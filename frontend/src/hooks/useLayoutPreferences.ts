import { useCallback, useEffect, useRef, useState } from "react";

// M67 — persistent IDE layout preferences.
//
// The four genuinely user-scoped IDE panel-layout dimensions (sidebar width,
// bottom-panel height, sidebar hidden, bottom-panel collapsed) were throwaway
// `IDE.tsx` component state, reset on every reload. They now live in the typed
// `user_preferences` store. This hook owns their local state plus the
// persistence policy:
//
//   - widths update locally on every drag mousemove and persist **once**, on
//     drag end (`persistSidebarWidth` / `persistBottomHeight`);
//   - the collapsed / hidden toggles update optimistically and persist through
//     the same path immediately, but only when the value actually changes;
//   - nothing persists until the server preferences have hydrated the hook,
//     so the brief pre-load window never writes defaults back over a real
//     stored layout.
//
// The bounds mirror the server's (`backend/src/auth/preferences.ts`
// `LAYOUT_BOUNDS`) and the pre-existing drag clamps in `IDE.tsx`.

export const LAYOUT_BOUNDS = {
  sidebarWidth: { min: 180, max: 500, default: 250 },
  bottomHeight: { min: 120, max: 600, default: 260 },
} as const;

export interface LayoutPreferences {
  sidebarWidth: number;
  bottomHeight: number;
  sidebarHidden: boolean;
  bottomCollapsed: boolean;
}

type SetBool = boolean | ((prev: boolean) => boolean);

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(n)));

export const clampSidebarWidth = (n: number): number =>
  clamp(n, LAYOUT_BOUNDS.sidebarWidth.min, LAYOUT_BOUNDS.sidebarWidth.max);

export const clampBottomHeight = (n: number): number =>
  clamp(n, LAYOUT_BOUNDS.bottomHeight.min, LAYOUT_BOUNDS.bottomHeight.max);

export interface UseLayoutPreferences {
  sidebarWidth: number;
  bottomHeight: number;
  isSidebarHidden: boolean;
  isBottomCollapsed: boolean;
  /** Local-only width update — used on every drag mousemove, never persists. */
  setSidebarWidth: (n: number) => void;
  setBottomHeight: (n: number) => void;
  /** Persist the current width once, on drag end (clamped). */
  persistSidebarWidth: () => void;
  persistBottomHeight: () => void;
  /** Optimistic toggle setters — persist the new value when it changes. */
  setIsSidebarHidden: (v: SetBool) => void;
  setIsBottomCollapsed: (v: SetBool) => void;
}

/**
 * @param loaded  the layout slice of the server preferences, or `null` until
 *                the `GET /api/auth/preferences` call resolves.
 * @param persist fire-and-forget partial preference write (the caller wires
 *                this to `handleUpdatePreferences`, keeping its existing —
 *                silent — failure handling).
 */
export function useLayoutPreferences(
  loaded: LayoutPreferences | null,
  persist: (patch: Partial<LayoutPreferences>) => void | Promise<unknown>,
): UseLayoutPreferences {
  const [sidebarWidth, setSidebarWidthState] = useState<number>(
    LAYOUT_BOUNDS.sidebarWidth.default,
  );
  const [bottomHeight, setBottomHeightState] = useState<number>(
    LAYOUT_BOUNDS.bottomHeight.default,
  );
  const [isSidebarHidden, setSidebarHiddenState] = useState(false);
  const [isBottomCollapsed, setBottomCollapsedState] = useState(false);

  const hydratedRef = useRef(false);

  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const bottomHeightRef = useRef(bottomHeight);
  bottomHeightRef.current = bottomHeight;
  const sidebarHiddenRef = useRef(isSidebarHidden);
  sidebarHiddenRef.current = isSidebarHidden;
  const bottomCollapsedRef = useRef(isBottomCollapsed);
  bottomCollapsedRef.current = isBottomCollapsed;

  const persistRef = useRef(persist);
  persistRef.current = persist;

  // One-time hydration from the server preferences.
  useEffect(() => {
    if (!loaded || hydratedRef.current) return;
    hydratedRef.current = true;
    setSidebarWidthState(clampSidebarWidth(loaded.sidebarWidth));
    setBottomHeightState(clampBottomHeight(loaded.bottomHeight));
    setSidebarHiddenState(loaded.sidebarHidden);
    setBottomCollapsedState(loaded.bottomCollapsed);
  }, [loaded]);

  const setSidebarWidth = useCallback((n: number) => {
    setSidebarWidthState(n);
  }, []);
  const setBottomHeight = useCallback((n: number) => {
    setBottomHeightState(n);
  }, []);

  const persistSidebarWidth = useCallback(() => {
    if (!hydratedRef.current) return;
    const clamped = clampSidebarWidth(sidebarWidthRef.current);
    if (clamped !== sidebarWidthRef.current) setSidebarWidthState(clamped);
    persistRef.current({ sidebarWidth: clamped });
  }, []);

  const persistBottomHeight = useCallback(() => {
    if (!hydratedRef.current) return;
    const clamped = clampBottomHeight(bottomHeightRef.current);
    if (clamped !== bottomHeightRef.current) setBottomHeightState(clamped);
    persistRef.current({ bottomHeight: clamped });
  }, []);

  const setIsSidebarHidden = useCallback((v: SetBool) => {
    const prev = sidebarHiddenRef.current;
    const next = typeof v === "function" ? v(prev) : v;
    setSidebarHiddenState(next);
    if (next !== prev && hydratedRef.current) {
      persistRef.current({ sidebarHidden: next });
    }
  }, []);

  const setIsBottomCollapsed = useCallback((v: SetBool) => {
    const prev = bottomCollapsedRef.current;
    const next = typeof v === "function" ? v(prev) : v;
    setBottomCollapsedState(next);
    if (next !== prev && hydratedRef.current) {
      persistRef.current({ bottomCollapsed: next });
    }
  }, []);

  return {
    sidebarWidth,
    bottomHeight,
    isSidebarHidden,
    isBottomCollapsed,
    setSidebarWidth,
    setBottomHeight,
    persistSidebarWidth,
    persistBottomHeight,
    setIsSidebarHidden,
    setIsBottomCollapsed,
  };
}
