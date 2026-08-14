import { Router } from 'express';
import type { Request } from 'express';
import type { Db } from '../db.js';
import { type AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import {
  createProject,
  deleteProject,
  listProjects,
  requireOwnedProject,
  touchProject,
  workspacePath,
} from './service.js';
import { resolveInstallSpec } from './install.js';
import {
  deleteProjectPath,
  moveProjectPath,
  readProjectFile,
  tree,
  writeProjectFile,
} from '../files/service.js';
import { runProject } from '../execution/pipeline.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { sandboxManager, sandboxRun } from '../execution/sandbox.js';
import { runGate } from '../execution/runGate.js';

export function projectRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router();
  const userOf = (req: Request) => req.user!;

  router.get('/', (req, res) => {
    res.json({ projects: listProjects(db, userOf(req).id) });
  });

  router.post('/', async (req, res, next) => {
    try {
      const { name, language } = req.body ?? {};
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new ApiError(400, 'name is required', 'invalid_name');
      }
      const project = await createProject(cfg, db, userOf(req).id, { name, language });
      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', (req, res) => {
    res.json({ project: requireOwnedProject(db, userOf(req).id, req.params.id) });
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await deleteProject(cfg, db, userOf(req).id, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/tree', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const cwd = await workspacePath(cfg, project.id);
      res.json({ tree: await tree(cwd) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/file', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const path = req.query.path;
      if (typeof path !== 'string') throw new ApiError(400, 'path query parameter is required', 'invalid_path');
      const cwd = await workspacePath(cfg, project.id);
      res.json(await readProjectFile(cwd, path));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/file', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { path, content } = req.body ?? {};
      if (typeof path !== 'string') throw new ApiError(400, 'path is required', 'invalid_path');
      if (typeof content !== 'string') throw new ApiError(400, 'content is required', 'invalid_content');
      const cwd = await workspacePath(cfg, project.id);
      await writeProjectFile(cwd, path, content);
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/move', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { from, to } = req.body ?? {};
      if (typeof from !== 'string' || typeof to !== 'string') {
        throw new ApiError(400, 'from and to are required', 'invalid_path');
      }
      const cwd = await workspacePath(cfg, project.id);
      res.json(await moveProjectPath(cwd, from, to));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/delete', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { path } = req.body ?? {};
      if (typeof path !== 'string') throw new ApiError(400, 'path is required', 'invalid_path');
      const cwd = await workspacePath(cfg, project.id);
      await deleteProjectPath(cwd, path);
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/run', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { language, stdin } = req.body ?? {};
      if (language !== undefined && typeof language !== 'string') {
        throw new ApiError(400, 'language must be a string', 'invalid_language');
      }
      if (stdin !== undefined && typeof stdin !== 'string') {
        throw new ApiError(400, 'stdin must be a string', 'invalid_stdin');
      }
      const userId = userOf(req).id;
      if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, 'concurrent execution limit reached', 'too_many_runs');
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        const result = await runProject(cfg, project.id, cwd, { language, stdin });
        res.json(result);
      } finally {
        runGate.release(userId);
      }
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/install', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const userId = userOf(req).id;
      if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, 'concurrent execution limit reached', 'too_many_runs');
      }
      try {
        const workspaceDir = await workspacePath(cfg, project.id);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const { language } = project;
        const installResult = await resolveInstallSpec({ workspaceDir, language });

        if (!installResult.cmd) {
          res.write(installResult.message + '\n');
          res.end();
          return;
        }

        res.write(`Running ${installResult.cmd} ${installResult.args.join(' ')}...\n\n`);

        const result = await sandboxRun(project.id, workspaceDir, {
          command: installResult.cmd,
          args: installResult.args,
          cwd: workspaceDir,
          timeoutMs: 60000,
          kind: 'build',
          config: cfg,
          onStdout: (data) => res.write(data),
          onStderr: (data) => res.write(data),
        });

        res.write(`\nProcess exited with code ${result.exitCode}\n`);
        res.end();
      } finally {
        runGate.release(userId);
      }
    } catch (err) {
      if (!res.headersSent) {
        next(err);
      } else {
        res.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
        res.end();
      }
    }
  });

  router.use('/:id/proxy/:port', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);

      const port = parseInt(req.params.port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new ApiError(400, 'Invalid port', 'invalid_port');
      }

      const target = await sandboxManager.getProxyTarget(project.id, port, cfg.containerized);
      if (!target) {
        throw new ApiError(404, `Port ${port} is not published by the sandbox`, 'not_found');
      }

      const pathRewrite = { [`^/api/projects/${req.params.id}/proxy/${port}`]: '' };

      const proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        pathRewrite,
        ws: true,
      });

      proxy(req as any, res as any, next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
