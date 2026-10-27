import type { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { z } from "zod";
import { checkedString, parseInput } from "../validate.js";
import { requireOwnedProject, requireProjectAccess, workspacePath } from "./service.js";
import { resolveInstallSpec } from "./install.js";
import { runProject } from "../execution/pipeline.js";
import { resolveProxyEntry } from "./proxyTargets.js";
import { sandboxRun } from "../execution/sandbox.js";
import { runGate } from "../execution/runGate.js";
import { resolveSecretsForInjection, toGenericSecretError } from "../projectsecrets/store.js";
import { formatProjectFile } from "./format.js";
import { requireLiveEditsPersisted } from "../collab/manager.js";
import { recordAuditLog } from "../audit.js";

export function registerExecutionRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;

  // Safe Code Auto-Formatting
  router.post("/:id/format", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "editor",
      );
      const { path, content } = parseInput(
        z.object({
          path: checkedString("path is required", "invalid_path"),
          content: checkedString("content is required", "invalid_content"),
        }),
        req.body ?? {},
      );
      const cwd = await workspacePath(cfg, project.id);
      const result = await formatProjectFile(cwd, path, content);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/run", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "editor",
      );
      const { language, stdin } = parseInput(
        z.object({
          language: checkedString("language must be a string", "invalid_language").optional(),
          stdin: checkedString("stdin must be a string", "invalid_stdin").optional(),
        }),
        req.body ?? {},
      );
      const userId = userOf(req).id;
      if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, "concurrent execution limit reached", "too_many_runs");
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        let secretEnv: Record<string, string> | undefined;
        try {
          const resolved = resolveSecretsForInjection(db, cfg, project.id, {
            userId,
            context: "run",
            ipAddress: req.ip,
          });
          if (Object.keys(resolved).length > 0) secretEnv = resolved;
        } catch (err) {
          throw toGenericSecretError(err);
        }
        const result = await runProject(cfg, project.id, cwd, {
          language,
          stdin,
          userId,
          secretEnv,
          db,
        });
        res.json(result);
      } finally {
        runGate.release(userId);
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/install", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const userId = userOf(req).id;
      if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, "concurrent execution limit reached", "too_many_runs");
      }
      try {
        const workspaceDir = await workspacePath(cfg, project.id);
        // M86: install reads the dependency manifests from disk; land the
        // room's latest edits (e.g. a just-typed requirements.txt) first.
        await requireLiveEditsPersisted(project.id, "Dependencies were not installed.");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");

        const { language } = project;
        const installResult = await resolveInstallSpec({
          workspaceDir,
          language,
        });

        if (!installResult.cmd) {
          res.write(installResult.message + "\n");
          res.end();
          return;
        }

        res.write(`Running ${installResult.cmd} ${installResult.args.join(" ")}...\n\n`);

        const result = await sandboxRun(project.id, workspaceDir, {
          command: installResult.cmd,
          args: installResult.args,
          cwd: workspaceDir,
          timeoutMs: 60000,
          kind: "build",
          config: cfg,
          userId,
          onStdout: (data) => res.write(data),
          onStderr: (data) => res.write(data),
        });

        if (db) {
          try {
            recordAuditLog(db, {
              userId,
              projectId: project.id,
              eventType: "DEPENDENCIES_INSTALLED",
              details: { command: installResult.cmd, exitCode: result.exitCode },
              ipAddress: req.ip,
            });
          } catch {}
        }
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

  router.use("/:id/proxy/:port", async (req, res, next) => {
    try {
      const { entry } = await resolveProxyEntry(
        db,
        userOf(req).id,
        req.params.id as string,
        req.params.port,
        cfg,
      );
      void entry.proxy(req as any, res as any, next);
    } catch (err) {
      next(err);
    }
  });
}
