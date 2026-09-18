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
  it("accepts python and typescript and rejects executable-like ids", () => {
    expect(getLspLanguage("python")?.command).toBe("pylsp");
    expect(getLspLanguage("typescript")?.command).toBe(
      "typescript-language-server",
    );
    expect(getLspLanguage("python; rm -rf /")).toBeNull();
    expect(getLspLanguage("../../bin/sh")).toBeNull();
    expect(getLspLanguage("PYTHON")).toBeNull();
    expect(getLspLanguage("java")).toBeNull();
    expect(getLspLanguage("clangd")).toBeNull();
  });

  it("maps python and typescript/javascript files", () => {
    expect(lspLanguageForPath("main.py")?.id).toBe("python");
    expect(lspLanguageForPath("pkg/mod.pyi")?.id).toBe("python");
    expect(lspLanguageForPath("src/index.ts")?.id).toBe("typescript");
    expect(lspLanguageForPath("src/App.tsx")?.id).toBe("typescript");
    expect(lspLanguageForPath("src/main.js")?.id).toBe("typescript");
    expect(lspLanguageForPath("src/widget.jsx")?.id).toBe("typescript");
    expect(lspLanguageForPath("src/mod.mjs")?.id).toBe("typescript");
    expect(lspLanguageForPath("src/mod.cjs")?.id).toBe("typescript");
    expect(lspLanguageForPath("Main.java")).toBeNull();
  });

  it("assigns LSP languageIds for TSX/JSX/JS", () => {
    const ts = getLspLanguage("typescript")!;
    expect(ts.documentLanguageId("src/App.tsx")).toBe("typescriptreact");
    expect(ts.documentLanguageId("src/w.jsx")).toBe("javascriptreact");
    expect(ts.documentLanguageId("src/a.ts")).toBe("typescript");
    expect(ts.documentLanguageId("src/a.js")).toBe("javascript");
  });
});
