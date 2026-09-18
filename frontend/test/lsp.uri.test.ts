import { describe, it, expect } from "vitest";
import { fromWorkspaceUri, toWorkspaceUri, isPythonPath, isTypeScriptPath } from "../src/lsp/uri";

describe("frontend lsp uri helpers", () => {
  it("round-trips workspace paths used by Monaco", () => {
    expect(toWorkspaceUri("main.py")).toBe("file:///workspace/main.py");
    expect(fromWorkspaceUri("file:///workspace/pkg/mod.py")).toBe("pkg/mod.py");
  });

  it("rejects escapes", () => {
    expect(fromWorkspaceUri("file:///workspace/../secret")).toBeNull();
    expect(fromWorkspaceUri("file:///etc/passwd")).toBeNull();
  });

  it("detects python and typescript files", () => {
    expect(isPythonPath("main.py")).toBe(true);
    expect(isPythonPath("a/b.pyi")).toBe(true);
    expect(isPythonPath("main.js")).toBe(false);
    expect(isTypeScriptPath("src/index.ts")).toBe(true);
    expect(isTypeScriptPath("src/App.tsx")).toBe(true);
    expect(isTypeScriptPath("src/main.js")).toBe(true);
    expect(isTypeScriptPath("main.py")).toBe(false);
  });
});
