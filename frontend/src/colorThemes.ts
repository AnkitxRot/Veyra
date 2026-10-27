import type { ITheme } from "@xterm/xterm";

/**
 * M106: one JSON palette drives the CSS-variable chrome, the Monaco theme and
 * the xterm theme. Built-ins live here; custom themes are validated imports.
 * "default" (no override) keeps the M69 dark/light/system behaviour.
 */
export interface Palette {
  bgDeep: string;
  bgBase: string;
  bgSurface: string;
  bgElevated: string;
  fg: string;
  fgMuted: string;
  accent: string;
  error: string;
  success: string;
  warning: string;
}

export interface ColorTheme {
  id: string;
  label: string;
  base: "dark" | "light";
  palette: Palette;
}

const P = (
  bgDeep: string,
  bgBase: string,
  bgSurface: string,
  bgElevated: string,
  fg: string,
  fgMuted: string,
  accent: string,
  error: string,
  success: string,
  warning: string,
): Palette => ({ bgDeep, bgBase, bgSurface, bgElevated, fg, fgMuted, accent, error, success, warning });

export const BUILTIN_THEMES: readonly ColorTheme[] = [
  { id: "catppuccin-frappe", label: "Catppuccin Frappe", base: "dark", palette: P("#232634", "#292c3c", "#303446", "#414559", "#c6d0f5", "#838ba7", "#8caaee", "#e78284", "#a6d189", "#e5c890") },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", base: "dark", palette: P("#181926", "#1e2030", "#24273a", "#363a4f", "#cad3f5", "#8087a2", "#8aadf4", "#ed8796", "#a6da95", "#eed49f") },
  { id: "catppuccin-latte", label: "Catppuccin Latte", base: "light", palette: P("#dce0e8", "#eff1f5", "#e6e9ef", "#ccd0da", "#4c4f69", "#6c6f85", "#1e66f5", "#d20f39", "#40a02b", "#df8e1d") },
  { id: "one-dark", label: "One Dark", base: "dark", palette: P("#1b1d23", "#21252b", "#282c34", "#2c313a", "#abb2bf", "#7f848e", "#61afef", "#e06c75", "#98c379", "#e5c07b") },
  { id: "solarized-dark", label: "Solarized Dark", base: "dark", palette: P("#00212b", "#002b36", "#073642", "#0d4553", "#93a1a1", "#657b83", "#268bd2", "#dc322f", "#859900", "#b58900") },
  { id: "solarized-light", label: "Solarized Light", base: "light", palette: P("#eee8d5", "#fdf6e3", "#f5efdc", "#e6dfc8", "#586e75", "#839496", "#268bd2", "#dc322f", "#859900", "#b58900") },
  { id: "github-dark", label: "GitHub Dark", base: "dark", palette: P("#010409", "#0d1117", "#161b22", "#21262d", "#e6edf3", "#8b949e", "#58a6ff", "#f85149", "#3fb950", "#d29922") },
  { id: "github-light", label: "GitHub Light", base: "light", palette: P("#eaeef2", "#ffffff", "#f6f8fa", "#eaeef2", "#1f2328", "#656d76", "#0969da", "#cf222e", "#1a7f37", "#9a6700") },
  { id: "high-contrast", label: "High Contrast", base: "dark", palette: P("#000000", "#000000", "#0a0a0a", "#1a1a1a", "#ffffff", "#cccccc", "#00e5ff", "#ff5555", "#50fa7b", "#ffff55") },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
const PALETTE_KEYS: (keyof Palette)[] = [
  "bgDeep",
  "bgBase",
  "bgSurface",
  "bgElevated",
  "fg",
  "fgMuted",
  "accent",
  "error",
  "success",
  "warning",
];

/** Validate an untrusted theme (import). Returns null when anything is off. */
export function parseColorTheme(raw: unknown): ColorTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(t.id)) return null;
  if (typeof t.label !== "string" || !t.label || t.label.length > 40) return null;
  if (t.base !== "dark" && t.base !== "light") return null;
  const p = t.palette as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;
  const palette = {} as Palette;
  for (const k of PALETTE_KEYS) {
    const v = p[k];
    if (typeof v !== "string" || !HEX.test(v)) return null;
    palette[k] = v;
  }
  return { id: t.id, label: t.label, base: t.base, palette };
}

const rgba = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

/** CSS custom properties overriding tokens.css for this theme. */
export function themeCssVars(t: ColorTheme): Record<string, string> {
  const p = t.palette;
  return {
    "--bg-deep": p.bgDeep,
    "--bg-base": p.bgBase,
    "--bg-surface": p.bgSurface,
    "--bg-surface-elevated": p.bgElevated,
    "--bg-surface-hover": p.bgElevated,
    "--glass-surface-1": rgba(p.bgBase, 0.72),
    "--glass-surface-2": rgba(p.bgSurface, 0.68),
    "--glass-surface-3": rgba(p.bgElevated, 0.82),
    "--glass-surface-floating": rgba(p.bgElevated, 0.92),
    "--glass-surface-modal": rgba(p.bgSurface, 0.95),
    "--glass-border": rgba(p.fg, 0.1),
    "--glass-border-light": rgba(p.fg, 0.16),
    "--glass-border-focus": rgba(p.accent, 0.5),
    "--accent": p.accent,
    "--accent-hover": p.accent,
    "--accent-subtle": rgba(p.accent, 0.14),
    "--accent-glow": rgba(p.accent, 0.28),
    "--success": p.success,
    "--warning": p.warning,
    "--error": p.error,
    "--fg-primary": p.fg,
    "--fg-secondary": p.fg,
    "--fg-muted": p.fgMuted,
    "--fg-subtle": p.fgMuted,
  };
}

export function monacoThemeData(t: ColorTheme) {
  const p = t.palette;
  return {
    base: (t.id === "high-contrast" ? "hc-black" : t.base === "light" ? "vs" : "vs-dark") as
      | "vs"
      | "vs-dark"
      | "hc-black",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": p.bgDeep,
      "editor.foreground": p.fg,
      "editorLineNumber.foreground": p.fgMuted,
      "editorCursor.foreground": p.accent,
      "editor.selectionBackground": rgba(p.accent, 0.3),
      "editor.lineHighlightBackground": rgba(p.bgElevated, 0.5),
    },
  };
}

export function terminalThemeFor(t: ColorTheme): ITheme {
  const p = t.palette;
  return {
    background: p.bgDeep,
    foreground: p.fg,
    cursor: p.accent,
    selectionBackground: rgba(p.accent, 0.3),
    red: p.error,
    green: p.success,
    yellow: p.warning,
    blue: p.accent,
  };
}

export const COLOR_THEME_EVENT = "ide-color-theme";
const KEY_ACTIVE = "veyra_color_theme";
const KEY_CUSTOM = "veyra_custom_themes";

export function loadCustomThemes(): ColorTheme[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY_CUSTOM) ?? "[]") as unknown[];
    return arr
      .map(parseColorTheme)
      .filter((t): t is ColorTheme => !!t && !BUILTIN_THEMES.some((b) => b.id === t.id));
  } catch {
    return [];
  }
}
export function saveCustomThemes(themes: ColorTheme[]): void {
  try {
    localStorage.setItem(KEY_CUSTOM, JSON.stringify(themes));
  } catch {
    /* storage unavailable */
  }
}
export function allThemes(): ColorTheme[] {
  return [...BUILTIN_THEMES, ...loadCustomThemes()];
}
export function loadActiveThemeId(): string | null {
  try {
    const id = localStorage.getItem(KEY_ACTIVE);
    return id && allThemes().some((t) => t.id === id) ? id : null;
  } catch {
    return null;
  }
}
export function saveActiveThemeId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY_ACTIVE, id);
    else localStorage.removeItem(KEY_ACTIVE);
  } catch {
    /* storage unavailable */
  }
}

/** Active theme (module state kept in sync by useColorTheme). */
let active: ColorTheme | null = null;
export const getActiveTheme = () => active;
export const setActiveTheme = (t: ColorTheme | null) => {
  active = t;
};
export const monacoThemeName = (resolved: "dark" | "light") =>
  active ? `veyra-${active.id}` : resolved === "light" ? "vs" : "vs-dark";
export const terminalThemeName = (
  resolved: "dark" | "light",
  fallback: Record<"dark" | "light", ITheme>,
): ITheme => (active ? terminalThemeFor(active) : fallback[resolved]);
