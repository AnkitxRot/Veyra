import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";

/**
 * CSP for the IDE shell. Monaco needs blob: workers and inline styles; the
 * preview iframe is same-origin (frame-src 'self'). User-app proxy responses
 * are excluded: they carry the previewed app's own markup.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const PROXY_PATH = /^\/api\/projects\/[^/]+\/proxy\//;

export function isProxyPath(path: string): boolean {
  return PROXY_PATH.test(path);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated mutating requests. Browsers attach
 * `Origin` (or at least `Sec-Fetch-Site`) to cross-site writes, so a request
 * that declares itself cross-site is rejected. Requests with neither header
 * (curl, server-to-server, Bearer clients) carry no ambient browser
 * credentials and pass. Complements SameSite=Lax on the session cookie.
 */
export function csrfGuard(allowedOrigins: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const u = new URL(origin);
        ok = allowedOrigins.length > 0 ? allowedOrigins.includes(u.origin) : u.host === req.headers.host;
      } catch {
        ok = false;
      }
      if (!ok) return next(new ApiError(403, "cross-origin request rejected", "csrf_rejected"));
      return next();
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return next(new ApiError(403, "cross-site request rejected", "csrf_rejected"));
    }
    next();
  };
}

/**
 * Gate for /metrics: a bearer token (METRICS_TOKEN) or, absent a token, an IP
 * allowlist (default loopback only). Constant-time token comparison.
 */
export function metricsGate(token: string | undefined, allowedIps: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (token) {
      const got = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const a = Buffer.from(got);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return next();
      return next(new ApiError(401, "metrics token required", "unauthorized"));
    }
    const ip = (req.ip ?? "").replace(/^::ffff:/, "");
    if (allowedIps.includes(ip)) return next();
    return next(new ApiError(403, "forbidden", "forbidden"));
  };
}
