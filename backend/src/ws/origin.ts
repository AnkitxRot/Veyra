import type { IncomingMessage } from "node:http";

/**
 * Cross-site WebSocket hijacking guard. Browsers always send `Origin` on
 * WebSocket upgrades; cookie auth alone would let any site open a socket as
 * the logged-in user. Non-browser clients send no Origin and are allowed
 * (they still need a valid session cookie).
 *
 * Allowed: an explicit allowlist entry (exact origin match), or, when the
 * allowlist is empty, an Origin whose host equals the request Host header.
 */
export function isOriginAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.length > 0) {
    return allowed.includes(parsed.origin);
  }
  const host = req.headers.host;
  return !!host && parsed.host.toLowerCase() === host.toLowerCase();
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        throw new Error(`ALLOWED_ORIGINS: invalid origin "${s}"`);
      }
    });
}
