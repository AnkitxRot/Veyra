import { describe, it, expect } from "vitest";
import { fromWorkspaceUri, toWorkspaceUri, isPythonPath } from "../src/lsp/uri";

describe("frontend lsp uri helpers", () => {
  it("round-trips workspace paths used by Monaco", () => {
    expect(toWorkspaceUri("main.py")).toBe("file:///workspace/main.py");
    expect(fromWorkspaceUri("file:///workspace/pkg/mod.py")).toBe("pkg/mod.py");
  });

  it("rejects escapes", () => {
    expect(fromWorkspaceUri("file:///workspace/../secret")).toBeNull();
    expect(fromWorkspaceUri("file:///etc/passwd")).toBeNull();
  });

  it("detects python files only", () => {
    expect(isPythonPath("main.py")).toBe(true);
    expect(isPythonPath("a/b.pyi")).toBe(true);
    expect(isPythonPath("main.js")).toBe(false);
  });
});
