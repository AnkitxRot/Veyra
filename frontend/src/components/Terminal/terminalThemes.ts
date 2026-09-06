import type { ITheme } from "@xterm/xterm";

// M69 — the xterm palette per resolved appearance. Dark is the existing
// Catppuccin Mocha set; light is its Latte counterpart, matching the IDE
// chrome. Kept in its own module so Terminal.tsx exports only its component
// (react-refresh) and tests can import the palettes directly.
export const TERMINAL_THEMES: Record<"dark" | "light", ITheme> = {
  dark: {
    background: "#090b10",
    foreground: "#cdd6f4",
    cursor: "#89b4fa",
    selectionBackground: "rgba(137, 180, 250, 0.3)",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
  },
  light: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#1e66f5",
    selectionBackground: "rgba(30, 102, 245, 0.25)",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
  },
};
