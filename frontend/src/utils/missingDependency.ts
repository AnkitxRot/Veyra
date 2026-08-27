/**
 * M44: a narrow, conservative detector for the two well-known "you forgot to
 * install dependencies" runtime error shapes — Python's ModuleNotFoundError
 * and Node's require() "Cannot find module" error. Deliberately does NOT
 * attempt to recognize any other error class (generic ImportError, syntax
 * errors, npm's own package-manager-level "npm ERR!" logs, arbitrary
 * runtime exceptions, etc.) — a false positive here would misleadingly tell
 * a user that clicking Install will fix an unrelated failure.
 */

export type MissingDependencyKind = "python" | "node";

export interface MissingDependencyMatch {
  kind: MissingDependencyKind;
  moduleName: string;
}

// Python: `ModuleNotFoundError: No module named 'requests'` (the module
// name is always single- or double-quoted by CPython's own formatter).
const PYTHON_MODULE_NOT_FOUND =
  /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/;

// Node: `Error: Cannot find module 'express'` (Node's own require() error
// message — distinct from npm's package-manager-level "npm ERR!" output,
// which is intentionally NOT matched here).
const NODE_CANNOT_FIND_MODULE = /Cannot find module ['"]([^'"]+)['"]/;

/**
 * Scans run output (stderr, or combined stdout+stderr) for exactly one of
 * the two known missing-dependency error shapes. Returns the first match
 * found, or null if neither pattern is present. Intentionally returns at
 * most one match even if the pattern repeats (e.g. a traceback that
 * mentions the same module name twice) — callers only need to know whether
 * to show the affordance, not enumerate every occurrence.
 */
export function detectMissingDependency(
  output: string,
): MissingDependencyMatch | null {
  if (!output) return null;

  const pythonMatch = output.match(PYTHON_MODULE_NOT_FOUND);
  if (pythonMatch) {
    return { kind: "python", moduleName: pythonMatch[1] };
  }

  const nodeMatch = output.match(NODE_CANNOT_FIND_MODULE);
  if (nodeMatch) {
    return { kind: "node", moduleName: nodeMatch[1] };
  }

  return null;
}
