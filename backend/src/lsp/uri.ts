/**
 * Workspace URI mapping for language servers running at `/workspace` inside
 * a project sandbox. The only legal document URIs are under
 * `file:///workspace/…`. Client-supplied URIs that escape that prefix are
 * dropped, never rewritten into a "close enough" path.
 */

export const WORKSPACE_URI_PREFIX = "file:///workspace/";
export const WORKSPACE_ROOT_URI = "file:///workspace";

const MAX_REL_PATH = 512;

export function toWorkspaceUri(relPath: string): string | null {
  const rel = normalizeRelPath(relPath);
  if (rel === null) return null;
  return WORKSPACE_URI_PREFIX + rel.split("/").map(encodeURIComponent).join("/");
}

export function fromWorkspaceUri(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) {
    return null;
  }
  if (uri.includes("\0") || uri.includes("\\")) return null;
  if (uri === WORKSPACE_ROOT_URI || uri === `${WORKSPACE_ROOT_URI}/`) {
    return "";
  }
  if (!uri.startsWith(WORKSPACE_URI_PREFIX)) return null;

  let decoded: string;
  try {
    decoded = uri
      .slice(WORKSPACE_URI_PREFIX.length)
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    return null;
  }
  return normalizeRelPath(decoded);
}

export function normalizeRelPath(relPath: unknown): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.length > MAX_REL_PATH) return null;
  if (relPath.includes("\0")) return null;
  if (
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(relPath)
  ) {
    return null;
  }
  const n = relPath.replace(/\\/g, "/");
  if (n.length === 0 || n.length > MAX_REL_PATH) return null;
  const parts = n.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

/**
 * Walk a JSON-RPC payload and rewrite every `uri` / `rootUri` / `targetUri`
 * string. Returns null when any such field is present and illegal — callers
 * must drop the message rather than forward a partial rewrite.
 */
export function rewriteUris(
  value: unknown,
  map: (uri: string) => string | null,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: rewrite(value, map) };
  } catch {
    return { ok: false };
  }
}

function rewrite(
  value: unknown,
  map: (uri: string) => string | null,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => rewrite(v, map));
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (
        (k === "uri" || k === "rootUri" || k === "targetUri") &&
        typeof v === "string"
      ) {
        const mapped = map(v);
        if (mapped === null) throw new Error("illegal_uri");
        out[k] = mapped;
      } else if (k === "workspaceFolders" && Array.isArray(v)) {
        out[k] = rewrite(v, map);
      } else {
        out[k] = rewrite(v, map);
      }
    }
    return out;
  }
  return value;
}
