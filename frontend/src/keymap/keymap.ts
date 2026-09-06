// M70 — the single keybinding source of truth for the IDE-chrome command set.
//
// The typed `keymap` user preference stores only the command IDs the user has
// REMAPPED (id -> canonical chord). This module owns:
//   - the configurable command list (the exact `CommandRegistry` IDs;
//     `useKeyboardShortcuts` dispatches these, the settings UI edits these);
//   - the canonical chord grammar (kept in lockstep with the backend
//     `auth/preferences.ts` copy — one shortcut has exactly one representation);
//   - `chordFromEvent` (capture + matching), `chordToDisplay`,
//     `chordToMonacoKeybinding`, `resolveKeymap`, `findConflict`.
//
// `mod` = the platform primary modifier (Cmd on macOS, Ctrl elsewhere) — the
// same convention `useKeyboardShortcuts` has always used. Plain Ctrl on macOS
// and the Windows/Meta key are deliberately NOT recognised (keeps this small;
// every real IDE shortcut carries the primary modifier).

export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type CommandId =
  | "workbench.action.showCommands"
  | "workbench.action.quickOpen"
  | "workbench.action.saveFile"
  | "workbench.action.toggleSidebar"
  | "workbench.action.toggleBottomPanel";

export interface ConfigurableCommand {
  id: CommandId;
  /** Human label for the settings UI. */
  title: string;
  description: string;
  defaultChord: string;
  /** When true the command is suppressed if the keystroke targets a plain
   *  editable field (INPUT / TEXTAREA / contentEditable) — Ctrl+B = bold. */
  skipInTextInput: boolean;
}

export const CONFIGURABLE_COMMANDS: ConfigurableCommand[] = [
  {
    id: "workbench.action.showCommands",
    title: "Command Palette",
    description: "Show and run IDE commands",
    defaultChord: "mod+shift+p",
    skipInTextInput: false,
  },
  {
    id: "workbench.action.quickOpen",
    title: "Quick Open File",
    description: "Search and open workspace files by name",
    defaultChord: "mod+p",
    skipInTextInput: false,
  },
  {
    id: "workbench.action.saveFile",
    title: "Save Active File",
    description: "Save the active editor buffer to disk",
    defaultChord: "mod+s",
    skipInTextInput: false,
  },
  {
    id: "workbench.action.toggleSidebar",
    title: "Toggle Sidebar",
    description: "Show or hide the workspace file tree",
    defaultChord: "mod+b",
    skipInTextInput: true,
  },
  {
    id: "workbench.action.toggleBottomPanel",
    title: "Toggle Bottom Console Drawer",
    description: "Expand or collapse the output / terminal drawer",
    defaultChord: "mod+j",
    skipInTextInput: false,
  },
];

export const DEFAULT_KEYMAP: Record<CommandId, string> = Object.fromEntries(
  CONFIGURABLE_COMMANDS.map((c) => [c.id, c.defaultChord]),
) as Record<CommandId, string>;

const COMMAND_BY_ID = new Map<string, ConfigurableCommand>(
  CONFIGURABLE_COMMANDS.map((c) => [c.id, c]),
);

export function getCommand(id: string): ConfigurableCommand | undefined {
  return COMMAND_BY_ID.get(id);
}

// --- chord grammar (mirror of backend `auth/preferences.ts`) ---------------

const CHORD_RE =
  /^mod\+(alt\+)?(shift\+)?([a-z0-9]|f[1-9]|f1[0-2]|[[\]\\;',./`=-])$/;

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

/** `mod+s`, `mod+p`, `mod+shift+p`, `mod+alt+k` — one canonical form each. */
export function isValidChord(chord: unknown): chord is string {
  return (
    typeof chord === "string" &&
    CHORD_RE.test(chord) &&
    !BROWSER_RESERVED.has(chord)
  );
}

// --- event <-> chord ------------------------------------------------------

const PUNCT_BY_CODE: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/** Physical key from `e.code` (layout / shift stable). */
function keyFromCode(code: string): string | null {
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  const d = /^Digit([0-9])$/.exec(code);
  if (d) return d[1];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return PUNCT_BY_CODE[code] ?? null;
}

/** Fallback for synthetic events (tests, old browsers) that set only `key`. */
function keyFromKey(key: string): string | null {
  const k = key.toLowerCase();
  if (k.length === 1 && /[a-z0-9[\]\\;',./`=-]/.test(k)) return k;
  if (/^f([1-9]|1[0-2])$/.test(k)) return k;
  return null;
}

type KeyLike = {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * Canonical chord for a keydown, or `null` if it cannot be a shortcut (bare
 * modifier, unmappable key, or no primary modifier). Returned chords are
 * always in `mod`/`alt`/`shift`/key order but are NOT validity-checked here —
 * the caller decides (matching vs. capture).
 */
export function chordFromEvent(e: KeyLike): string | null {
  const key =
    (e.code ? keyFromCode(e.code) : null) ?? keyFromKey(e.key ?? "");
  if (!key) return null;
  const mod = IS_MAC ? !!e.metaKey : !!e.ctrlKey;
  if (!mod) return null;
  const parts = ["mod"];
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const MOD_LABEL_MAC: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
};
const MOD_LABEL_PC: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};
const MAC_MOD_ORDER = ["shift", "alt", "mod"]; // ⇧⌥⌘ — matches the app's "⇧⌘P"

export function chordToDisplay(chord: string, isMac: boolean): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const mods = parts;
  const keyLabel = key.toUpperCase();
  if (isMac) {
    const ordered = MAC_MOD_ORDER.filter((m) => mods.includes(m)).map(
      (m) => MOD_LABEL_MAC[m],
    );
    return ordered.join("") + keyLabel;
  }
  return [...mods.map((m) => MOD_LABEL_PC[m] ?? m), keyLabel].join("+");
}

// --- Monaco keybinding conversion ---------------------------------------

interface MonacoKeyApi {
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number };
  // Monaco's KeyCode is a numeric enum (carries string reverse-mappings too).
  KeyCode: Record<string, unknown>;
}

/** Canonical chord -> `monaco.KeyMod|KeyCode` bitmask, or `null` if the key is
 *  outside Monaco's `KeyCode` map. */
export function chordToMonacoKeybinding(
  chord: string,
  monaco: MonacoKeyApi,
): number | null {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  let kb = 0;
  for (const p of parts) {
    if (p === "mod") kb |= monaco.KeyMod.CtrlCmd;
    else if (p === "alt") kb |= monaco.KeyMod.Alt;
    else if (p === "shift") kb |= monaco.KeyMod.Shift;
  }
  let codeName: string | null = null;
  if (/^[a-z]$/.test(key)) codeName = "Key" + key.toUpperCase();
  else if (/^[0-9]$/.test(key)) codeName = "Digit" + key;
  else if (/^f([1-9]|1[0-2])$/.test(key)) codeName = key.toUpperCase();
  else {
    const named = Object.entries(PUNCT_BY_CODE).find(([, v]) => v === key);
    if (named) codeName = named[0];
  }
  if (!codeName) return null;
  const kc = monaco.KeyCode[codeName];
  if (typeof kc !== "number") return null;
  return kb | kc;
}

// --- resolve + conflict ------------------------------------------------

export type Keymap = Record<string, string>;

export interface ResolvedKeymap {
  /** resolved chord per configurable command */
  byCommand: Record<CommandId, string>;
  /** reverse index: chord -> the command that owns it */
  byChord: Map<string, CommandId>;
}

export function resolveKeymap(overrides: Keymap): ResolvedKeymap {
  const byCommand = { ...DEFAULT_KEYMAP };
  for (const [id, chord] of Object.entries(overrides ?? {})) {
    if (COMMAND_BY_ID.has(id) && typeof chord === "string") {
      byCommand[id as CommandId] = chord;
    }
  }
  const byChord = new Map<string, CommandId>();
  for (const [id, chord] of Object.entries(byCommand)) {
    byChord.set(chord, id as CommandId);
  }
  return { byCommand, byChord };
}

/**
 * The command that would collide if `candidateId` were bound to
 * `candidateChord` — evaluated against the resolved keymap with the candidate
 * applied, so a straight swap of two commands reports no conflict. `null` when
 * the chord is free (or already owned by `candidateId`).
 */
export function findConflict(
  overrides: Keymap,
  candidateId: CommandId,
  candidateChord: string,
): CommandId | null {
  const resolved = resolveKeymap({
    ...overrides,
    [candidateId]: candidateChord,
  });
  const owner = resolved.byChord.get(candidateChord);
  return owner && owner !== candidateId ? owner : null;
}
