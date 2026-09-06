import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  useAppearance,
  resolveTheme,
} from "../src/hooks/useAppearance";

// M69 — one resolved-appearance source. `useAppearance(preference)` turns the
// typed theme preference into `{ preference, resolvedTheme }`, stamps the
// resolved theme onto <html data-theme>, and — only while the preference is
// "system" — follows `prefers-color-scheme` with exactly one media-query
// listener that is cleaned up on unmount / preference change.

/** Controllable `window.matchMedia` fake — jsdom has none. */
function installMatchMedia(initialLight: boolean) {
  const state = { light: initialLight };
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    get matches() {
      return state.light;
    },
    media: "(prefers-color-scheme: light)",
    addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    // legacy API — not used by the hook, present for completeness
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    dispatchEvent: () => true,
  };
  (window as any).matchMedia = vi.fn(() => mql);
  return {
    listenerCount: () => listeners.size,
    setLight(v: boolean) {
      state.light = v;
      act(() => {
        for (const cb of listeners) cb({ matches: v } as MediaQueryListEvent);
      });
    },
  };
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
});
afterEach(() => {
  cleanup();
  delete (window as any).matchMedia;
});

describe("resolveTheme", () => {
  it("pins the theme for an explicit preference and follows the system flag otherwise", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("light");
  });
});

describe("useAppearance", () => {
  it("resolves an explicit dark preference and stamps <html data-theme>", () => {
    installMatchMedia(true); // OS is light — must be ignored
    const { result } = renderHook(() => useAppearance("dark"));
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("resolves an explicit light preference", () => {
    installMatchMedia(false); // OS is dark — must be ignored
    const { result } = renderHook(() => useAppearance("light"));
    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resolves system to dark when the OS prefers dark", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useAppearance("system"));
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves system to light when the OS prefers light", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useAppearance("system"));
    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows a live prefers-color-scheme change while in system mode", () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useAppearance("system"));
    expect(result.current.resolvedTheme).toBe("dark");

    mm.setLight(true);
    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    mm.setLight(false);
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores a prefers-color-scheme change under an explicit dark preference", () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useAppearance("dark"));
    mm.setLight(true);
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores a prefers-color-scheme change under an explicit light preference", () => {
    const mm = installMatchMedia(true);
    const { result } = renderHook(() => useAppearance("light"));
    mm.setLight(false);
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("registers a media-query listener only while the preference is system", () => {
    const mm = installMatchMedia(false);
    const { rerender } = renderHook(
      ({ p }: { p: "system" | "dark" | "light" }) => useAppearance(p),
      { initialProps: { p: "system" as "system" | "dark" | "light" } },
    );
    expect(mm.listenerCount()).toBe(1);

    rerender({ p: "dark" });
    expect(mm.listenerCount()).toBe(0);

    rerender({ p: "system" });
    expect(mm.listenerCount()).toBe(1); // exactly one, not two

    rerender({ p: "light" });
    expect(mm.listenerCount()).toBe(0);
  });

  it("removes the media-query listener on unmount", () => {
    const mm = installMatchMedia(false);
    const { unmount } = renderHook(() => useAppearance("system"));
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  it("does not throw when window.matchMedia is unavailable", () => {
    delete (window as any).matchMedia;
    const { result } = renderHook(() => useAppearance("system"));
    // no matchMedia → treat the OS as dark (the historical default)
    expect(result.current.resolvedTheme).toBe("dark");
  });
});
