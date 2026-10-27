import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_TAB_ORDER, loadLocalLayout, moveTab, normalizeTabOrder, saveLocalLayout, tabOrderCss } from "../src/layoutPrefs";

describe("layoutPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes saved order: drops unknown/dupes, appends missing", () => {
    const o = normalizeTabOrder(["git", "bogus", "git", "output"]);
    expect(o.slice(0, 2)).toEqual(["git", "output"]);
    expect([...o].sort()).toEqual([...DEFAULT_TAB_ORDER].sort());
    expect(normalizeTabOrder("junk")).toEqual([...DEFAULT_TAB_ORDER]);
  });
  it("moves a tab, clamped at the edges", () => {
    const o = ["a", "b", "c"];
    expect(moveTab(o, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveTab(o, "a", -1)).toBe(o);
    expect(moveTab(o, "c", 1)).toBe(o);
    expect(moveTab(o, "zzz", 1)).toBe(o);
  });
  it("round-trips and tolerates corrupt storage", () => {
    saveLocalLayout({ panelPosition: "right", tabOrder: ["git", ...DEFAULT_TAB_ORDER.filter((t) => t !== "git")] });
    const l = loadLocalLayout();
    expect(l.panelPosition).toBe("right");
    expect(l.tabOrder[0]).toBe("git");
    localStorage.setItem("veyra_layout_local", "{not json");
    expect(loadLocalLayout().panelPosition).toBe("bottom");
  });
  it("emits one css rule per tab", () => {
    expect(tabOrderCss(["a", "b"])).toBe('.panel-tabs [data-tab="a"]{order:0}.panel-tabs [data-tab="b"]{order:1}');
  });
});
