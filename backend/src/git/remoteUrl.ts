import { ApiError } from "../errors.js";

/**
 * M80 — canonical HTTPS Git remote URL validator.
 *
 * Accepts only `https://` remotes. Rejects every other scheme, SCP-like
 * `git@host:path` forms, filesystem paths, and any URL that carries
 * userinfo (credentials). Unsafe input is never rewritten into an allowed
 * URL — the caller gets a structured error instead.
 */

export const MAX_REMOTE_URL_LENGTH = 2048;

/** C0 controls + DEL. Implemented without a control-character regex so
 *  `no-control-regex` stays enforced. */
export function containsAsciiControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateHttpsGitRemoteUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REMOTE_URL_LENGTH) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }
  if (containsAsciiControlChars(trimmed)) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }
  // WHATWG URL parsers rewrite `\` to `/`. Reject rather than silently
  // normalize a backslash-bearing input into an allowed HTTPS remote.
  if (trimmed.includes("\\")) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }

  // Local / relative / UNC / home paths — never treat these as remotes.
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~") ||
    /^[a-zA-Z]:[/\\]/.test(trimmed) ||
    trimmed.startsWith("//")
  ) {
    throw new ApiError(
      400,
      "local filesystem paths are not allowed as Git remotes",
      "invalid_remote_url",
    );
  }

  // SCP-like `git@host:path` (no scheme). Do not coerce to https.
  if (!trimmed.includes("://") && /^[^/\s]+@[^/\s]+:/.test(trimmed)) {
    throw new ApiError(
      400,
      "only HTTPS Git remotes are supported",
      "unsupported_protocol",
    );
  }

  if (!trimmed.includes("://")) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }

  if (url.protocol !== "https:") {
    throw new ApiError(
      400,
      "only HTTPS Git remotes are supported",
      "unsupported_protocol",
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new ApiError(
      400,
      "remote URLs must not contain credentials",
      "credential_bearing_url",
    );
  }

  if (!url.hostname) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }

  // Query/hash make the remote ambiguous (and are not used by Git clone URLs).
  if (url.search || url.hash) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }

  const path = url.pathname || "";
  if (path === "" || path === "/") {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }
  if (path.includes("\\") || containsAsciiControlChars(path)) {
    throw new ApiError(400, "invalid remote URL", "invalid_remote_url");
  }

  // Reconstruct from parsed parts so leftover userinfo cannot survive.
  // Use `host` (not hostname+port) so IPv6 literals keep their brackets.
  return `https://${url.host}${path}`;
}

/**
 * WHATWG `hostname` is usually unbracketed (`::1`). Some Node builds keep
 * the brackets (`[::1]`). Normalize so askpass / audit comparisons agree.
 */
export function normalizeHttpsHostname(hostname: string): string {
  const h = hostname.trim();
  if (h.startsWith("[") && h.endsWith("]") && h.includes(":")) {
    return h.slice(1, -1);
  }
  return h;
}

/** Host only — safe for audit / askpass allowlisting. */
export function httpsRemoteHost(url: string): string {
  return normalizeHttpsHostname(new URL(url).hostname);
}

/**
 * Strip userinfo before a remote URL is returned to a client or written to
 * an audit payload. Never throws; malformed input becomes a placeholder.
 */
export function sanitizeRemoteUrlForClient(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return "(unsupported remote)";
    u.username = "";
    u.password = "";
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    return "(invalid remote url)";
  }
}

/** Compare two validated HTTPS remotes ignoring a trailing `.git` / slash. */
export function httpsRemotesEquivalent(a: string, b: string): boolean {
  try {
    const ua = new URL(validateHttpsGitRemoteUrl(a));
    const ub = new URL(validateHttpsGitRemoteUrl(b));
    const norm = (p: string) =>
      p.replace(/\/+$/, "").replace(/\.git$/i, "") || "/";
    return (
      ua.hostname.toLowerCase() === ub.hostname.toLowerCase() &&
      ua.port === ub.port &&
      norm(ua.pathname) === norm(ub.pathname)
    );
  } catch {
    return false;
  }
}
