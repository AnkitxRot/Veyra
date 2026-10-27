import type { Router } from "express";
import type { Request } from "express";
import { makeZipHelpers } from "./routeShared.js";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { z } from "zod";
import { checkedString, parseInput } from "../validate.js";
import {
  createProject,
  deleteProject,
  listProjects,
  requireProjectAccess,
  projectDir,
} from "./service.js";
import { STARTER_TEMPLATES, applyTemplate } from "./templates.js";
import { importNewProjectZip } from "./archive.js";
import { toGenericSecretError } from "../projectsecrets/store.js";
import { recordAuditLog } from "../audit.js";
import { cloneIntoProject } from "../git/remotes.js";
import { upsertGitHttpsCredentials } from "../git/credentials.js";
import { validateHttpsGitRemoteUrl, httpsRemoteHost } from "../git/remoteUrl.js";

export function registerCrudRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;
  const { rawZipParser, getZipBuffer } = makeZipHelpers(cfg);

  router.get("/", (req, res) => {
    res.json({ projects: listProjects(db, userOf(req).id) });
  });

  router.post("/", async (req, res, next) => {
    try {
      const { language } = req.body ?? {};
      const { name } = parseInput(
        z.object({
          name: checkedString("name is required", "invalid_name", (n) => n.trim().length > 0),
        }),
        req.body ?? {},
      );
      const project = await createProject(cfg, db, userOf(req).id, {
        name,
        language,
      });
      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  });

  // Starter Templates
  router.get("/templates/catalog", (_req, res) => {
    res.json({ templates: STARTER_TEMPLATES });
  });

  router.post("/from-template", async (req, res, next) => {
    try {
      const { templateId, name } = req.body ?? {};
      const tpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
      if (!tpl) throw new ApiError(400, "Invalid template ID", "invalid_template");

      const projectName = typeof name === "string" && name.trim() ? name.trim() : tpl.name;
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

  // M80: clone an HTTPS remote into a brand-new project.
  router.post("/clone", async (req, res, next) => {
    try {
      const user = userOf(req);
      const body = req.body ?? {};
      parseInput(
        z.object({
          name: checkedString("name is required", "invalid_name", (n) => n.trim().length > 0),
        }),
        body,
      );
      const url = validateHttpsGitRemoteUrl(body.url);

      const hasToken = typeof body.token === "string" && body.token.length > 0;
      if (hasToken && user.username.startsWith("evaluator_")) {
        throw new ApiError(403, "demo accounts cannot store secrets", "demo_forbidden");
      }

      const creds = hasToken
        ? {
            username:
              typeof body.username === "string" && body.username.trim()
                ? body.username.trim()
                : "git",
            token: body.token as string,
          }
        : null;

      const project = await createProject(cfg, db, user.id, {
        name: body.name,
        language: "auto",
      });

      try {
        if (creds) {
          upsertGitHttpsCredentials(db, cfg, project.id, {
            username: creds.username,
            token: creds.token,
            host: httpsRemoteHost(url),
            createdBy: user.id,
          });
        }
        const result = await cloneIntoProject(
          cfg,
          project.id,
          url,
          { username: user.username },
          creds,
        );
        recordAuditLog(db, {
          userId: user.id,
          projectId: project.id,
          eventType: "GIT_CLONE",
          details: {
            host: httpsRemoteHost(result.remote),
            branch: result.branch,
            credentialsUsed: Boolean(creds),
          },
          ipAddress: req.ip,
        });
        res.status(201).json({
          project,
          branch: result.branch,
          remote: result.remote,
        });
      } catch (err) {
        try {
          await deleteProject(cfg, db, user.id, project.id);
        } catch {
          // still surface the original clone failure
        }
        throw err;
      }
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  // Import new project from ZIP
  router.post("/import", rawZipParser, async (req, res, next) => {
    try {
      const zipBuffer = getZipBuffer(req);
      const name = (req.query.name as string) || req.body?.name;
      const language = (req.query.language as string) || req.body?.language;
      const result = await importNewProjectZip(cfg, db, userOf(req).id, zipBuffer, {
        name,
        language,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", (req, res, next) => {
    try {
      const access = requireProjectAccess(db, userOf(req).id, req.params.id as string, "viewer");
      res.json({ project: access.project, role: access.role });
    } catch (err) {
      next(err);
    }
  });
}
