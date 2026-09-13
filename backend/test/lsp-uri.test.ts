import { describe, it, expect } from "vitest";
import {
  fromWorkspaceUri,
  toWorkspaceUri,
  normalizeRelPath,
  rewriteUris,
} from "../src/lsp/uri.js";
import { getLspLanguage, lspLanguageForPath } from "../src/lsp/languages.js";

describe("lsp uri mapping", () => {
  it("round-trips a nested python path", () => {
    const uri = toWorkspaceUri("src/pkg/main.py");
    expect(uri).toBe("file:///workspace/src/pkg/main.py");
    expect(fromWorkspaceUri(uri)).toBe("src/pkg/main.py");
  });

  it("rejects workspace escape via ..", () => {
    expect(fromWorkspaceUri("file:///workspace/../etc/passwd")).toBeNull();
    expect(fromWorkspaceUri("file:///workspace/%2e%2e/secret")).toBeNull();
    expect(fromWorkspaceUri("file:///etc/passwd")).toBeNull();
    expect(fromWorkspaceUri("file://localhost/workspace/main.py")).toBeNull();
  });

  it("rejects backslashes in URIs, NULs, and absolute windows paths", () => {
    expect(fromWorkspaceUri("file:///workspace/foo\\bar.py")).toBeNull();
    expect(fromWorkspaceUri("file:///workspace/foo\0.py")).toBeNull();
    expect(normalizeRelPath("C:/main.py")).toBeNull();
    expect(normalizeRelPath("/etc/passwd")).toBeNull();
  });

  it("rewriteUris drops payloads that contain an illegal uri", () => {
    const bad = rewriteUris(
      { textDocument: { uri: "file:///etc/passwd" } },
      (u) => fromWorkspaceUri(u),
    );
    expect(bad.ok).toBe(false);
    const good = rewriteUris(
      { textDocument: { uri: "file:///workspace/main.py" } },
      (u) => fromWorkspaceUri(u),
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect((good.value as any).textDocument.uri).toBe("main.py");
    }
  });
});

describe("lsp language allowlist", () => {
  it("accepts python and rejects executable-like ids", () => {
    expect(getLspLanguage("python")?.command).toBe("pylsp");
    expect(getLspLanguage("python; rm -rf /")).toBeNull();
    expect(getLspLanguage("../../bin/sh")).toBeNull();
    expect(getLspLanguage("PYTHON")).toBeNull();
    expect(getLspLanguage("java")).toBeNull();
  });

  it("maps .py files and ignores others", () => {
    expect(lspLanguageForPath("main.py")?.id).toBe("python");
    expect(lspLanguageForPath("pkg/mod.pyi")?.id).toBe("python");
    expect(lspLanguageForPath("main.js")).toBeNull();
  });
});
