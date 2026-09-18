/**
 * Allowlisted debug adapters.
 *
 * The client may name a language id from this table. It may never name an
 * executable, argv, cwd, container, or environment. Adding a language means
 * adding a spec here and installing the adapter in `docker/Dockerfile.runner`.
 */

export type DebugLanguageId = "python" | "node";

export interface DebugLanguageSpec {
  id: DebugLanguageId;
  displayName: string;
  extensions: readonly string[];
  /** Executable discovered inside the sandbox image, never from the client. */
  command: string;
  args: readonly string[];
  extraEnv: readonly string[];
  /** DAP initialize adapterID. */
  adapterId: string;
  startupTimeoutMs?: number;
}

export const PYTHON_DEBUG: DebugLanguageSpec = {
  id: "python",
  displayName: "Python",
  extensions: ["py"],
  command: "veyra-debugpy",
  args: [],
  extraEnv: ["PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1"],
  adapterId: "debugpy",
};

export const NODE_DEBUG: DebugLanguageSpec = {
  id: "node",
  displayName: "Node.js / TypeScript",
  extensions: ["js", "mjs", "cjs", "ts"],
  command: "veyra-js-debug",
  args: [],
  extraEnv: ["NODE_PATH=/usr/local/lib/node_modules"],
  adapterId: "pwa-node",
};

const BY_ID = new Map<string, DebugLanguageSpec>([
  [PYTHON_DEBUG.id, PYTHON_DEBUG],
  [NODE_DEBUG.id, NODE_DEBUG],
]);

export function getDebugLanguage(id: unknown): DebugLanguageSpec | null {
  if (typeof id !== "string") return null;
  if (!/^[a-z][a-z0-9]{0,31}$/.test(id)) return null;
  return BY_ID.get(id) ?? null;
}

export function debugLanguageForPath(relPath: string): DebugLanguageSpec | null {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  for (const spec of BY_ID.values()) {
    if (spec.extensions.includes(ext)) return spec;
  }
  return null;
}

export function supportedDebugLanguageIds(): DebugLanguageId[] {
  return [...BY_ID.keys()] as DebugLanguageId[];
}

export function languageMatchesEntry(
  spec: DebugLanguageSpec,
  entryFile: string,
): boolean {
  const expected = debugLanguageForPath(entryFile);
  return expected?.id === spec.id;
}
