import { describe, it, expect } from "vitest";
import {
  canDebugPath,
  debugLanguageForPath,
  isDebuggablePath,
} from "../src/debug/languages";

describe("debug language allowlist", () => {
  it("maps python and node/ts entry files", () => {
    expect(debugLanguageForPath("main.py")).toBe("python");
    expect(debugLanguageForPath("src/index.ts")).toBe("node");
    expect(debugLanguageForPath("app.js")).toBe("node");
    expect(debugLanguageForPath("mod.mjs")).toBe("node");
  });

  it("does not claim TSX/JSX or Java/C++ debugging", () => {
    expect(debugLanguageForPath("App.tsx")).toBeNull();
    expect(debugLanguageForPath("App.jsx")).toBeNull();
    expect(debugLanguageForPath("Main.java")).toBeNull();
    expect(debugLanguageForPath("main.c")).toBeNull();
    expect(isDebuggablePath("../secret.py")).toBe(false);
  });

  it("requires docker + runner image, and language-specific debugger flags", () => {
    const caps = {
      docker: true,
      runnerImage: true,
      debugger: { python: true, node: false },
    };
    expect(canDebugPath("main.py", caps)).toBe(true);
    expect(canDebugPath("main.js", caps)).toBe(false);
    expect(canDebugPath("main.py", { docker: false, runnerImage: true })).toBe(
      false,
    );
    expect(canDebugPath("main.py", { docker: true, runnerImage: false })).toBe(
      false,
    );
  });
});
