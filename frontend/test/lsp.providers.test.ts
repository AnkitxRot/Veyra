import { describe, it, expect, vi, beforeEach } from "vitest";
import { monaco, __resetMonacoMocks } from "./mocks/monaco";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import {
  ensureLspProviders,
  setActiveLspBridge,
  resetLspProvidersForTests,
} from "../src/lsp/providers";
import type { LspBridge } from "../src/lsp/bridge";

describe("lsp monaco providers", () => {
  beforeEach(() => {
    resetLspProvidersForTests();
    __resetMonacoMocks();
  });

  it("registers providers once and no-ops without a bridge", async () => {
    ensureLspProviders();
    ensureLspProviders();
    expect(monaco.languages._completion).toHaveLength(1);
    const provider = monaco.languages._completion[0] as {
      provideCompletionItems: (
        model: unknown,
        position: { lineNumber: number; column: number },
      ) => Promise<{ suggestions: unknown[] }>;
    };
    const model = monaco.editor.createModel(
      "print(1)\n",
      "python",
      monaco.Uri.file("main.py"),
    );
    const result = await provider.provideCompletionItems(model, {
      lineNumber: 1,
      column: 1,
    });
    expect(result.suggestions).toEqual([]);
  });

  it("asks the active bridge for completions when ready", async () => {
    ensureLspProviders();
    const request = vi.fn().mockResolvedValue({
      items: [{ label: "hello", kind: 3, insertText: "hello" }],
    });
    setActiveLspBridge({
      status: { state: "ready", language: "python" },
      request,
    } as unknown as LspBridge);
    const provider = monaco.languages._completion[0] as {
      provideCompletionItems: (
        model: any,
        position: { lineNumber: number; column: number },
      ) => Promise<{ suggestions: { label: string }[] }>;
    };
    const model = monaco.editor.createModel(
      "print(1)\n",
      "python",
      monaco.Uri.file("main.py"),
    );
    const result = await provider.provideCompletionItems(model, {
      lineNumber: 1,
      column: 1,
    });
    expect(request).toHaveBeenCalled();
    expect(result.suggestions[0].label).toBe("hello");
    setActiveLspBridge(null);
  });

  it("reveals the first definition target and does not auto-open references", async () => {
    ensureLspProviders();
    const request = vi.fn().mockResolvedValue({
      uri: "file:///workspace/main.py",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 4 },
      },
    });
    setActiveLspBridge({
      status: { state: "ready", language: "python" },
      request,
    } as unknown as LspBridge);
    const opened: string[] = [];
    const onReveal = (e: Event) => {
      opened.push((e as CustomEvent).detail.filePath);
    };
    document.addEventListener("ide-open-and-reveal", onReveal);
    const model = monaco.editor.createModel(
      "def main():\n  pass\n",
      "python",
      monaco.Uri.file("main.py"),
    );
    const def = monaco.languages._definition[0] as {
      provideDefinition: (
        model: unknown,
        position: { lineNumber: number; column: number },
      ) => Promise<unknown>;
    };
    await def.provideDefinition(model, { lineNumber: 1, column: 5 });
    expect(opened).toEqual(["main.py"]);
    opened.length = 0;
    request.mockResolvedValue([
      {
        uri: "file:///workspace/main.py",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
      },
      {
        uri: "file:///workspace/other.py",
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 4 },
        },
      },
    ]);
    const refs = monaco.languages._references[0] as {
      provideReferences: (
        model: unknown,
        position: { lineNumber: number; column: number },
      ) => Promise<unknown>;
    };
    await refs.provideReferences(model, { lineNumber: 1, column: 5 });
    expect(opened).toEqual([]);
    document.removeEventListener("ide-open-and-reveal", onReveal);
    setActiveLspBridge(null);
  });
});
