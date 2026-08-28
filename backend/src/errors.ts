import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  status: number;
  code: string;
  /**
   * Optional structured payload merged into the JSON error body alongside
   * `error` (e.g. M56's `collaboratorImpacts` / `remainingDirty` on a 409).
   * Never contains file contents or secrets.
   */
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code = 'request_error',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message }, ...(err.details ?? {}) });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'invalid_json', message: 'invalid JSON body' } });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'internal server error' } });
}
