import type { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { z } from "zod";
import { checkedString, parseInput } from "../validate.js";
import {
  requireProjectAccess,
  listProjectCollaborators,
  addProjectCollaborator,
  removeProjectCollaborator,
} from "./service.js";
import { terminalSessions } from "../execution/terminalSessions.js";
import { debugSessions } from "../debug/manager.js";
import { closeProjectConnectionsForUser } from "../ws/connectionRegistry.js";
import { recordAuditLog } from "../audit.js";
import { collaborationManager } from "../collab/manager.js";

export function registerCollaboratorRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;

  // Collaborators Management
  router.get("/:id/collaborators", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
      const collaborators = listProjectCollaborators(db, req.params.id);
      res.json({ collaborators });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/collaborators", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "owner");
      const { role } = req.body ?? {};
      const { username } = parseInput(
        z.object({
          username: checkedString(
            "username is required",
            "invalid_username",
            (u) => u.trim().length > 0,
          ),
        }),
        req.body ?? {},
      );

      const targetUser = db
        .prepare("SELECT id, username FROM users WHERE username = ?")
        .get(username.trim()) as { id: number; username: string } | undefined;

      if (!targetUser) {
        throw new ApiError(404, `User "${username}" not found`, "user_not_found");
      }

      const collabRole = role === "viewer" ? "viewer" : "editor";
      addProjectCollaborator(db, req.params.id, targetUser.id, collabRole);
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: req.params.id,
        eventType: "COLLABORATOR_ADDED",
        details: { targetUserId: targetUser.id, role: collabRole },
        ipAddress: req.ip,
      });

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

  router.delete("/:id/collaborators/:userId", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "owner");
      const targetUserId = parseInt(req.params.userId, 10);
      if (isNaN(targetUserId)) throw new ApiError(400, "invalid user ID", "invalid_id");

      removeProjectCollaborator(db, req.params.id, targetUserId);
      collaborationManager.revokeUser(req.params.id, targetUserId);
      // M79: a removed collaborator loses terminal access immediately — kill
      // any attached or detached PTY they hold in this project.
      terminalSessions.reapUserProject(targetUserId, req.params.id);
      // M116: also cut their open debug/LSP/execute sockets for this project.
      closeProjectConnectionsForUser(targetUserId, req.params.id);
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: req.params.id,
        eventType: "COLLABORATOR_REMOVED",
        details: { targetUserId },
        ipAddress: req.ip,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id/collaborators/:userId", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "owner");
      const targetUserId = parseInt(req.params.userId, 10);
      parseInput(
        z.object({
          role: checkedString(
            "role must be editor or viewer",
            "invalid_role",
            (r) => r === "editor" || r === "viewer",
          ),
        }),
        req.body ?? {},
      );
      const { role } = req.body ?? {};

      addProjectCollaborator(db, req.params.id, targetUserId, role);
      collaborationManager.updateUserRole(req.params.id, targetUserId, role);
      // M79: /ws/terminal requires the editor role — a demotion to viewer
      // revokes terminal access, so reap any PTY they hold here.
      if (role === "viewer") {
        terminalSessions.reapUserProject(targetUserId, req.params.id);
        // M116: debugging runs code in the sandbox, so it needs editor too.
        debugSessions.disposeUserProject(targetUserId, req.params.id, "access_revoked");
      }
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: req.params.id,
        eventType: "COLLABORATOR_ROLE_CHANGED",
        details: { targetUserId, role },
        ipAddress: req.ip,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
