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
  updatedAt?: string;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  fontSize: 13.5,
  tabSize: 4,
  wordWrap: "off",
  minimap: false,
  lineNumbers: "on",
  cursorBlinking: "smooth",
  renderWhitespace: "selection",
};

const ALLOWED_KEYS = new Set([
  "fontSize",
  "tabSize",
  "wordWrap",
  "minimap",
  "lineNumbers",
  "cursorBlinking",
  "renderWhitespace",
]);

const VALID_TAB_SIZES = [2, 4, 8];
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
      `SELECT font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace, updated_at
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
  };

  db.prepare(
    `INSERT INTO user_preferences (
       user_id, font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       font_size = excluded.font_size,
       tab_size = excluded.tab_size,
       word_wrap = excluded.word_wrap,
       minimap = excluded.minimap,
       line_numbers = excluded.line_numbers,
       cursor_blinking = excluded.cursor_blinking,
       render_whitespace = excluded.render_whitespace,
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
  );

  return getUserPreferences(db, userId);
}
