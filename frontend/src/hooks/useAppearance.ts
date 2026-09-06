import { useEffect, useState } from "react";

// M69 — the single resolved-appearance source.
//
// The typed `theme` user preference ("system" | "dark" | "light") is turned
// here into an effective `resolvedTheme` ("dark" | "light"), which is stamped
// onto `<html data-theme>` (the existing CSS-variable architecture keys the
// light palette off `[data-theme="light"]`) and `<html style="color-scheme">`.
//
// `prefers-color-scheme` is consulted ONLY while the preference is "system",
// via exactly one media-query listener that is removed on unmount or when the
// preference changes. An explicit "dark" / "light" ignores the OS entirely.
//
// One hook, one listener — no scattered `matchMedia` calls or per-component
// theme conditionals. The persisted preference is authoritative; this never
// touches localStorage.

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Pure: the effective theme for a preference + the current OS light flag. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean,
): ResolvedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemPrefersLight ? "light" : "dark";
}

function readSystemPrefersLight(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // No media-query support → assume the historical dark default.
    return false;
  }
  try {
    return window.matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

export interface UseAppearance {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
}

export function useAppearance(preference: ThemePreference): UseAppearance {
  const [systemPrefersLight, setSystemPrefersLight] = useState<boolean>(
    readSystemPrefersLight,
  );

  // Follow the OS ONLY in system mode. The listener lifetime is bounded by
  // this effect: it is removed when `preference` changes away from "system"
  // and on unmount, so there is never a leaked or duplicate listener.
  useEffect(() => {
    if (preference !== "system") return;
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mql = window.matchMedia(LIGHT_QUERY);
    // Resync in case the OS flipped between the initial read and this effect.
    setSystemPrefersLight(mql.matches);
    const onChange = (e: MediaQueryListEvent) =>
      setSystemPrefersLight(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [preference]);

  const resolvedTheme = resolveTheme(preference, systemPrefersLight);

  // Reflect the resolved theme onto the document root. No cleanup — the next
  // value overwrites; a lingering stamp after unmount is harmless and the
  // next mount re-asserts immediately.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  return { preference, resolvedTheme };
}
