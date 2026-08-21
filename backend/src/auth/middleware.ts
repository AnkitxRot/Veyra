import { randomBytes, createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';

export interface AuthUser {
  id: number;
  username: string;
  role: 'user' | 'admin';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Removes expired sessions; returns the number deleted. */
export function deleteExpiredSessions(db: Db): number {
  const info = db
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(new Date().toISOString());
  return Number(info.changes);
}

export function requireAuth(db: Db) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    let token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token && req.cookies && req.cookies.session_token) {
      token = req.cookies.session_token;
    }
    if (!token) {
      next(new ApiError(401, 'authentication required', 'unauthorized'));
      return;
    }
    const hashedToken = hashToken(token);
    const row = db
      .prepare(
        `SELECT s.token, s.expires_at, u.id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
      )
      .get(hashedToken) as { token: string; expires_at: string; id: number; username: string; role?: string } | undefined;
    if (!row) {
      next(new ApiError(401, 'invalid or expired session', 'unauthorized'));
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(hashedToken);
      next(new ApiError(401, 'session expired', 'unauthorized'));
      return;
    }
    req.user = {
      id: row.id,
      username: row.username,
      role: (row.role as 'user' | 'admin') || 'user',
    };
    next();
  };
}

export function requireAdmin(db: Db) {
  const auth = requireAuth(db);
  return (req: Request, res: Response, next: NextFunction): void => {
    auth(req, res, (err) => {
      if (err) return next(err);
      if (req.user?.role !== 'admin') {
        return next(new ApiError(403, 'admin privileges required', 'forbidden'));
      }
      next();
    });
  };
}

export function issueSession(db: Db, userId: number, ttlMs: number): string {
  const token = randomToken();
  const hashedToken = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(hashedToken, userId, expiresAt);
  return token;
}

export function randomToken(): string {
  return randomBytes(32).toString('hex');
}
