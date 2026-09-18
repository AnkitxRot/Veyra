import { normalizeRelPath } from "../lsp/uri";

export type DebugLanguageId = "python" | "node";

const PYTHON_EXT = new Set(["py"]);
const NODE_EXT = new Set(["js", "mjs", "cjs", "ts"]);

function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function debugLanguageForPath(path: string | null): DebugLanguageId | null {
  if (!path) return null;
  const rel = normalizeRelPath(path);
  if (!rel) return null;
  const ext = extOf(rel);
  if (PYTHON_EXT.has(ext)) return "python";
  if (NODE_EXT.has(ext)) return "node";
  return null;
}

export function isDebuggablePath(path: string | null): boolean {
  return debugLanguageForPath(path) !== null;
}

export interface DebugCapabilities {
  docker?: boolean;
  runnerImage?: boolean;
  debugger?: {
    python?: boolean;
    node?: boolean;
  };
}

/** Toolbar/start gate: language allowlist + sandbox availability. */
export function canDebugPath(
  path: string | null,
  capabilities: DebugCapabilities | null | undefined,
): boolean {
  const lang = debugLanguageForPath(path);
  if (!lang) return false;
  if (!capabilities?.docker || !capabilities?.runnerImage) return false;
  if (!capabilities.debugger) return true;
  return lang === "python"
    ? capabilities.debugger.python === true
    : capabilities.debugger.node === true;
}
