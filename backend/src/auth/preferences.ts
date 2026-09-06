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
  /** M70: configurable keybindings — command ID -> canonical chord, storing
   *  ONLY the commands the user has remapped. Commands at their default are
   *  absent; `{}` means "all defaults". The frontend keeps the matching
   *  `DEFAULT_KEYMAP` / chord grammar in `src/keymap/`. */
  keymap: Record<string, string>;
  updatedAt?: string;
}

/**
 * M70 — the IDE-chrome commands whose keybinding is user-configurable. These
 * are the exact command IDs the command palette already registers
 * (`CommandRegistry`) and that `useKeyboardShortcuts` dispatches; M70 does not
 * introduce a second command registry.
 */
export const CONFIGURABLE_COMMAND_IDS = [
  "workbench.action.showCommands",
  "workbench.action.quickOpen",
  "workbench.action.saveFile",
  "workbench.action.toggleSidebar",
  "workbench.action.toggleBottomPanel",
] as const;

/**
 * Canonical default chord per configurable command. `mod` = the platform
 * primary modifier (Cmd on macOS, Ctrl elsewhere). Kept in lockstep with the
 * frontend `DEFAULT_KEYMAP`.
 */
export const DEFAULT_KEYMAP: Record<string, string> = {
  "workbench.action.showCommands": "mod+shift+p",
  "workbench.action.quickOpen": "mod+p",
  "workbench.action.saveFile": "mod+s",
  "workbench.action.toggleSidebar": "mod+b",
  "workbench.action.toggleBottomPanel": "mod+j",
};

const CONFIGURABLE_ID_SET = new Set<string>(CONFIGURABLE_COMMAND_IDS);

/**
 * A canonical chord: `mod` is required (all real IDE shortcuts carry the
 * primary modifier; a bare or shift-only key would break typing), optional
 * `alt` and `shift` in that fixed order, then exactly one key. The key is a
 * letter, digit, F-key, or a small set of punctuation. Uppercase, spaces, raw
 * `ctrl`/`meta`, and non-canonical modifier order are all rejected — one
 * shortcut has exactly one representation.
 */
const CHORD_RE =
  /^mod\+(alt\+)?(shift\+)?([a-z0-9]|f[1-9]|f1[0-2]|[[\]\\;',./`=-])$/;

/**
 * Combinations the browser / OS will not reliably yield to `preventDefault`
 * (new/close tab or window, quit, reload, devtools). `mod+p` (print) and
 * `mod+s` (save-page) are deliberately NOT here — Chrome lets a keydown
 * handler suppress those, and the IDE already relies on that.
 */
const BROWSER_RESERVED = new Set<string>([
  "mod+w",
  "mod+t",
  "mod+n",
  "mod+q",
  "mod+r",
  "mod+shift+w",
  "mod+shift+t",
  "mod+shift+n",
  "mod+shift+q",
  "mod+shift+r",
  "mod+shift+i",
  "mod+shift+j",
  "mod+shift+c",
]);

export function isValidChord(chord: unknown): chord is string {
  return (
    typeof chord === "string" &&
    CHORD_RE.test(chord) &&
    !BROWSER_RESERVED.has(chord)
  );
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
  keymap: {},
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
  "keymap",
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
              sidebar_width, bottom_height, sidebar_hidden, bottom_collapsed, theme, keymap, updated_at
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
    keymap: parseKeymap(row.keymap),
    updatedAt: row.updated_at,
  };
}

/** Tolerant read: a corrupt / non-object stored value falls back to `{}`. */
function parseKeymap(raw: unknown): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, string>;
    }
  } catch {
    /* fall through */
  }
  return {};
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

  if (updates.keymap !== undefined) {
    const km = updates.keymap;
    if (typeof km !== "object" || km === null || Array.isArray(km)) {
      throw new ApiError(
        400,
        "keymap must be an object of commandId -> chord",
        "invalid_keymap",
      );
    }
    for (const [id, chord] of Object.entries(km as Record<string, unknown>)) {
      if (!CONFIGURABLE_ID_SET.has(id)) {
        throw new ApiError(
          400,
          `"${id}" is not a configurable command`,
          "invalid_command_id",
        );
      }
      if (!isValidChord(chord)) {
        throw new ApiError(
          400,
          `"${String(chord)}" is not a usable shortcut`,
          "invalid_shortcut",
        );
      }
    }
    // Conflict across the RESOLVED keymap (overrides layered on defaults):
    // every chord must be owned by exactly one command.
    const resolved: Record<string, string> = {
      ...DEFAULT_KEYMAP,
      ...(km as Record<string, string>),
    };
    const seen = new Map<string, string>();
    for (const [id, chord] of Object.entries(resolved)) {
      const owner = seen.get(chord);
      if (owner && owner !== id) {
        throw new ApiError(
          400,
          `${chord} is already bound to "${owner}"`,
          "duplicate_shortcut",
        );
      }
      seen.set(chord, id);
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
    keymap:
      updates.keymap !== undefined
        ? (updates.keymap as Record<string, string>)
        : current.keymap,
  };

  db.prepare(
    `INSERT INTO user_preferences (
       user_id, font_size, tab_size, word_wrap, minimap, line_numbers, cursor_blinking, render_whitespace, format_on_save,
       sidebar_width, bottom_height, sidebar_hidden, bottom_collapsed, theme, keymap, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
       keymap = excluded.keymap,
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
    JSON.stringify(merged.keymap ?? {}),
  );

  return getUserPreferences(db, userId);
}
