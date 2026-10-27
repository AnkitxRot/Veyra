import type { NextFunction, Request, Response } from "express";
import { log } from "./logger.js";

export class ApiError extends Error {
  status: number;
  code: string;
  /**
   * Optional structured payload merged into the JSON error body alongside
   * `error` (e.g. M56's `collaboratorImpacts` / `remainingDirty` on a 409).
   * Never contains file contents or secrets.
   */
  details?: Record<string, unknown>;
  /** Emitted as a `Retry-After` header (seconds) by errorMiddleware. */
  retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    code = "request_error",
    details?: Record<string, unknown>,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** M111: host is out of sandbox/RAM/run capacity; the client should retry. */
export const SERVER_BUSY_RETRY_AFTER_SECONDS = 10;
export function serverBusy(message = "server_busy"): ApiError {
  return new ApiError(503, message, "server_busy", undefined, SERVER_BUSY_RETRY_AFTER_SECONDS);
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    if (err.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(err.retryAfterSeconds));
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message }, ...(err.details ?? {}) });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "invalid_json", message: "invalid JSON body" } });
    return;
  }
  log.error("[error]", err);
  res.status(500).json({ error: { code: "internal_error", message: "internal server error" } });
}

export interface ErrorInfo {
  message?: string;
  code?: string;
  status?: number;
  stderr?: string;
}

/** Narrows an `unknown` caught value to the optional fields call sites read off errors. */
export function errorInfo(err: unknown): ErrorInfo {
  if (typeof err !== "object" || err === null) return {};
  const e = err as Record<string, unknown>;
  return {
    message: typeof e.message === "string" ? e.message : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
    stderr: typeof e.stderr === "string" ? e.stderr : undefined,
  };
}
