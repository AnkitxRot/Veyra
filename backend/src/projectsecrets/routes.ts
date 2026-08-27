import { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requireOwnedProject } from "../projects/service.js";
import { recordAuditLog } from "../audit.js";
import {
  createProjectSecret,
  deleteProjectSecret,
  getConfigValue,
  getProjectSecretMetadata,
  normalizeEnvironment,
  toGenericSecretError,
  updateProjectSecret,
  validateSecretName,
} from "./store.js";

/**
 * M47 — owner-only per-project secret & environment-variable CRUD.
 *
 * Mounted under /api/projects (after requireAuth). Every handler resolves the
 * project via requireOwnedProject, which yields an identical 404 for
 * non-owners and strangers alike (IDOR-safe). Secret VALUES for is_secret=1
 * entries are never returned by any endpoint here.
 */
export function projectSecretRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router();
  const userOf = (req: Request) => req.user!;

  const assertNotDemo = (req: Request) => {
    if (userOf(req).username.startsWith("evaluator_")) {
      throw new ApiError(
        403,
        "demo accounts cannot store secrets",
        "demo_forbidden",
      );
    }
  };

  const envFromQuery = (req: Request): string | null =>
    normalizeEnvironment(
      typeof req.query.environment === "string"
        ? req.query.environment
        : undefined,
    );

  // List metadata only — never a value, never ciphertext. Safe regardless of
  // master-key state.
  router.get("/:id/secrets", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      res.json({ secrets: getProjectSecretMetadata(db, project.id) });
    } catch (err) {
      next(err);
    }
  });

  // Owner retrieval of a plain-configuration value (is_secret = 0 only).
  router.get("/:id/secrets/:name/value", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const name = validateSecretName(req.params.name);
      const environment = envFromQuery(req);
      const value = getConfigValue(db, cfg, project.id, name, environment);
      res.json({ name, environment, value });
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  router.post("/:id/secrets", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      assertNotDemo(req);
      const body = req.body ?? {};
      const name = validateSecretName(body.name);
      const environment = normalizeEnvironment(body.environment);
      const isSecret =
        body.isSecret === undefined ? true : body.isSecret === true;
      const meta = createProjectSecret(db, cfg, {
        projectId: project.id,
        name,
        environment,
        isSecret,
        value: body.value,
        createdBy: userOf(req).id,
      });
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: project.id,
        eventType: "SECRET_CREATED",
        details: { name, environment, isSecret },
        ipAddress: req.ip,
      });
      res.status(201).json({ secret: meta });
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  router.put("/:id/secrets/:name", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      assertNotDemo(req);
      const body = req.body ?? {};
      const name = validateSecretName(req.params.name);
      const environment = normalizeEnvironment(
        body.environment ??
          (typeof req.query.environment === "string"
            ? req.query.environment
            : undefined),
      );
      const isSecret =
        body.isSecret === undefined ? true : body.isSecret === true;
      const meta = updateProjectSecret(db, cfg, {
        projectId: project.id,
        name,
        environment,
        isSecret,
        value: body.value,
        createdBy: userOf(req).id,
      });
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: project.id,
        eventType: "SECRET_UPDATED",
        details: { name, environment, isSecret },
        ipAddress: req.ip,
      });
      res.json({ secret: meta });
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  router.delete("/:id/secrets/:name", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const name = validateSecretName(req.params.name);
      const environment = envFromQuery(req);
      const removed = deleteProjectSecret(db, project.id, name, environment);
      if (!removed) {
        throw new ApiError(404, "secret not found", "not_found");
      }
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: project.id,
        eventType: "SECRET_DELETED",
        details: { name, environment },
        ipAddress: req.ip,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
