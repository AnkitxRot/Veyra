/**
 * M107: client-side layout preferences that complement the server-persisted
 * M67 layout (sizes/visibility): where the bottom panel docks and the order of
 * its tabs. Zen mode is session-only by design.
 */
export type PanelPosition = "bottom" | "right";

export const DEFAULT_TAB_ORDER = ["output", "problems", "resources", "terminal", "preview", "git", "debug", "tests"] as const;

const KEY = "veyra_layout_local";

export interface LocalLayout {
  panelPosition: PanelPosition;
  tabOrder: string[];
}

/** Reconcile a saved order with the known tabs: drop unknown/dupes, append missing. */
export function normalizeTabOrder(saved: unknown, known: readonly string[] = DEFAULT_TAB_ORDER): string[] {
  const out: string[] = [];
  if (Array.isArray(saved))
    for (const id of saved)
      if (typeof id === "string" && known.includes(id) && !out.includes(id)) out.push(id);
  for (const id of known) if (!out.includes(id)) out.push(id);
  return out;
}

/** Move `id` one step left (-1) or right (+1); no-op at the edges. */
export function moveTab(order: string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function loadLocalLayout(): LocalLayout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LocalLayout>;
    return {
      panelPosition: v.panelPosition === "right" ? "right" : "bottom",
      tabOrder: normalizeTabOrder(v.tabOrder),
    };
  } catch {
    return { panelPosition: "bottom", tabOrder: [...DEFAULT_TAB_ORDER] };
  }
}

export function saveLocalLayout(l: LocalLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
}

/** CSS that applies tab order via flex `order` (tabs carry data-tab). */
export function tabOrderCss(order: string[]): string {
  return order.map((id, i) => `.panel-tabs [data-tab="${id}"]{order:${i}}`).join("");
}
