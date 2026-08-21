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
  requireProjectAccess,
  listProjectCollaborators,
  addProjectCollaborator,
  removeProjectCollaborator,
  touchProject,
  workspacePath,
  projectDir,
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
import { STARTER_TEMPLATES, applyTemplate } from './templates.js';
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
} from './snapshots.js';
import { searchProjectContent } from './search.js';
import { formatProjectFile } from './format.js';
import { telemetryHistorian } from '../execution/historian.js';
import { collaborationManager } from '../collab/manager.js';

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

  // Starter Templates
  router.get('/templates/catalog', (_req, res) => {
    res.json({ templates: STARTER_TEMPLATES });
  });

  router.post('/from-template', async (req, res, next) => {
    try {
      const { templateId, name } = req.body ?? {};
      const tpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
      if (!tpl) throw new ApiError(400, 'Invalid template ID', 'invalid_template');

      const projectName = typeof name === 'string' && name.trim() ? name.trim() : tpl.name;
      const project = await createProject(cfg, db, userOf(req).id, {
        name: projectName,
        language: tpl.language,
      });

      const cwd = projectDir(cfg, project.id);
      await applyTemplate(cwd, tpl.id);

      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', (req, res, next) => {
    try {
      const access = requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
      res.json({ project: access.project, role: access.role });
    } catch (err) {
      next(err);
    }
  });

  // Collaborators Management
  router.get('/:id/collaborators', (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
      const collaborators = listProjectCollaborators(db, req.params.id);
      res.json({ collaborators });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/collaborators', (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, 'owner');
      const { username, role } = req.body ?? {};
      if (typeof username !== 'string' || !username.trim()) {
        throw new ApiError(400, 'username is required', 'invalid_username');
      }

      const targetUser = db
        .prepare('SELECT id, username FROM users WHERE username = ?')
        .get(username.trim()) as { id: number; username: string } | undefined;

      if (!targetUser) {
        throw new ApiError(404, `User "${username}" not found`, 'user_not_found');
      }

      const collabRole = role === 'viewer' ? 'viewer' : 'editor';
      addProjectCollaborator(db, req.params.id, targetUser.id, collabRole);

      res.status(201).json({
        ok: true,
        collaborator: {
          userId: targetUser.id,
          username: targetUser.username,
          role: collabRole,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id/collaborators/:userId', (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, 'owner');
      const targetUserId = parseInt(req.params.userId, 10);
      if (isNaN(targetUserId)) throw new ApiError(400, 'invalid user ID', 'invalid_id');

      removeProjectCollaborator(db, req.params.id, targetUserId);
      collaborationManager.revokeUser(req.params.id, targetUserId);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/collaborators/:userId', (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, 'owner');
      const targetUserId = parseInt(req.params.userId, 10);
      const { role } = req.body ?? {};
      if (role !== 'editor' && role !== 'viewer') {
        throw new ApiError(400, 'role must be editor or viewer', 'invalid_role');
      }

      addProjectCollaborator(db, req.params.id, targetUserId, role);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await deleteProject(cfg, db, userOf(req).id, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Live Container Resource Telemetry
  router.get('/:id/stats', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
      const stats = await sandboxManager.getContainerStats(project.id);
      res.json({ stats });
    } catch (err) {
      next(err);
    }
  });

  // Historical Resource Telemetry
  router.get('/:id/telemetry', (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const range = (req.query.range as any) || '5m';
      const startTime = req.query.start as string | undefined;
      const endTime = req.query.end as string | undefined;
      const maxPoints = Math.min(Math.max(parseInt(req.query.maxPoints as string, 10) || 60, 10), 300);

      const result = telemetryHistorian.queryProjectTelemetry(project.id, {
        range,
        startTime,
        endTime,
        maxPoints,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Per-Execution Resource Telemetry
  router.get('/:id/runs/:executionId/telemetry', (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const result = telemetryHistorian.queryExecutionTelemetry(project.id, req.params.executionId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Project Health Center & Resource Health
  router.get('/:id/health', (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const health = telemetryHistorian.getProjectHealth(project.id);
      res.json({ health });
    } catch (err) {
      next(err);
    }
  });

  // Active & Recent Resource Anomalies
  router.get('/:id/anomalies', (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const anomalies = db
        .prepare(`SELECT * FROM resource_anomalies WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`)
        .all(project.id);
      res.json({ anomalies });
    } catch (err) {
      next(err);
    }
  });

  // Execution / Job History
  router.get('/:id/runs', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

      const runs = db
        .prepare(`
          SELECT id, project_id, user_id, language, file_path, status, exit_code, signal, duration_ms, peak_memory_bytes, created_at
          FROM runs
          WHERE project_id = ? AND user_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `)
        .all(project.id, userOf(req).id, limit, offset);

      const totalRow = db
        .prepare('SELECT COUNT(*) as total FROM runs WHERE project_id = ? AND user_id = ?')
        .get(project.id, userOf(req).id) as { total: number };

      res.json({ runs, total: totalRow.total, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // Workspace Snapshot Management
  router.get('/:id/snapshots', (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const snapshots = listSnapshots(db, userOf(req).id, project.id);
      res.json({ snapshots });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/snapshots', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { name } = req.body ?? {};
      const snapshot = await createSnapshot(cfg, db, userOf(req).id, project.id, name);
      res.status(201).json({ snapshot });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/snapshots/:snapshotId/restore', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      await restoreSnapshot(cfg, db, userOf(req).id, project.id, req.params.snapshotId);
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id/snapshots/:snapshotId', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      await deleteSnapshot(cfg, db, userOf(req).id, project.id, req.params.snapshotId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/tree', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
      const cwd = await workspacePath(cfg, project.id);
      res.json({ tree: await tree(cwd) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/file', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
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
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'editor');
      const { path, content } = req.body ?? {};
      if (typeof path !== 'string') throw new ApiError(400, 'path is required', 'invalid_path');
      if (typeof content !== 'string') throw new ApiError(400, 'content is required', 'invalid_content');
      const cwd = await workspacePath(cfg, project.id);
      await writeProjectFile(cwd, path, content);
      await collaborationManager.notifyExternalFileMutation(project.id, path, content);
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/move', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'editor');
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
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'editor');
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

  // Full Workspace Text Search
  router.post('/:id/search', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
      const cwd = await workspacePath(cfg, project.id);
      const result = await searchProjectContent(cwd, req.body ?? {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/search', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'viewer');
      const cwd = await workspacePath(cfg, project.id);
      const query = (req.query.q as string) || '';
      const isCaseSensitive = req.query.caseSensitive === 'true';
      const isWholeWord = req.query.wholeWord === 'true';
      const isRegex = req.query.regex === 'true';
      const includePattern = req.query.include as string | undefined;
      const excludePattern = req.query.exclude as string | undefined;
      const result = await searchProjectContent(cwd, {
        query,
        isCaseSensitive,
        isWholeWord,
        isRegex,
        includePattern,
        excludePattern,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Safe Code Auto-Formatting
  router.post('/:id/format', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'editor');
      const { path, content } = req.body ?? {};
      if (typeof path !== 'string') throw new ApiError(400, 'path is required', 'invalid_path');
      if (typeof content !== 'string') throw new ApiError(400, 'content is required', 'invalid_content');
      const cwd = await workspacePath(cfg, project.id);
      const result = await formatProjectFile(cwd, path, content);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/run', async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(db, userOf(req).id, req.params.id, 'editor');
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

  const proxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>();

  router.use('/:id/proxy/:port', async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);

      const port = parseInt(req.params.port, 10);
      const allowedPorts = [3000, 4173, 5173, 8000, 8080];
      if (isNaN(port) || !allowedPorts.includes(port)) {
        throw new ApiError(400, 'Invalid port', 'invalid_port');
      }

      const target = await sandboxManager.getProxyTarget(project.id, port, cfg.containerized);
      if (!target) {
        throw new ApiError(404, `Port ${port} is not published by the sandbox`, 'not_found');
      }

      const prefix = `/api/projects/${req.params.id}/proxy/${port}`;
      const proxyKey = `${target}|${prefix}`;
      let proxy = proxyCache.get(proxyKey);
      if (!proxy) {
        proxy = createProxyMiddleware({
          target,
          changeOrigin: true,
          pathRewrite: { [`^${prefix}`]: '' },
          ws: true,
        });
        proxyCache.set(proxyKey, proxy);
      }

      proxy(req as any, res as any, next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
