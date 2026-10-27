import type { NextFunction, Request, Response } from "express";
import { RateLimiter } from "./auth/ratelimit.js";
import { ApiError } from "./errors.js";

export type RouteBucket = "files" | "run" | "git" | "ai";
export interface BucketLimit {
  max: number;
  windowMs: number;
}
export type RouteLimits = Record<RouteBucket, BucketLimit>;

export const DEFAULT_ROUTE_LIMITS: RouteLimits = {
  files: { max: 600, windowMs: 60_000 },
  run: { max: 30, windowMs: 60_000 },
  git: { max: 120, windowMs: 60_000 },
  ai: { max: 30, windowMs: 60_000 },
};

/** Maps a path relative to /api/projects to a limiter bucket, or null. */
export function classifyProjectPath(path: string): RouteBucket | null {
  const m = /^\/[^/]+\/([^/]+)/.exec(path);
  if (!m) return null;
  switch (m[1]) {
    case "file":
    case "files":
    case "tree":
    case "upload":
    case "move":
    case "import":
      return "files";
    case "run":
    case "install":
      return "run";
    case "git":
      return "git";
    case "ai":
      return "ai";
    default:
      return null;
  }
}

/** Per-user (falling back to IP) limiter for heavy project routes. Mount after requireAuth. */
export function routeRateLimit(limits: RouteLimits = DEFAULT_ROUTE_LIMITS) {
  const limiters = new Map<RouteBucket, RateLimiter>();
  for (const b of Object.keys(limits) as RouteBucket[]) {
    limiters.set(b, new RateLimiter(limits[b].max, limits[b].windowMs));
  }
  return (req: Request, _res: Response, next: NextFunction): void => {
    const bucket = classifyProjectPath(req.path);
    if (!bucket) return next();
    const who = req.user?.id !== undefined ? `u${req.user.id}` : `ip${req.ip ?? ""}`;
    if (!limiters.get(bucket)!.allow(`${bucket}:${who}`)) {
      return next(new ApiError(429, "rate limit exceeded", "rate_limited", { bucket }));
    }
    next();
  };
}
