/**
 * Allowlisted language-server adapters.
 *
 * The client may name a language id from this table. It may never name an
 * executable, argv, cwd, or environment. Adding a language means adding a
 * spec here and installing the binary in `docker/Dockerfile.runner`.
 *
 * This is the M82 adapter layer: Python (pylsp) and TypeScript/JavaScript
 * (typescript-language-server) share process lifecycle, JSON-RPC, URI
 * rewriting, and document sync. Language-specific behaviour is only
 * executable, initialization options, extra container env, and the LSP
 * `textDocument.languageId` for a given path.
 */

export interface LspLanguageSpec {
  /** Stable id used on `/ws/lsp?language=`. */
  id: string;
  /** Primary Monaco language id (status chip / providers). */
  monacoId: string;
  /** Every Monaco id this server answers (providers register on each). */
  monacoIds: readonly string[];
  displayName: string;
  /** Toolbar chip label. */
  chipLabel: string;
  extensions: readonly string[];
  /** Executable discovered inside the sandbox image, never from the client. */
  command: string;
  args: readonly string[];
  /**
   * Extra `-e KEY=VALUE` pairs for `docker exec`. Shared HOME/XDG/LANG are
   * applied by the spawn layer; this list is language-specific only.
   */
  extraEnv: readonly string[];
  initializationOptions: Record<string, unknown>;
  /** Optional override; otherwise the session uses AppConfig.lspStartupTimeoutMs. */
  startupTimeoutMs?: number;
  /** LSP textDocument.languageId for a workspace-relative path. */
  documentLanguageId: (relPath: string) => string;
}

function extensionOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export const PYTHON_LSP: LspLanguageSpec = {
  id: "python",
  monacoId: "python",
  monacoIds: ["python"],
  displayName: "Python",
  chipLabel: "Py LSP",
  extensions: ["py", "pyi"],
  command: "pylsp",
  args: [],
  extraEnv: ["PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1"],
  initializationOptions: {
    pylsp: {
      plugins: {
        pycodestyle: { enabled: true, maxLineLength: 100 },
        pyflakes: { enabled: true },
        autopep8: { enabled: false },
        yapf: { enabled: false },
        mccabe: { enabled: false },
      },
    },
  },
  documentLanguageId: () => "python",
};

export const TYPESCRIPT_LSP: LspLanguageSpec = {
  id: "typescript",
  monacoId: "typescript",
  monacoIds: ["typescript", "javascript"],
  displayName: "TypeScript / JavaScript",
  chipLabel: "TS LSP",
  extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  command: "typescript-language-server",
  args: ["--stdio"],
  extraEnv: [],
  initializationOptions: {
    // Do not run npm/yarn/pnpm. tsserver reads the workspace as-is;
    // missing node_modules degrades to module-resolution diagnostics.
    hostInfo: "veyra",
  },
  documentLanguageId: (relPath: string) => {
    switch (extensionOf(relPath)) {
      case "tsx":
        return "typescriptreact";
      case "jsx":
        return "javascriptreact";
      case "js":
      case "mjs":
      case "cjs":
        return "javascript";
      default:
        return "typescript";
    }
  },
};

const BY_ID = new Map<string, LspLanguageSpec>([
  [PYTHON_LSP.id, PYTHON_LSP],
  [TYPESCRIPT_LSP.id, TYPESCRIPT_LSP],
]);

export function getLspLanguage(id: unknown): LspLanguageSpec | null {
  if (typeof id !== "string") return null;
  if (!/^[a-z][a-z0-9]{0,31}$/.test(id)) return null;
  return BY_ID.get(id) ?? null;
}

export function lspLanguageForPath(relPath: string): LspLanguageSpec | null {
  const ext = extensionOf(relPath);
  if (!ext) return null;
  for (const spec of BY_ID.values()) {
    if (spec.extensions.includes(ext)) return spec;
  }
  return null;
}

export function supportedLspLanguageIds(): string[] {
  return [...BY_ID.keys()];
}

export function allLspLanguageSpecs(): LspLanguageSpec[] {
  return [...BY_ID.values()];
}
