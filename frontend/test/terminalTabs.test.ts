import { describe, it, expect, beforeEach } from "vitest";
import {
  initialTermTabs,
  termTabsReducer,
  loadTermTabs,
  saveTermTabs,
  MAX_TERMINAL_TABS,
} from "../src/terminalTabs";

describe("terminalTabs", () => {
  beforeEach(() => sessionStorage.clear());

  it("adds tabs up to the cap and activates the new one", () => {
    let s = initialTermTabs;
    for (let i = 0; i < 10; i++) s = termTabsReducer(s, { type: "add" });
    expect(s.tabs).toHaveLength(MAX_TERMINAL_TABS);
    expect(s.active).toBe(s.tabs.at(-1)!.slot);
  });
  it("never closes the last tab; closing active picks another", () => {
    expect(termTabsReducer(initialTermTabs, { type: "close", slot: "" })).toBe(initialTermTabs);
    let s = termTabsReducer(initialTermTabs, { type: "add" });
    s = termTabsReducer(s, { type: "close", slot: s.active });
    expect(s.tabs).toHaveLength(1);
    expect(s.active).toBe("");
  });
  it("toggles split with another tab", () => {
    let s = termTabsReducer(initialTermTabs, { type: "add" });
    s = termTabsReducer(s, { type: "activate", slot: "" });
    s = termTabsReducer(s, { type: "toggleSplit" });
    expect(s.split).toBe("t2");
    expect(termTabsReducer(s, { type: "toggleSplit" }).split).toBeNull();
  });
  it("round-trips through sessionStorage and rejects garbage", () => {
    const s = termTabsReducer(initialTermTabs, { type: "add" });
    saveTermTabs("p1", s);
    expect(loadTermTabs("p1")).toEqual(s);
    sessionStorage.setItem("veyra_term_tabs_p2", '{"tabs":[{"slot":"../x"}],"active":"../x"}');
    expect(loadTermTabs("p2")).toBe(initialTermTabs);
  });
});
