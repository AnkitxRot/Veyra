import { describe, it, expect, vi, afterEach } from "vitest";
import { monaco } from "./mocks/monaco";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import {
  resetLspProvidersForTests,
  setLspBridge,
} from "../src/lsp/providers";
import { searchWorkspaceSymbols } from "../src/lsp/workspaceSymbols";
import type { LspBridge } from "../src/lsp/bridge";

afterEach(() => {
  resetLspProvidersForTests();
});

function fakeBridge(
  id: string,
  request: LspBridge["request"],
): LspBridge {
  return {
    status: { state: "ready", language: id },
    request,
    notify: () => {},
    dispose: () => {},
  } as unknown as LspBridge;
}

describe("searchWorkspaceSymbols", () => {
  it("drops URIs outside /workspace and caps hits", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      name: `sym${i}`,
      location: {
        uri: `file:///workspace/src/f${i}.ts`,
        range: { start: { line: 0, character: 0 } },
      },
    }));
    setLspBridge(
      "typescript",
      fakeBridge("typescript", async () => [
        {
          name: "secret",
          location: { uri: "file:///etc/passwd", range: { start: { line: 0, character: 0 } } },
        },
        ...many,
      ]),
    );
    const hits = await searchWorkspaceSymbols("sym");
    expect(hits.every((h) => h.filePath.startsWith("src/"))).toBe(true);
    expect(hits.some((h) => h.name === "secret")).toBe(false);
    expect(hits.length).toBe(80);
  });

  it("a rejecting language server does not fail the search", async () => {
    setLspBridge(
      "python",
      fakeBridge("python", async () => {
        throw new Error("method not found");
      }),
    );
    setLspBridge(
      "typescript",
      fakeBridge("typescript", async () => [
        {
          name: "greet",
          location: {
            uri: "file:///workspace/src/index.ts",
            range: { start: { line: 2, character: 9 } },
          },
        },
      ]),
    );
    const hits = await searchWorkspaceSymbols("greet");
    expect(hits).toEqual([
      { name: "greet", filePath: "src/index.ts", line: 3, column: 10, containerName: undefined },
    ]);
  });
});
