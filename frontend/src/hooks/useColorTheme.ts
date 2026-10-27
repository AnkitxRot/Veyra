import { useCallback, useEffect, useState } from "react";
import { monaco } from "../monacoSetup";
import {
  COLOR_THEME_EVENT,
  allThemes,
  loadActiveThemeId,
  loadCustomThemes,
  monacoThemeData,
  parseColorTheme,
  saveActiveThemeId,
  saveCustomThemes,
  setActiveTheme,
  themeCssVars,
  type ColorTheme,
} from "../colorThemes";

const ICONS_KEY = "veyra_file_icons";
export type FileIconTheme = "default" | "none";

const loadIcons = (): FileIconTheme => {
  try {
    return localStorage.getItem(ICONS_KEY) === "none" ? "none" : "default";
  } catch {
    return "default";
  }
};

/**
 * M106: applies the selected colour theme (CSS vars + Monaco + xterm) on top
 * of the M69 appearance. `resolved` is the base ("dark"/"light") the rest of
 * the IDE should use; with no theme selected it is the M69 value unchanged.
 * Must be called AFTER useAppearance so its data-theme stamp wins.
 */
export function useColorTheme(appearanceResolved: "dark" | "light") {
  const [activeId, setActiveId] = useState<string | null>(loadActiveThemeId);
  const [customThemes, setCustomThemes] = useState<ColorTheme[]>(loadCustomThemes);
  const [fileIcons, setFileIconsState] = useState<FileIconTheme>(loadIcons);

  const theme = activeId ? (allThemes().find((t) => t.id === activeId) ?? null) : null;
  const resolved: "dark" | "light" = theme ? theme.base : appearanceResolved;

  useEffect(() => {
    const root = document.documentElement;
    setActiveTheme(theme);
    if (!theme) {
      for (const k of Object.keys(themeCssVars(allThemes()[0]!))) root.style.removeProperty(k);
      monaco.editor.setTheme(appearanceResolved === "light" ? "vs" : "vs-dark");
    } else {
      for (const [k, v] of Object.entries(themeCssVars(theme))) root.style.setProperty(k, v);
      root.dataset.theme = theme.base;
      root.style.colorScheme = theme.base;
      monaco.editor.defineTheme(`veyra-${theme.id}`, monacoThemeData(theme));
      monaco.editor.setTheme(`veyra-${theme.id}`);
    }
    document.dispatchEvent(new CustomEvent(COLOR_THEME_EVENT));
  }, [theme, appearanceResolved]);

  useEffect(() => {
    document.documentElement.dataset.fileIcons = fileIcons;
  }, [fileIcons]);

  const select = useCallback((id: string | null) => {
    saveActiveThemeId(id);
    setActiveId(id);
  }, []);

  const importTheme = useCallback((json: string): string | null => {
    let parsed: ColorTheme | null = null;
    try {
      parsed = parseColorTheme(JSON.parse(json));
    } catch {
      /* fall through */
    }
    if (!parsed) return "Not a valid Veyra theme (id, label, base and ten #rrggbb colors required).";
    if (allThemes().some((t) => t.id === parsed!.id && !loadCustomThemes().some((c) => c.id === t.id)))
      return "That id belongs to a built-in theme; pick another id.";
    const next = [...loadCustomThemes().filter((t) => t.id !== parsed!.id), parsed];
    saveCustomThemes(next);
    setCustomThemes(next);
    select(parsed.id);
    return null;
  }, [select]);

  const removeCustom = useCallback(
    (id: string) => {
      const next = loadCustomThemes().filter((t) => t.id !== id);
      saveCustomThemes(next);
      setCustomThemes(next);
      if (activeId === id) select(null);
    },
    [activeId, select],
  );

  const setFileIcons = useCallback((v: FileIconTheme) => {
    try {
      localStorage.setItem(ICONS_KEY, v);
    } catch {
      /* storage unavailable */
    }
    setFileIconsState(v);
  }, []);

  return { resolved, activeId, customThemes, select, importTheme, removeCustom, fileIcons, setFileIcons };
}
