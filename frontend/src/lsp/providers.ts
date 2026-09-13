import { monaco } from "../monacoSetup";
import type { LspBridge } from "./bridge";
import { LSP_OPEN_REVEAL_EVENT } from "./types";
import { fromWorkspaceUri, toWorkspaceUri } from "./uri";

let activeBridge: LspBridge | null = null;
let registered = false;

export function resetLspProvidersForTests(): void {
  registered = false;
  activeBridge = null;
}

export function setActiveLspBridge(bridge: LspBridge | null): void {
  activeBridge = bridge;
}

export function getActiveLspBridge(): LspBridge | null {
  return activeBridge;
}

export function ensureLspProviders(): void {
  if (registered) return;
  registered = true;
  const python = "python";

  monaco.languages.registerCompletionItemProvider(python, {
    triggerCharacters: [".", "_"],
    provideCompletionItems: async (model, position) => {
      const bridge = activeBridge;
      if (!bridge || bridge.status.state !== "ready") {
        return { suggestions: [] };
      }
      const rel = modelPath(model);
      const uri = rel ? toWorkspaceUri(rel) : null;
      if (!uri) return { suggestions: [] };
      const result = (await bridge.request("textDocument/completion", {
        textDocument: { uri },
        position: toLspPosition(position),
      })) as { items?: CompletionLike[] } | CompletionLike[] | null;
      const items = Array.isArray(result)
        ? result
        : Array.isArray(result?.items)
          ? result.items
          : [];
      const word = model.getWordUntilPosition
        ? model.getWordUntilPosition(position)
        : { startColumn: position.column, endColumn: position.column };
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };
      return {
        suggestions: items.slice(0, 200).map((item, i) => ({
          label: String(item.label ?? ""),
          kind: mapCompletionKind(item.kind),
          insertText: String(item.insertText ?? item.label ?? ""),
          detail: item.detail ? String(item.detail) : undefined,
          documentation: markupToString(item.documentation),
          range,
          sortText: item.sortText ? String(item.sortText) : String(i).padStart(5, "0"),
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(python, {
    provideHover: async (model, position) => {
      const bridge = activeBridge;
      if (!bridge || bridge.status.state !== "ready") return null;
      const rel = modelPath(model);
      const uri = rel ? toWorkspaceUri(rel) : null;
      if (!uri) return null;
      const result = (await bridge.request("textDocument/hover", {
        textDocument: { uri },
        position: toLspPosition(position),
      })) as { contents?: unknown; range?: LspRange } | null;
      if (!result) return null;
      const value = markupToString(result.contents);
      if (!value) return null;
      return {
        contents: [{ value }],
        range: result.range ? fromLspRange(result.range) : undefined,
      };
    },
  });

  monaco.languages.registerDefinitionProvider(python, {
    provideDefinition: async (model, position) => {
      const bridge = activeBridge;
      if (!bridge || bridge.status.state !== "ready") return [];
      const rel = modelPath(model);
      const uri = rel ? toWorkspaceUri(rel) : null;
      if (!uri) return [];
      const result = await bridge.request("textDocument/definition", {
        textDocument: { uri },
        position: toLspPosition(position),
      });
      return mapLocations(result, true);
    },
  });

  monaco.languages.registerReferenceProvider(python, {
    provideReferences: async (model, position) => {
      const bridge = activeBridge;
      if (!bridge || bridge.status.state !== "ready") return [];
      const rel = modelPath(model);
      const uri = rel ? toWorkspaceUri(rel) : null;
      if (!uri) return [];
      const result = await bridge.request("textDocument/references", {
        textDocument: { uri },
        position: toLspPosition(position),
        context: { includeDeclaration: true },
      });
      return mapLocations(result);
    },
  });

  monaco.languages.registerDocumentSymbolProvider(python, {
    provideDocumentSymbols: async (model) => {
      const bridge = activeBridge;
      if (!bridge || bridge.status.state !== "ready") return [];
      const rel = modelPath(model);
      const uri = rel ? toWorkspaceUri(rel) : null;
      if (!uri) return [];
      const result = (await bridge.request("textDocument/documentSymbol", {
        textDocument: { uri },
      })) as DocumentSymbolLike[] | null;
      if (!Array.isArray(result)) return [];
      return result
        .map((s) => mapDocumentSymbol(s))
        .filter((s): s is monaco.languages.DocumentSymbol => !!s);
    },
  });

  monaco.languages.registerSignatureHelpProvider(python, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: async (model, position) => {
      const bridge = activeBridge;
      if (!bridge || bridge.status.state !== "ready") return null;
      const rel = modelPath(model);
      const uri = rel ? toWorkspaceUri(rel) : null;
      if (!uri) return null;
      const result = (await bridge.request("textDocument/signatureHelp", {
        textDocument: { uri },
        position: toLspPosition(position),
      })) as {
        signatures?: { label?: string; documentation?: unknown; parameters?: { label?: string | [number, number] }[] }[];
        activeSignature?: number;
        activeParameter?: number;
      } | null;
      if (!result?.signatures?.length) return null;
      return {
        value: {
          signatures: result.signatures.map((s) => ({
            label: String(s.label ?? ""),
            documentation: markupToString(s.documentation),
            parameters: (s.parameters ?? []).map((p) => ({
              label:
                typeof p.label === "string"
                  ? p.label
                  : String(p.label ?? ""),
            })),
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });
}

function modelPath(model: monaco.editor.ITextModel): string | null {
  const path = model.uri.path.startsWith("/")
    ? model.uri.path.slice(1)
    : model.uri.path;
  return path || null;
}

function toLspPosition(position: monaco.Position): {
  line: number;
  character: number;
} {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function fromLspRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

interface CompletionLike {
  label?: unknown;
  kind?: number;
  insertText?: unknown;
  detail?: unknown;
  documentation?: unknown;
  sortText?: unknown;
}

function mapCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 2:
      return K.Method;
    case 3:
      return K.Function;
    case 4:
      return K.Constructor;
    case 5:
      return K.Field;
    case 6:
      return K.Variable;
    case 7:
      return K.Class;
    case 10:
      return K.Property;
    case 14:
      return K.Keyword;
    case 17:
      return K.File;
    default:
      return K.Text;
  }
}

function markupToString(contents: unknown): string | undefined {
  if (!contents) return undefined;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => markupToString(c) ?? "").filter(Boolean).join("\n\n");
  }
  if (typeof contents === "object" && contents && "value" in contents) {
    return String((contents as { value: unknown }).value);
  }
  return undefined;
}

interface LocationLike {
  uri?: unknown;
  range?: LspRange;
  targetUri?: unknown;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

function mapLocations(
  result: unknown,
  revealFirst = false,
): monaco.languages.Location[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  const out: monaco.languages.Location[] = [];
  let revealed = false;
  for (const item of list as LocationLike[]) {
    const uriRaw = item.uri ?? item.targetUri;
    const rel = fromWorkspaceUri(uriRaw);
    if (!rel) continue;
    const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
    if (!range) continue;
    if (revealFirst && !revealed) {
      revealed = true;
      document.dispatchEvent(
        new CustomEvent(LSP_OPEN_REVEAL_EVENT, {
          detail: {
            filePath: rel,
            line: range.start.line + 1,
            column: range.start.character + 1,
          },
        }),
      );
    }
    out.push({
      uri: monaco.Uri.file(rel),
      range: fromLspRange(range),
    });
  }
  return out;
}

interface DocumentSymbolLike {
  name?: string;
  kind?: number;
  range?: LspRange;
  selectionRange?: LspRange;
  location?: { range?: LspRange };
  children?: DocumentSymbolLike[];
}

function mapDocumentSymbol(
  s: DocumentSymbolLike,
): monaco.languages.DocumentSymbol | null {
  const range = s.range ?? s.location?.range;
  const selection = s.selectionRange ?? range;
  if (!range || !selection || !s.name) return null;
  return {
    name: s.name,
    detail: "",
    kind: mapSymbolKind(s.kind),
    tags: [],
    range: fromLspRange(range),
    selectionRange: fromLspRange(selection),
    children: (s.children ?? [])
      .map((c) => mapDocumentSymbol(c))
      .filter((c): c is monaco.languages.DocumentSymbol => !!c),
  };
}

function mapSymbolKind(kind: number | undefined): monaco.languages.SymbolKind {
  const K = monaco.languages.SymbolKind;
  switch (kind) {
    case 5:
      return K.Class;
    case 6:
      return K.Method;
    case 12:
      return K.Function;
    case 13:
      return K.Variable;
    default:
      return K.File;
  }
}
