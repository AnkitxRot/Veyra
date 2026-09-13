/**
 * Frontend copy of the server language allowlist (ids + extensions only).
 * Executable mapping lives exclusively on the backend.
 */

export type LspServerId = "python" | "typescript";

export interface LspLanguageInfo {
  id: LspServerId;
  monacoIds: readonly string[];
  chipLabel: string;
  extensions: readonly string[];
}

export const PYTHON_LSP: LspLanguageInfo = {
  id: "python",
  monacoIds: ["python"],
  chipLabel: "Py LSP",
  extensions: ["py", "pyi"],
};

export const TYPESCRIPT_LSP: LspLanguageInfo = {
  id: "typescript",
  monacoIds: ["typescript", "javascript"],
  chipLabel: "TS LSP",
  extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
};

const ALL: LspLanguageInfo[] = [PYTHON_LSP, TYPESCRIPT_LSP];

function extensionOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function lspLanguageForPath(relPath: string): LspLanguageInfo | null {
  const ext = extensionOf(relPath);
  if (!ext) return null;
  for (const spec of ALL) {
    if (spec.extensions.includes(ext)) return spec;
  }
  return null;
}

export function documentLanguageId(relPath: string): string {
  switch (extensionOf(relPath)) {
    case "py":
    case "pyi":
      return "python";
    case "tsx":
      return "typescriptreact";
    case "jsx":
      return "javascriptreact";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
      return "typescript";
    default:
      return "plaintext";
  }
}

export function isPythonPath(path: string): boolean {
  return lspLanguageForPath(path)?.id === "python";
}

export function isTypeScriptPath(path: string): boolean {
  return lspLanguageForPath(path)?.id === "typescript";
}

export function isLspPath(path: string): boolean {
  return lspLanguageForPath(path) !== null;
}

export function lspServerIdsForFiles(files: { path: string }[]): LspServerId[] {
  const ids = new Set<LspServerId>();
  for (const f of files) {
    const spec = lspLanguageForPath(f.path);
    if (spec) ids.add(spec.id);
  }
  return [...ids].sort();
}
