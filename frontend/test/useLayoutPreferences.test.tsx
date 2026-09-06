import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  useLayoutPreferences,
  LAYOUT_BOUNDS,
  clampSidebarWidth,
  clampBottomHeight,
  type LayoutPreferences,
} from "../src/hooks/useLayoutPreferences";

// M67 — the four user-scoped IDE layout dimensions move into the typed
// preference store. This hook owns their local state, one-time hydration from
// the loaded server preferences, and the persistence policy: widths persist
// once per completed drag gesture, toggles persist optimistically on change.

afterEach(cleanup);

const LOADED: LayoutPreferences = {
  sidebarWidth: 320,
  bottomHeight: 400,
  sidebarHidden: true,
  bottomCollapsed: false,
};

function setup(loaded: LayoutPreferences | null = null) {
  const persist = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(
    ({ l }: { l: LayoutPreferences | null }) =>
      useLayoutPreferences(l, persist),
    { initialProps: { l: loaded } },
  );
  return { persist, ...view };
}

describe("clamp helpers", () => {
  it("clamp + round to the shared bounds", () => {
    expect(clampSidebarWidth(50)).toBe(LAYOUT_BOUNDS.sidebarWidth.min);
    expect(clampSidebarWidth(9999)).toBe(LAYOUT_BOUNDS.sidebarWidth.max);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampBottomHeight(10)).toBe(LAYOUT_BOUNDS.bottomHeight.min);
    expect(clampBottomHeight(9999)).toBe(LAYOUT_BOUNDS.bottomHeight.max);
  });
});

describe("useLayoutPreferences — defaults & hydration", () => {
  it("starts at the in-memory defaults before the server preferences load", () => {
    const { result } = setup(null);
    expect(result.current.sidebarWidth).toBe(250);
    expect(result.current.bottomHeight).toBe(260);
    expect(result.current.isSidebarHidden).toBe(false);
    expect(result.current.isBottomCollapsed).toBe(false);
  });

  it("hydrates once when the loaded preferences arrive", () => {
    const { result, rerender } = setup(null);
    act(() => rerender({ l: LOADED }));
    expect(result.current.sidebarWidth).toBe(320);
    expect(result.current.bottomHeight).toBe(400);
    expect(result.current.isSidebarHidden).toBe(true);
    expect(result.current.isBottomCollapsed).toBe(false);
  });

  it("does not re-hydrate (or clobber a live edit) if loaded changes again", () => {
    const { result, rerender } = setup(null);
    act(() => rerender({ l: LOADED }));
    act(() => result.current.setSidebarWidth(280));
    act(() =>
      rerender({ l: { ...LOADED, sidebarWidth: 999 } as LayoutPreferences }),
    );
    expect(result.current.sidebarWidth).toBe(280);
  });

  it("clamps an out-of-range hydrated width", () => {
    const { result, rerender } = setup(null);
    act(() =>
      rerender({ l: { ...LOADED, sidebarWidth: 12345 } as LayoutPreferences }),
    );
    expect(result.current.sidebarWidth).toBe(LAYOUT_BOUNDS.sidebarWidth.max);
  });
});

describe("useLayoutPreferences — drag persistence", () => {
  it("local width updates during a drag do not persist", () => {
    const { result, rerender, persist } = setup(null);
    act(() => rerender({ l: LOADED }));
    act(() => {
      result.current.setSidebarWidth(300);
      result.current.setSidebarWidth(310);
      result.current.setSidebarWidth(322);
    });
    expect(result.current.sidebarWidth).toBe(322);
    expect(persist).not.toHaveBeenCalled();
  });

  it("persists exactly once, clamped, on drag end — regardless of mousemove count", () => {
    const { result, rerender, persist } = setup(null);
    act(() => rerender({ l: LOADED }));
    act(() => {
      for (let x = 300; x < 340; x++) result.current.setSidebarWidth(x);
    });
    act(() => result.current.persistSidebarWidth());
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ sidebarWidth: 339 });
  });

  it("persistBottomHeight clamps a below-min drag before persisting", () => {
    const { result, rerender, persist } = setup(null);
    act(() => rerender({ l: LOADED }));
    act(() => result.current.setBottomHeight(40));
    act(() => result.current.persistBottomHeight());
    expect(result.current.bottomHeight).toBe(LAYOUT_BOUNDS.bottomHeight.min);
    expect(persist).toHaveBeenCalledWith({
      bottomHeight: LAYOUT_BOUNDS.bottomHeight.min,
    });
  });

  it("does not persist a drag that ends before the preferences have loaded", () => {
    const { result, persist } = setup(null);
    act(() => {
      result.current.setSidebarWidth(300);
      result.current.persistSidebarWidth();
    });
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("useLayoutPreferences — toggle persistence", () => {
  it("toggling a collapsed panel updates optimistically and persists the new value", () => {
    const { result, rerender, persist } = setup(null);
    act(() => rerender({ l: LOADED }));
    act(() => result.current.setIsBottomCollapsed(true));
    expect(result.current.isBottomCollapsed).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ bottomCollapsed: true });
  });

  it("supports the functional-updater setter form", () => {
    const { result, rerender, persist } = setup(null);
    act(() => rerender({ l: LOADED }));
    act(() => result.current.setIsSidebarHidden((p) => !p)); // LOADED has true
    expect(result.current.isSidebarHidden).toBe(false);
    expect(persist).toHaveBeenCalledWith({ sidebarHidden: false });
  });

  it("a no-op set (same value) does not persist", () => {
    const { result, rerender, persist } = setup(null);
    act(() => rerender({ l: LOADED })); // bottomCollapsed already false
    act(() => result.current.setIsBottomCollapsed(false));
    expect(persist).not.toHaveBeenCalled();
  });

  it("a rejected persist does not roll back or corrupt local state", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("network"));
    const { result, rerender } = renderHook(
      ({ l }: { l: LayoutPreferences | null }) =>
        useLayoutPreferences(l, persist),
      { initialProps: { l: null as LayoutPreferences | null } },
    );
    act(() => rerender({ l: LOADED }));
    await act(async () => {
      result.current.setIsBottomCollapsed(true);
    });
    expect(result.current.isBottomCollapsed).toBe(true);
    expect(persist).toHaveBeenCalledWith({ bottomCollapsed: true });
  });

  it("does not persist a toggle before the preferences have loaded", () => {
    const { result, persist } = setup(null);
    act(() => result.current.setIsBottomCollapsed(true));
    expect(result.current.isBottomCollapsed).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });
});
