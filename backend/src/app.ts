import express from 'express';
import cookieParser from 'cookie-parser';
import type { AppConfig } from './config.js';
import { IS_WINDOWS } from './config.js';
import { openDb } from './db.js';
import { errorMiddleware, ApiError } from './errors.js';
import { authRoutes } from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import { projectRoutes } from './projects/routes.js';
import { getSystemCapabilities } from './tools.js';
import { initCgroupRoot } from './execution/sandbox.js';
import { mkdirSync } from 'node:fs';

export function initDirectories(cfg: AppConfig): void {
  mkdirSync(cfg.workspacesDir, { recursive: true });
  if (!IS_WINDOWS) {
    initCgroupRoot(cfg.cgroupRoot);
  }
}

export function createApp(cfg: AppConfig): express.Express {
  initDirectories(cfg);
  const db = openDb(cfg.dbPath);
  const app = express();
  app.disable('x-powered-by');
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, runUser: cfg.runUser.user, platform: process.platform });
  });

  app.get('/api/system/capabilities', (_req, res) => {
    res.json(getSystemCapabilities());
  });

  app.use('/api/auth', authRoutes(db, cfg.sessionTtlMs));
  app.use('/api/projects', requireAuth(db), projectRoutes(cfg, db));

  app.use((_req, _res, next) => next(new ApiError(404, 'not found', 'not_found')));
  app.use(errorMiddleware);

  return app;
}
