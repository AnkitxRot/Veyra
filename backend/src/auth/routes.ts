import { Router } from 'express';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issueSession, requireAuth, hashToken } from './middleware.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export function authRoutes(db: Db, sessionTtlMs: number): Router {
  const router = Router();

  const setCookie = (res: any, token: string, ttl: number) => {
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: ttl,
    });
  };

  router.post('/register', async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        throw new ApiError(400, 'username must be 3-32 characters of [a-zA-Z0-9_]', 'invalid_username');
      }
      if (typeof password !== 'string' || password.length < 4) {
        throw new ApiError(400, 'password must be at least 4 characters', 'invalid_password');
      }
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) throw new ApiError(409, 'username already taken', 'username_taken');
      const hash = await hashPassword(password);
      const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
      const userId = Number(info.lastInsertRowid);
      const token = issueSession(db, userId, sessionTtlMs);
      setCookie(res, token, sessionTtlMs);
      res.status(201).json({ token, user: { id: userId, username } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw new ApiError(400, 'username and password are required', 'invalid_credentials');
      }
      const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
        | { id: number; username: string; password_hash: string }
        | undefined;
      
      let valid = false;
      if (row) {
        valid = await verifyPassword(password, row.password_hash);
      }
      if (!row || !valid) {
        throw new ApiError(401, 'invalid username or password', 'invalid_credentials');
      }
      const token = issueSession(db, row.id, sessionTtlMs);
      setCookie(res, token, sessionTtlMs);
      res.json({ token, user: { id: row.id, username: row.username } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth(db), (req, res) => {
    const header = req.headers.authorization ?? '';
    let token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token && req.cookies && req.cookies.session_token) {
      token = req.cookies.session_token;
    }
    if (token) {
      const hashedToken = hashToken(token);
      db.prepare('DELETE FROM sessions WHERE token = ?').run(hashedToken);
    }
    res.clearCookie('session_token', { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(db), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
