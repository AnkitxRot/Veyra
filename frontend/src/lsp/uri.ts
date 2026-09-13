export const WORKSPACE_URI_PREFIX = "file:///workspace/";
export const WORKSPACE_ROOT_URI = "file:///workspace";

export function toWorkspaceUri(relPath: string): string | null {
  const rel = normalizeRelPath(relPath);
  if (rel === null) return null;
  return (
    WORKSPACE_URI_PREFIX + rel.split("/").map(encodeURIComponent).join("/")
  );
}

export function fromWorkspaceUri(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) {
    return null;
  }
  if (uri.includes("\0") || uri.includes("\\")) return null;
  if (uri === WORKSPACE_ROOT_URI || uri === `${WORKSPACE_ROOT_URI}/`) return "";
  if (!uri.startsWith(WORKSPACE_URI_PREFIX)) return null;
  try {
    const decoded = uri
      .slice(WORKSPACE_URI_PREFIX.length)
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
    return normalizeRelPath(decoded);
  } catch {
    return null;
  }
}

export function normalizeRelPath(relPath: unknown): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.length > 512) return null;
  if (relPath.includes("\0")) return null;
  if (
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(relPath)
  ) {
    return null;
  }
  const n = relPath.replace(/\\/g, "/");
  if (!n) return null;
  const parts = n.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

export function isPythonPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return /\.pyi?$/i.test(base);
}
