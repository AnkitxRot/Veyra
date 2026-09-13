/**
 * Workspace path mapping for debug adapters running at `/workspace` inside
 * a project sandbox. Adapters speak filesystem paths (and occasionally
 * `file://` URIs). The client only ever sees workspace-relative paths.
 */

import {
  fromWorkspaceUri,
  normalizeRelPath,
  toWorkspaceUri,
  WORKSPACE_ROOT_URI,
} from "../lsp/uri.js";

export const WORKSPACE_FS_PREFIX = "/workspace/";
export const WORKSPACE_FS_ROOT = "/workspace";

const MAX_PATH = 512;

export { normalizeRelPath, toWorkspaceUri, fromWorkspaceUri };

/** `/workspace/foo.py` for a validated relative path. */
export function toWorkspaceFsPath(relPath: string): string | null {
  const rel = normalizeRelPath(relPath);
  if (rel === null) return null;
  return WORKSPACE_FS_PREFIX + rel;
}

/**
 * Accept a debug-adapter source location and return a workspace-relative
 * path, or null if the location is outside `/workspace`.
 */
export function fromWorkspaceLocation(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  if (value.includes("\0")) return null;
  const trimmed = value.replace(/\\/g, "/");
  if (trimmed.startsWith("file:")) {
    return fromWorkspaceUri(trimmed);
  }
  if (trimmed === WORKSPACE_FS_ROOT || trimmed === `${WORKSPACE_FS_ROOT}/`) {
    return "";
  }
  if (trimmed.startsWith(WORKSPACE_FS_PREFIX)) {
    return normalizeRelPath(trimmed.slice(WORKSPACE_FS_PREFIX.length));
  }
  // Bare relative path (already workspace-relative).
  if (!trimmed.startsWith("/") && !/^[a-zA-Z]:/.test(trimmed)) {
    return normalizeRelPath(trimmed);
  }
  return null;
}

export function isWorkspaceLocation(value: unknown): boolean {
  return fromWorkspaceLocation(value) !== null;
}

export function basenameOf(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] ?? relPath;
}

/** Drop `.git/` internals even when the path is otherwise workspace-legal. */
export function isForbiddenRelPath(rel: string): boolean {
  if (rel.length > MAX_PATH) return true;
  const first = rel.split("/")[0];
  return first === ".git";
}

export { WORKSPACE_ROOT_URI };
