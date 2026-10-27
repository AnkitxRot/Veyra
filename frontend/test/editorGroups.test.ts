import { describe, it, expect } from "vitest";
import { groupsReducer, initialGroups, mainPaths, reconcile } from "../src/editorGroups";

describe("editorGroups", () => {
  it("splits with a tab and removes it from main", () => {
    const s = groupsReducer(initialGroups, { type: "split", direction: "right", id: "g2", path: "a.ts" });
    expect(s.extras).toEqual([{ id: "g2", tabs: ["a.ts"], active: "a.ts" }]);
    expect(mainPaths(["a.ts", "b.ts"], s)).toEqual(["b.ts"]);
  });
  it("caps at 3 groups", () => {
    let s = groupsReducer(initialGroups, { type: "split", direction: "right", id: "g2", path: "a" });
    s = groupsReducer(s, { type: "split", direction: "right", id: "g3", path: "b" });
    const s2 = groupsReducer(s, { type: "split", direction: "right", id: "g4", path: "c" });
    expect(s2).toBe(s);
    expect(s.extras).toHaveLength(2);
  });
  it("moves tabs between groups and back to main; empty groups vanish", () => {
    let s = groupsReducer(initialGroups, { type: "split", direction: "down", id: "g2", path: "a" });
    s = groupsReducer(s, { type: "split", direction: "down", id: "g3", path: "b" });
    s = groupsReducer(s, { type: "move", path: "a", to: "g3" });
    expect(s.extras).toEqual([{ id: "g3", tabs: ["b", "a"], active: "a" }]);
    s = groupsReducer(s, { type: "move", path: "a", to: "main" });
    expect(s.extras[0]!.tabs).toEqual(["b"]);
    s = groupsReducer(s, { type: "closeTab", path: "b" });
    expect(s.extras).toEqual([]);
  });
  it("reconcile drops closed files", () => {
    const s = groupsReducer(initialGroups, { type: "split", direction: "right", id: "g2", path: "a" });
    expect(reconcile(s, ["a"])).toBe(s);
    expect(reconcile(s, ["z"]).extras).toEqual([]);
  });
});
