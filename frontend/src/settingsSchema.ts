/**
 * M105: schema for layered editor settings. Layers, lowest to highest:
 * built-in defaults -> user (server prefs + local extras) -> project
 * (`.veyra/settings.json`). The same schema drives validation and the UI.
 */
export type SettingType = "boolean" | "number" | "enum" | "string";

export interface SettingDef {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** Persisted server-side in UserPreferences (user scope). Others are stored locally. */
  server?: boolean;
}

export const SETTING_SCHEMA: readonly SettingDef[] = [
  { key: "fontSize", label: "Font size", description: "Editor font size in px", type: "number", min: 8, max: 40, server: true },
  { key: "tabSize", label: "Tab size", description: "Spaces per tab", type: "number", min: 1, max: 16, server: true },
  { key: "wordWrap", label: "Word wrap", description: "Wrap long lines", type: "enum", options: ["off", "on", "wordWrapColumn", "bounded"], server: true },
  { key: "minimap", label: "Minimap", description: "Show the code minimap", type: "boolean", server: true },
  { key: "lineNumbers", label: "Line numbers", description: "Line number style", type: "enum", options: ["on", "off", "relative", "interval"], server: true },
  { key: "cursorBlinking", label: "Cursor blinking", description: "Cursor animation", type: "enum", options: ["blink", "smooth", "phase", "expand", "solid"], server: true },
  { key: "renderWhitespace", label: "Render whitespace", description: "When to render whitespace", type: "enum", options: ["none", "boundary", "selection", "trailing", "all"], server: true },
  { key: "formatOnSave", label: "Format on save", description: "Run the formatter when saving", type: "boolean", server: true },
  { key: "fontFamily", label: "Font family", description: "CSS font-family for the editor", type: "string" },
  { key: "lineHeight", label: "Line height", description: "Line height in px (0 = automatic)", type: "number", min: 0, max: 80 },
  { key: "insertSpaces", label: "Insert spaces", description: "Insert spaces when pressing Tab", type: "boolean" },
  { key: "bracketPairColorization", label: "Bracket pair colors", description: "Colorize matching brackets", type: "boolean" },
  { key: "smoothScrolling", label: "Smooth scrolling", description: "Animate editor scrolling", type: "boolean" },
  { key: "stickyScroll", label: "Sticky scroll", description: "Pin enclosing scopes while scrolling", type: "boolean" },
];

export type SettingsLayer = Record<string, string | number | boolean>;

const BY_KEY = new Map(SETTING_SCHEMA.map((d) => [d.key, d]));

export function validateSetting(key: string, value: unknown): boolean {
  const d = BY_KEY.get(key);
  if (!d) return false;
  switch (d.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= (d.min ?? -Infinity) && value <= (d.max ?? Infinity);
    case "enum":
      return typeof value === "string" && !!d.options?.includes(value);
    case "string":
      // Conservative: font stacks only, no CSS injection characters.
      return typeof value === "string" && value.length <= 200 && /^[\w\s,'"-]*$/.test(value);
  }
}

/** Keep only known, valid keys; anything else is dropped silently. */
export function sanitizeLayer(raw: unknown): SettingsLayer {
  const out: SettingsLayer = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (validateSetting(k, v)) out[k] = v as string | number | boolean;
  return out;
}

export function parseSettingsJson(json: string): SettingsLayer {
  try {
    return sanitizeLayer(JSON.parse(json));
  } catch {
    return {};
  }
}

/** defaults < user < project; later layers win. */
export function mergeLayers<T extends object>(base: T, ...layers: SettingsLayer[]): T {
  return Object.assign({}, base, ...layers) as T;
}

/** Which layer currently decides `key`. */
export function sourceOf(key: string, user: SettingsLayer, project: SettingsLayer): "project" | "user" | "default" {
  return key in project ? "project" : key in user ? "user" : "default";
}

export function filterSchema(query: string): readonly SettingDef[] {
  const q = query.trim().toLowerCase();
  return q ? SETTING_SCHEMA.filter((d) => `${d.key} ${d.label} ${d.description}`.toLowerCase().includes(q)) : SETTING_SCHEMA;
}

/** Monaco options for the client-side settings (applied on top of the base options). */
export function editorExtraOptions(p: Partial<Record<string, unknown>> | undefined): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (!p) return o;
  if (typeof p.fontFamily === "string" && p.fontFamily) o.fontFamily = p.fontFamily;
  if (typeof p.lineHeight === "number") o.lineHeight = p.lineHeight;
  if (typeof p.insertSpaces === "boolean") o.insertSpaces = p.insertSpaces;
  if (typeof p.bracketPairColorization === "boolean") o.bracketPairColorization = { enabled: p.bracketPairColorization };
  if (typeof p.smoothScrolling === "boolean") o.smoothScrolling = p.smoothScrolling;
  if (typeof p.stickyScroll === "boolean") o.stickyScroll = { enabled: p.stickyScroll };
  return o;
}
