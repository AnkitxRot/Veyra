/** M102: pure state for multiple terminals per project. Slot "" is the original terminal. */
export const MAX_TERMINAL_TABS = 5;

export interface TermTab {
  slot: string;
  label: string;
}
export interface TermTabsState {
  tabs: TermTab[];
  active: string;
  /** Slot shown beside the active one (split view), or null. */
  split: string | null;
  seq: number;
}

export const initialTermTabs: TermTabsState = {
  tabs: [{ slot: "", label: "bash" }],
  active: "",
  split: null,
  seq: 1,
};

export type TermTabsAction =
  | { type: "add" }
  | { type: "close"; slot: string }
  | { type: "activate"; slot: string }
  | { type: "toggleSplit" };

export function termTabsReducer(s: TermTabsState, a: TermTabsAction): TermTabsState {
  switch (a.type) {
    case "add": {
      if (s.tabs.length >= MAX_TERMINAL_TABS) return s;
      const seq = s.seq + 1;
      const slot = `t${seq}`;
      return { ...s, seq, tabs: [...s.tabs, { slot, label: `bash ${seq}` }], active: slot };
    }
    case "close": {
      if (s.tabs.length <= 1) return s;
      const tabs = s.tabs.filter((t) => t.slot !== a.slot);
      if (tabs.length === s.tabs.length) return s;
      const active = s.active === a.slot ? tabs[tabs.length - 1]!.slot : s.active;
      const split = s.split === a.slot || s.split === active ? null : s.split;
      return { ...s, tabs, active, split };
    }
    case "activate":
      if (!s.tabs.some((t) => t.slot === a.slot)) return s;
      return { ...s, active: a.slot, split: s.split === a.slot ? null : s.split };
    case "toggleSplit": {
      if (s.split) return { ...s, split: null };
      const other = s.tabs.find((t) => t.slot !== s.active);
      return other ? { ...s, split: other.slot } : s;
    }
  }
}

const KEY = (projectId: string) => `veyra_term_tabs_${projectId}`;

export function loadTermTabs(projectId: string): TermTabsState {
  try {
    const raw = sessionStorage.getItem(KEY(projectId));
    if (!raw) return initialTermTabs;
    const v = JSON.parse(raw) as TermTabsState;
    if (
      Array.isArray(v.tabs) &&
      v.tabs.length > 0 &&
      v.tabs.length <= MAX_TERMINAL_TABS &&
      v.tabs.every((t) => typeof t.slot === "string" && /^[A-Za-z0-9_-]*$/.test(t.slot)) &&
      v.tabs.some((t) => t.slot === v.active)
    ) {
      return { ...v, split: v.tabs.some((t) => t.slot === v.split) ? v.split : null };
    }
  } catch {
    /* corrupted hint — fall back */
  }
  return initialTermTabs;
}

export function saveTermTabs(projectId: string, s: TermTabsState): void {
  try {
    sessionStorage.setItem(KEY(projectId), JSON.stringify(s));
  } catch {
    /* best effort */
  }
}
