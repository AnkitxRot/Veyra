/**
 * M81 — allowlisted language-server executables.
 *
 * The client may name a language id from this table. It may never name an
 * executable, argv, cwd, or environment. Adding a language means adding a
 * row here and installing the binary in `docker/Dockerfile.runner`.
 */

export interface LspLanguageSpec {
  /** Stable id used on `/ws/lsp?language=`. */
  id: string;
  /** Monaco / frontend language id. */
  monacoId: string;
  displayName: string;
  extensions: readonly string[];
  /** Executable discovered inside the sandbox image, never from the client. */
  command: string;
  args: readonly string[];
}

export const PYTHON_LSP: LspLanguageSpec = {
  id: "python",
  monacoId: "python",
  displayName: "Python",
  extensions: ["py", "pyi"],
  command: "pylsp",
  args: [],
};

const BY_ID = new Map<string, LspLanguageSpec>([[PYTHON_LSP.id, PYTHON_LSP]]);

export function getLspLanguage(id: unknown): LspLanguageSpec | null {
  if (typeof id !== "string") return null;
  if (!/^[a-z][a-z0-9]{0,31}$/.test(id)) return null;
  return BY_ID.get(id) ?? null;
}

export function lspLanguageForPath(relPath: string): LspLanguageSpec | null {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  for (const spec of BY_ID.values()) {
    if (spec.extensions.includes(ext)) return spec;
  }
  return null;
}

export function supportedLspLanguageIds(): string[] {
  return [...BY_ID.keys()];
}
