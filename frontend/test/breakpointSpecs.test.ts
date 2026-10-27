import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSpecs,
  saveSpecs,
  setSpec,
  pruneSpecs,
  toWireLines,
  toWireMap,
  loadWatches,
  saveWatches,
  addWatch,
} from "../src/debug/breakpointSpecs";

describe("breakpoint specs", () => {
  beforeEach(() => localStorage.clear());

  it("sets, merges and clears a spec; empty spec removes it", () => {
    let s = setSpec({}, "a.py", 3, { condition: "x > 1" });
    expect(s["a.py"]?.["3"]).toEqual({ condition: "x > 1" });
    s = setSpec(s, "a.py", 3, { hitCondition: ">= 2" });
    expect(s["a.py"]?.["3"]).toEqual({ condition: "x > 1", hitCondition: ">= 2" });
    s = setSpec(s, "a.py", 3, { condition: "", hitCondition: "", logMessage: "" });
    expect(s).toEqual({});
  });

  it("prunes specs for lines that are no longer breakpoints", () => {
    const s = setSpec(setSpec({}, "a.py", 3, { condition: "c" }), "a.py", 9, { logMessage: "m" });
    expect(pruneSpecs(s, { "a.py": [9] })).toEqual({ "a.py": { "9": { logMessage: "m" } } });
    expect(pruneSpecs(s, {})).toEqual({});
  });

  it("builds the wire format: plain numbers unless a spec exists", () => {
    const s = setSpec({}, "a.py", 3, { condition: "c" });
    expect(toWireLines([1, 3], s["a.py"])).toEqual([1, { line: 3, condition: "c" }]);
    expect(toWireMap({ "a.py": [1, 3], "b.py": [2] }, s)).toEqual({
      "a.py": [1, { line: 3, condition: "c" }],
      "b.py": [2],
    });
  });

  it("round-trips and sanitises stored specs", () => {
    saveSpecs("p1", setSpec({}, "a.py", 3, { condition: "c" }));
    expect(loadSpecs("p1")).toEqual({ "a.py": { "3": { condition: "c" } } });
    localStorage.setItem("veyra_debug_bpspec_p2", JSON.stringify({ "a.py": { "x": { condition: "c" }, "4": { condition: 5, logMessage: "ok" } } }));
    expect(loadSpecs("p2")).toEqual({ "a.py": { "4": { logMessage: "ok" } } });
    localStorage.setItem("veyra_debug_bpspec_p3", "{bad");
    expect(loadSpecs("p3")).toEqual({});
  });

  it("manages watches: trims, dedupes, caps, persists", () => {
    let w = addWatch([], "  x + 1 ");
    w = addWatch(w, "x + 1");
    w = addWatch(w, "");
    expect(w).toEqual(["x + 1"]);
    for (let i = 0; i < 40; i++) w = addWatch(w, `v${i}`);
    expect(w.length).toBe(20);
    saveWatches("p1", ["a", "b"]);
    expect(loadWatches("p1")).toEqual(["a", "b"]);
    localStorage.setItem("veyra_debug_watch_p2", '[1,"ok"]');
    expect(loadWatches("p2")).toEqual(["ok"]);
  });
});
