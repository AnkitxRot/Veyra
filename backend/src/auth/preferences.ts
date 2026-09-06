import type { Db } from "../db.js";
import { ApiError } from "../errors.js";

export interface UserPreferences {
  fontSize: number;
  tabSize: number;
  wordWrap: "off" | "on" | "wordWrapColumn" | "bounded";
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative" | "interval";
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  renderWhitespace: "none" | "boundary" | "selection" | "trailing" | "all";
  /** M66: run the editor formatter on every save. Previously a browser-only
   *  localStorage flag; now part of the single typed source of truth. */
  formatOnSave: boolean;
  /** M67: IDE panel layout — the four genuinely user-scoped layout dimensions
   *  that were throwaway IDE.tsx component state (reset on every reload). */
  sidebarWidth: number;
  bottomHeight: number;
  sidebarHidden: boolean;
  bottomCollapsed: boolean;
  /** M69: the unified appearance preference. "system" follows the OS
   *  `prefers-color-scheme`; "dark" / "light" pin the effective theme. */
  theme: "system" | "dark" | "light";
  updatedAt?: string;
}

/**
 * M67 layout bounds — lifted verbatim from the existing drag-resize clamps in
 * `frontend/src/components/IDE/IDE.tsx`. The frontend keeps a matching copy of
 * these numbers in `frontend/src/hooks/useLayoutPreferences.ts` and clamps
 * before persisting; the server rejects an out-of-range value outright.
 */
export const LAYOUT_BOUNDS = {
  sidebarWidth: { min: 180, max: 500 },
  bottomHeight: { min: 120, max: 600 },
} as const;

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  fontSize: 13.5,
  tabSize: 4,
  wordWrap: "off",
  minimap: false,
  lineNumbers: "on",
  cursorBlinking: "smooth",
  renderWhitespace: "selection",
  formatOnSave: false,
  sidebarWidth: 250,
  bottomHeight: 260,
  sidebarHidden: false,
  bottomCollapsed: false,
  theme: "system",
};

const ALLOWED_KEYS = new Set([
  "fontSize",
  "tabSize",
  "wordWrap",
  "minimap",
  "lineNumbers",
  "cursorBlinking",
  "renderWhitespace",
  "formatOnSave",
  "sidebarWidth",
  "bottomHeight",
  "sidebarHidden",
  "bottomCollapsed",
  "theme",
]);

const VALID_TAB_SIZES = [2, 4, 8];
const VALID_THEMES = ["system", "dark", "light"] as const;
const VALID_WORD_WRAPS = ["off", "on", "wordWrapColumn", "bounded"] as const;
const VALID_LINE_NUMBERS = ["on", "off", "relative", "interval"] as const;
const VALID_CURSOR_BLINKING = [
  "blink",
  "smooth",
  "phase",
  "expand",
  "solid",
] as const;
const VALID_RENDER_WHITESPACE = [
  "none",
  "boundary",
  "selection",
  "trailing",
  "all",
] as const;

/**
 * Retrieves the preferences for a given user.
 * If the user has no saved row, returns the default preferences without error.
 */
export function getUserPreferences(db: Db, userId: number): UserPreferences {
  const row = db
    .prepare(
      `SELECT font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace, format_on_save,
              sidebar_width, bottom_height, sidebar_hidden, bottom_collapsed, theme, updated_at
       FROM user_preferences WHERE user_id = ?`,
    )
    .get(userId) as any;

  if (!row) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  return {
    fontSize: Number(row.font_size),
    tabSize: Number(row.tab_size),
    wordWrap: row.word_wrap,
    minimap: Boolean(row.minimap),
    lineNumbers: row.line_numbers,
    cursorBlinking: row.cursor_blinking,
    renderWhitespace: row.render_whitespace,
    formatOnSave: Boolean(row.format_on_save),
    sidebarWidth: Number(row.sidebar_width),
    bottomHeight: Number(row.bottom_height),
    sidebarHidden: Boolean(row.sidebar_hidden),
    bottomCollapsed: Boolean(row.bottom_collapsed),
    theme: row.theme,
    updatedAt: row.updated_at,
  };
}

/**
 * Validates and updates user preferences in SQLite.
 */
export function updateUserPreferences(
  db: Db,
  userId: number,
  updates: Record<string, any>,
): UserPreferences {
  if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
    throw new ApiError(400, "Invalid payload: body must be an object", "invalid_payload");
  }

  // Reject unknown keys
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ApiError(
        400,
        `Unknown preference key: "${key}"`,
        "invalid_preference_key",
      );
    }
  }

  // Strict validation for provided fields
  if (updates.fontSize !== undefined) {
    if (
      typeof updates.fontSize !== "number" ||
      isNaN(updates.fontSize) ||
      !isFinite(updates.fontSize) ||
      updates.fontSize < 8 ||
      updates.fontSize > 32
    ) {
      throw new ApiError(
        400,
        "fontSize must be a valid number between 8 and 32",
        "invalid_font_size",
      );
    }
  }

  if (updates.tabSize !== undefined) {
    if (
      typeof updates.tabSize !== "number" ||
      !VALID_TAB_SIZES.includes(updates.tabSize)
    ) {
      throw new ApiError(
        400,
        "tabSize must be 2, 4, or 8",
        "invalid_tab_size",
      );
    }
  }

  if (updates.wordWrap !== undefined) {
    if (
      typeof updates.wordWrap !== "string" ||
      !VALID_WORD_WRAPS.includes(updates.wordWrap as any)
    ) {
      throw new ApiError(
        400,
        `wordWrap must be one of: ${VALID_WORD_WRAPS.join(", ")}`,
        "invalid_word_wrap",
      );
    }
  }

  if (updates.minimap !== undefined) {
    if (typeof updates.minimap !== "boolean") {
      throw new ApiError(
        400,
        "minimap must be a boolean",
        "invalid_minimap",
      );
    }
  }

  if (updates.lineNumbers !== undefined) {
    if (
      typeof updates.lineNumbers !== "string" ||
      !VALID_LINE_NUMBERS.includes(updates.lineNumbers as any)
    ) {
      throw new ApiError(
        400,
        `lineNumbers must be one of: ${VALID_LINE_NUMBERS.join(", ")}`,
        "invalid_line_numbers",
      );
    }
  }

  if (updates.cursorBlinking !== undefined) {
    if (
      typeof updates.cursorBlinking !== "string" ||
      !VALID_CURSOR_BLINKING.includes(updates.cursorBlinking as any)
    ) {
      throw new ApiError(
        400,
        `cursorBlinking must be one of: ${VALID_CURSOR_BLINKING.join(", ")}`,
        "invalid_cursor_blinking",
      );
    }
  }

  if (updates.renderWhitespace !== undefined) {
    if (
      typeof updates.renderWhitespace !== "string" ||
      !VALID_RENDER_WHITESPACE.includes(updates.renderWhitespace as any)
    ) {
      throw new ApiError(
        400,
        `renderWhitespace must be one of: ${VALID_RENDER_WHITESPACE.join(", ")}`,
        "invalid_render_whitespace",
      );
    }
  }

  if (updates.formatOnSave !== undefined) {
    if (typeof updates.formatOnSave !== "boolean") {
      throw new ApiError(
        400,
        "formatOnSave must be a boolean",
        "invalid_format_on_save",
      );
    }
  }

  if (updates.sidebarWidth !== undefined) {
    if (
      typeof updates.sidebarWidth !== "number" ||
      !Number.isFinite(updates.sidebarWidth) ||
      updates.sidebarWidth < LAYOUT_BOUNDS.sidebarWidth.min ||
      updates.sidebarWidth > LAYOUT_BOUNDS.sidebarWidth.max
    ) {
      throw new ApiError(
        400,
        `sidebarWidth must be a number between ${LAYOUT_BOUNDS.sidebarWidth.min} and ${LAYOUT_BOUNDS.sidebarWidth.max}`,
        "invalid_sidebar_width",
      );
    }
  }

  if (updates.bottomHeight !== undefined) {
    if (
      typeof updates.bottomHeight !== "number" ||
      !Number.isFinite(updates.bottomHeight) ||
      updates.bottomHeight < LAYOUT_BOUNDS.bottomHeight.min ||
      updates.bottomHeight > LAYOUT_BOUNDS.bottomHeight.max
    ) {
      throw new ApiError(
        400,
        `bottomHeight must be a number between ${LAYOUT_BOUNDS.bottomHeight.min} and ${LAYOUT_BOUNDS.bottomHeight.max}`,
        "invalid_bottom_height",
      );
    }
  }

  if (updates.sidebarHidden !== undefined) {
    if (typeof updates.sidebarHidden !== "boolean") {
      throw new ApiError(
        400,
        "sidebarHidden must be a boolean",
        "invalid_sidebar_hidden",
      );
    }
  }

  if (updates.bottomCollapsed !== undefined) {
    if (typeof updates.bottomCollapsed !== "boolean") {
      throw new ApiError(
        400,
        "bottomCollapsed must be a boolean",
        "invalid_bottom_collapsed",
      );
    }
  }

  if (updates.theme !== undefined) {
    if (
      typeof updates.theme !== "string" ||
      !VALID_THEMES.includes(updates.theme as any)
    ) {
      throw new ApiError(
        400,
        `theme must be one of: ${VALID_THEMES.join(", ")}`,
        "invalid_theme",
      );
    }
  }

  // Get current preferences to preserve unspecified fields
  const current = getUserPreferences(db, userId);
  const merged: UserPreferences = {
    fontSize: updates.fontSize !== undefined ? updates.fontSize : current.fontSize,
    tabSize: updates.tabSize !== undefined ? updates.tabSize : current.tabSize,
    wordWrap: updates.wordWrap !== undefined ? updates.wordWrap : current.wordWrap,
    minimap: updates.minimap !== undefined ? updates.minimap : current.minimap,
    lineNumbers:
      updates.lineNumbers !== undefined ? updates.lineNumbers : current.lineNumbers,
    cursorBlinking:
      updates.cursorBlinking !== undefined
        ? updates.cursorBlinking
        : current.cursorBlinking,
    renderWhitespace:
      updates.renderWhitespace !== undefined
        ? updates.renderWhitespace
        : current.renderWhitespace,
    formatOnSave:
      updates.formatOnSave !== undefined
        ? updates.formatOnSave
        : current.formatOnSave,
    sidebarWidth:
      updates.sidebarWidth !== undefined
        ? updates.sidebarWidth
        : current.sidebarWidth,
    bottomHeight:
      updates.bottomHeight !== undefined
        ? updates.bottomHeight
        : current.bottomHeight,
    sidebarHidden:
      updates.sidebarHidden !== undefined
        ? updates.sidebarHidden
        : current.sidebarHidden,
    bottomCollapsed:
      updates.bottomCollapsed !== undefined
        ? updates.bottomCollapsed
        : current.bottomCollapsed,
    theme: updates.theme !== undefined ? updates.theme : current.theme,
  };

  db.prepare(
    `INSERT INTO user_preferences (
       user_id, font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace, format_on_save,
       sidebar_width, bottom_height, sidebar_hidden, bottom_collapsed, theme, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       font_size = excluded.font_size,
       tab_size = excluded.tab_size,
       word_wrap = excluded.word_wrap,
       minimap = excluded.minimap,
       line_numbers = excluded.line_numbers,
       cursor_blinking = excluded.cursor_blinking,
       render_whitespace = excluded.render_whitespace,
       format_on_save = excluded.format_on_save,
       sidebar_width = excluded.sidebar_width,
       bottom_height = excluded.bottom_height,
       sidebar_hidden = excluded.sidebar_hidden,
       bottom_collapsed = excluded.bottom_collapsed,
       theme = excluded.theme,
       updated_at = datetime('now')`,
  ).run(
    userId,
    merged.fontSize,
    merged.tabSize,
    merged.wordWrap,
    merged.minimap ? 1 : 0,
    merged.lineNumbers,
    merged.cursorBlinking,
    merged.renderWhitespace,
    merged.formatOnSave ? 1 : 0,
    merged.sidebarWidth,
    merged.bottomHeight,
    merged.sidebarHidden ? 1 : 0,
    merged.bottomCollapsed ? 1 : 0,
    merged.theme,
  );

  return getUserPreferences(db, userId);
}
