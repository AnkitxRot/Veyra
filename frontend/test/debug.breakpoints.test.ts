import { describe, it, expect, beforeEach } from "vitest";
import {
  loadBreakpoints,
  saveBreakpoints,
  toggleLine,
} from "../src/debug/breakpoints";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("debug breakpoint store", () => {
  it("toggles lines and persists per project, not globally", () => {
    const a = toggleLine({}, "main.py", 3);
    expect(a["main.py"]).toEqual([3]);
    saveBreakpoints("proj-a", a);
    saveBreakpoints("proj-b", toggleLine({}, "main.py", 8));
    expect(loadBreakpoints("proj-a")["main.py"]).toEqual([3]);
    expect(loadBreakpoints("proj-b")["main.py"]).toEqual([8]);
  });

  it("rejects escapes and invalid lines", () => {
    expect(toggleLine({}, "../secret.py", 1)).toEqual({});
    expect(toggleLine({}, "main.py", 0)).toEqual({});
    const next = toggleLine({ "main.py": [3] }, "main.py", 3);
    expect(next["main.py"]).toBeUndefined();
  });

  it("survives corrupt localStorage", () => {
    localStorage.setItem("veyra_debug_bp_bad", "{not json");
    expect(loadBreakpoints("bad")).toEqual({});
  });
});
