import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import {
  createDatabaseBackup,
  listDatabaseBackups,
  deleteDatabaseBackup,
  BACKUP_FILENAME_RE,
} from "../backup/service.js";
import {
  createWorkspaceBackup,
  listWorkspaceBackups,
  deleteWorkspaceBackup,
  assertValidProjectId,
} from "../backup/workspaceBackup.js";
import { getProject } from "../projects/service.js";
import {
  getSystemCapabilitiesAsync,
  isDockerRunning,
  isRunnerImageAvailable,
} from "../tools.js";
import { SandboxManager } from "../execution/sandbox.js";
import { recordAuditLog, queryAuditLogs } from "../audit.js";
import { RateLimiter } from "../auth/ratelimit.js";
import { hashPassword } from "../auth/passwords.js";
import { telemetryHistorian } from "../execution/historian.js";
import { collaborationManager } from "../collab/manager.js";
import {
  closeAllConnectionsForUser,
  activeConnectionCount,
} from "../ws/connectionRegistry.js";
import { invalidateCachedSessionsForUser } from "../auth/sessionCache.js";
import { getObservabilitySnapshot } from "../observability.js";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export function adminRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router();
  const sandboxManager = SandboxManager.getInstance();
  const adminLimiter = new RateLimiter(120, 60_000); // 120 admin ops / min
  const terminateLimiter = new RateLimiter(20, 60_000); // max 20 terminations / min

  const checkLimit = (req: Request, limiter = adminLimiter) => {
    if (!limiter.allow(req.ip ?? "unknown")) {
      throw new ApiError(
        429,
        "too many admin requests, please slow down",
        "rate_limited",
      );
    }
  };

  // 1. System Overview
  router.get(
    "/overview",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const caps = await getSystemCapabilitiesAsync();

        // Platform counters
        const totalUsersRow = db
          .prepare("SELECT COUNT(*) as count FROM users")
          .get() as { count: number };
        const demoUsersRow = db
          .prepare(
            "SELECT COUNT(*) as count FROM users WHERE username LIKE 'evaluator_%'",
          )
          .get() as { count: number };
        const totalProjectsRow = db
          .prepare("SELECT COUNT(*) as count FROM projects")
          .get() as { count: number };
        const totalRunsRow = db
          .prepare("SELECT COUNT(*) as count FROM runs")
          .get() as { count: number };

        // Active sandboxes
        const activeSandboxes = await sandboxManager.getAllActiveSandboxes();

        // Compute aggregate telemetry across active sandboxes
        let aggregateCpu = 0;
        let aggregateMemoryBytes = 0;
        let aggregatePids = 0;

        for (const sb of activeSandboxes) {
          try {
            const stats = await sandboxManager.getContainerStats(sb.projectId);
            if (stats.running) {
              aggregateCpu += stats.cpuPercent;
              aggregateMemoryBytes += stats.memoryUsageBytes;
              aggregatePids += stats.pids;
            }
          } catch {}
        }

        res.json({
          system: {
            status: "healthy",
            uptimeSeconds: Math.floor(process.uptime()),
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            memoryRssBytes: process.memoryUsage().rss,
          },
          infrastructure: {
            docker: caps.docker,
            runnerImage: caps.runnerImage,
            database: true,
            cgroupRoot: cfg.cgroupRoot,
            maxSandboxes: cfg.maxSandboxes,
            projectQuota: cfg.projectQuota,
          },
          counters: {
            totalUsers: totalUsersRow?.count ?? 0,
            demoSessions: demoUsersRow?.count ?? 0,
            totalProjects: totalProjectsRow?.count ?? 0,
            activeSandboxes: activeSandboxes.length,
            totalExecutions: totalRunsRow?.count ?? 0,
          },
          aggregateTelemetry: {
            cpuPercent: Math.round(aggregateCpu * 10) / 10,
            memoryUsageBytes: aggregateMemoryBytes,
            memoryLimitBytes:
              cfg.limits.memoryBytes * Math.max(1, activeSandboxes.length),
            pids: aggregatePids,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 1b. M5a performance/load-test observability snapshot. Distinct from
  // "System Overview" above (which is a stable, dashboard-consumed shape) —
  // this is evidence for load-test runs: event-loop lag, per-operation DB
  // call latency, and the same active-connection/room/sandbox gauges used
  // elsewhere, all in one machine-readable snapshot for the load harness.
  router.get(
    "/observability",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        res.json(
          getObservabilitySnapshot({
            activeConnectionCount,
            getActiveRoomCount: () => collaborationManager.getActiveRoomCount(),
            getActiveSandboxCount: () => sandboxManager.getActiveSandboxCount(),
            getTotalCollabBroadcastSends: () =>
              collaborationManager.getTotalBroadcastSendCount(),
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // 2. Resource Telemetry
  router.get(
    "/telemetry",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const activeSandboxes = await sandboxManager.getAllActiveSandboxes();
        const sandboxStatsList = await Promise.all(
          activeSandboxes.map(async (sb) => {
            const stats = await sandboxManager.getContainerStats(sb.projectId);
            const projectRow = db
              .prepare(
                `
            SELECT p.name, u.username
            FROM projects p
            JOIN users u ON u.id = p.owner_id
            WHERE p.id = ?
          `,
              )
              .get(sb.projectId) as
              { name: string; username: string } | undefined;

            return {
              containerId: sb.containerId,
              projectId: sb.projectId,
              projectName: projectRow?.name ?? "Unknown Project",
              ownerUsername: projectRow?.username ?? "Unknown User",
              lastUsed: sb.lastUsed,
              idleSeconds: Math.max(
                0,
                Math.floor((Date.now() - sb.lastUsed) / 1000),
              ),
              stats,
            };
          }),
        );

        let totalCpu = 0;
        let totalMem = 0;
        let totalPids = 0;
        for (const s of sandboxStatsList) {
          if (s.stats.running) {
            totalCpu += s.stats.cpuPercent;
            totalMem += s.stats.memoryUsageBytes;
            totalPids += s.stats.pids;
          }
        }

        res.json({
          summary: {
            activeSandboxesCount: activeSandboxes.length,
            totalCpuPercent: Math.round(totalCpu * 10) / 10,
            totalMemoryBytes: totalMem,
            totalPids,
          },
          sandboxes: sandboxStatsList,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Historical Aggregate Platform Telemetry
  router.get(
    "/telemetry/historical",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const range = (req.query.range as any) || "15m";
        const result = telemetryHistorian.queryAdminHistoricalTelemetry(range);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // 3. Sandboxes List & Management
  router.get(
    "/sandboxes",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const activeSandboxes = await sandboxManager.getAllActiveSandboxes();
        const sandboxes = await Promise.all(
          activeSandboxes.map(async (sb) => {
            const stats = await sandboxManager.getContainerStats(sb.projectId);
            const projectRow = db
              .prepare(
                `
            SELECT p.name, p.created_at, u.username
            FROM projects p
            JOIN users u ON u.id = p.owner_id
            WHERE p.id = ?
          `,
              )
              .get(sb.projectId) as
              | { name: string; created_at: string; username: string }
              | undefined;

            return {
              containerId: sb.containerId,
              projectId: sb.projectId,
              projectName: projectRow?.name ?? "Workspace",
              ownerUsername: projectRow?.username ?? "Unknown",
              ports: sb.ports,
              lastUsed: sb.lastUsed,
              idleSeconds: Math.max(
                0,
                Math.floor((Date.now() - sb.lastUsed) / 1000),
              ),
              status: stats.running ? "running" : "idle",
              cpuPercent: stats.cpuPercent,
              memoryUsageBytes: stats.memoryUsageBytes,
              pids: stats.pids,
              limits: {
                memoryBytes: cfg.limits.memoryBytes,
                cpuQuota: cfg.limits.cpuQuota,
                pidsLimit: cfg.limits.pidsLimit,
              },
            };
          }),
        );

        res.json({ sandboxes });
      } catch (err) {
        next(err);
      }
    },
  );

  // 4. Safe Sandbox Termination
  router.post(
    "/sandboxes/:containerId/terminate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req, terminateLimiter);
        const { containerId } = req.params;

        if (!containerId || !/^ide-sandbox-[a-zA-Z0-9_-]+$/.test(containerId)) {
          throw new ApiError(
            400,
            "invalid container id: must be a managed sandbox identifier",
            "invalid_container_id",
          );
        }

        const result = await sandboxManager.terminateSandbox(containerId);

        recordAuditLog(db, {
          userId: req.user?.id,
          projectId: result.projectId,
          eventType: "SANDBOX_TERMINATED_BY_ADMIN",
          details: {
            containerId,
            projectId: result.projectId,
            terminatedByAdmin: req.user?.username,
          },
          ipAddress: req.ip,
        });

        res.json({
          ok: true,
          message: `Sandbox ${containerId} successfully terminated by administrator`,
          containerId,
          projectId: result.projectId,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 5. Execution Monitoring
  router.get(
    "/executions",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const statusFilter =
          typeof req.query.status === "string" ? req.query.status : undefined;
        const languageFilter =
          typeof req.query.language === "string"
            ? req.query.language
            : undefined;
        const limit = Math.max(
          1,
          Math.min(parseInt(String(req.query.limit || "50"), 10), 200),
        );
        const offset = Math.max(
          0,
          parseInt(String(req.query.offset || "0"), 10),
        );

        const whereClauses: string[] = [];
        const params: any[] = [];

        if (statusFilter) {
          whereClauses.push("r.status = ?");
          params.push(statusFilter);
        }
        if (languageFilter) {
          whereClauses.push("r.language = ?");
          params.push(languageFilter);
        }

        const whereSql =
          whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

        const countRow = db
          .prepare(`SELECT COUNT(*) as total FROM runs r ${whereSql}`)
          .get(...params) as { total: number };
        const total = countRow?.total ?? 0;

        // Compute aggregate metrics
        const statsRow = db
          .prepare(
            `
        SELECT 
          COUNT(*) as totalRuns,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
          SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failureCount,
          SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeoutCount,
          SUM(CASE WHEN status = 'oom' THEN 1 ELSE 0 END) as oomCount,
          AVG(duration_ms) as avgDurationMs
        FROM runs
      `,
          )
          .get() as {
          totalRuns: number;
          successCount: number;
          failureCount: number;
          timeoutCount: number;
          oomCount: number;
          avgDurationMs: number | null;
        };

        const rows = db
          .prepare(
            `
        SELECT r.id, r.project_id, r.user_id, r.language, r.file_path, r.status,
               r.exit_code, r.signal, r.duration_ms, r.peak_memory_bytes, r.created_at,
               u.username, p.name as project_name
        FROM runs r
        JOIN users u ON u.id = r.user_id
        JOIN projects p ON p.id = r.project_id
        ${whereSql}
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?
      `,
          )
          .all(...params, limit, offset) as Array<any>;

        res.json({
          total,
          metrics: {
            totalRuns: statsRow?.totalRuns ?? 0,
            successCount: statsRow?.successCount ?? 0,
            failureCount: statsRow?.failureCount ?? 0,
            timeoutCount: statsRow?.timeoutCount ?? 0,
            oomCount: statsRow?.oomCount ?? 0,
            avgDurationMs: Math.round((statsRow?.avgDurationMs ?? 0) * 10) / 10,
            successRatePercent: statsRow?.totalRuns
              ? Math.round(
                  ((statsRow.successCount || 0) / statsRow.totalRuns) * 1000,
                ) / 10
              : 100,
          },
          runs: rows,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 6. User Management — List All Users
  router.get("/users", (req: Request, res: Response, next: NextFunction) => {
    try {
      checkLimit(req);
      const rows = db
        .prepare(
          `
        SELECT u.id, u.username, u.role, u.created_at,
               COUNT(DISTINCT p.id) as project_count,
               COUNT(DISTINCT r.id) as execution_count
        FROM users u
        LEFT JOIN projects p ON p.owner_id = u.id
        LEFT JOIN runs r ON r.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `,
        )
        .all() as Array<{
        id: number;
        username: string;
        role: string;
        created_at: string;
        project_count: number;
        execution_count: number;
      }>;

      const users = rows.map((u) => ({
        ...u,
        isDemo: u.username.startsWith("evaluator_"),
      }));

      res.json({ users, total: users.length });
    } catch (err) {
      next(err);
    }
  });

  // 6.1 User Management — Inspect Single User Details
  router.get(
    "/users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId))
          throw new ApiError(400, "invalid user id", "invalid_id");

        const userRow = db
          .prepare(
            `
        SELECT id, username, role, created_at
        FROM users
        WHERE id = ?
      `,
          )
          .get(userId) as
          | { id: number; username: string; role: string; created_at: string }
          | undefined;

        if (!userRow)
          throw new ApiError(404, "user not found", "user_not_found");

        const projects = db
          .prepare(
            `
        SELECT id, name, language, created_at, updated_at
        FROM projects
        WHERE owner_id = ?
        ORDER BY updated_at DESC
      `,
          )
          .all(userId) as Array<any>;

        const snapshots = db
          .prepare(
            `
        SELECT s.id, s.project_id, s.name, s.size_bytes, s.created_at, p.name as project_name
        FROM snapshots s
        JOIN projects p ON p.id = s.project_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC
      `,
          )
          .all(userId) as Array<any>;

        const executions = db
          .prepare(
            `
        SELECT r.id, r.project_id, r.language, r.file_path, r.status, r.exit_code, r.duration_ms, r.peak_memory_bytes, r.created_at, p.name as project_name
        FROM runs r
        JOIN projects p ON p.id = r.project_id
        WHERE r.user_id = ?
        ORDER BY r.created_at DESC
        LIMIT 25
      `,
          )
          .all(userId) as Array<any>;

        // Check active sandboxes for user's projects
        const activeSandboxes = await sandboxManager.getAllActiveSandboxes();
        const userProjectIds = new Set(projects.map((p) => p.id));
        const userSandboxes = activeSandboxes.filter((sb) =>
          userProjectIds.has(sb.projectId),
        );

        // Recent audit logs for user
        const { logs: recentAudit } = queryAuditLogs(db, { userId, limit: 20 });

        res.json({
          user: {
            ...userRow,
            isDemo: userRow.username.startsWith("evaluator_"),
          },
          counts: {
            projectCount: projects.length,
            executionCount: executions.length,
            snapshotCount: snapshots.length,
            activeSandboxesCount: userSandboxes.length,
          },
          projects,
          snapshots,
          recentExecutions: executions,
          activeSandboxes: userSandboxes,
          recentAuditLogs: recentAudit,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 6.2 User Management — Edit User (Username, Role)
  router.patch(
    "/users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId))
          throw new ApiError(400, "invalid user id", "invalid_id");

        const existing = db
          .prepare(
            `
        SELECT id, username, role FROM users WHERE id = ?
      `,
          )
          .get(userId) as
          { id: number; username: string; role: string } | undefined;

        if (!existing)
          throw new ApiError(404, "user not found", "user_not_found");

        const { username, role } = req.body ?? {};

        let newUsername = existing.username;
        let newRole = existing.role;

        if (username !== undefined) {
          if (typeof username !== "string" || !USERNAME_RE.test(username)) {
            throw new ApiError(
              400,
              "username must be 3-32 alphanumeric characters [a-zA-Z0-9_]",
              "invalid_username",
            );
          }
          if (username !== existing.username) {
            const taken = db
              .prepare("SELECT id FROM users WHERE username = ? AND id != ?")
              .get(username, userId);
            if (taken)
              throw new ApiError(
                409,
                "username already taken",
                "username_taken",
              );
            newUsername = username;
          }
        }

        if (role !== undefined) {
          if (role !== "user" && role !== "admin") {
            throw new ApiError(
              400,
              "role must be user or admin",
              "invalid_role",
            );
          }

          // Last Admin Demotion Safeguard
          if (existing.role === "admin" && role === "user") {
            const adminCountRow = db
              .prepare(
                "SELECT COUNT(*) as count FROM users WHERE role = 'admin'",
              )
              .get() as { count: number };
            if (adminCountRow.count <= 1) {
              throw new ApiError(
                400,
                "Cannot remove admin role: at least one administrator account must exist",
                "cannot_demote_last_admin",
              );
            }
          }
          newRole = role;
        }

        db.prepare("UPDATE users SET username = ?, role = ? WHERE id = ?").run(
          newUsername,
          newRole,
          userId,
        );

        recordAuditLog(db, {
          userId: req.user?.id,
          eventType: "USER_UPDATED_BY_ADMIN",
          details: {
            targetUserId: userId,
            oldUsername: existing.username,
            newUsername,
            oldRole: existing.role,
            newRole,
            updatedByAdmin: req.user?.username,
          },
          ipAddress: req.ip,
        });

        res.json({
          ok: true,
          user: { id: userId, username: newUsername, role: newRole },
          message: "User successfully updated",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 6.3 User Management — Dedicated Password Reset
  router.post(
    "/users/:id/reset-password",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId))
          throw new ApiError(400, "invalid user id", "invalid_id");

        const existing = db
          .prepare("SELECT id, username FROM users WHERE id = ?")
          .get(userId) as { id: number; username: string } | undefined;
        if (!existing)
          throw new ApiError(404, "user not found", "user_not_found");

        const { newPassword } = req.body ?? {};
        if (
          typeof newPassword !== "string" ||
          newPassword.length < cfg.minPasswordLength
        ) {
          throw new ApiError(
            400,
            `password must be at least ${cfg.minPasswordLength} characters`,
            "invalid_password",
          );
        }

        const hash = await hashPassword(newPassword);
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
          hash,
          userId,
        );

        // Session Invalidation: Terminate all active sessions for the user
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        invalidateCachedSessionsForUser(userId);
        // WS auth is only checked once at connect time — deleting the DB
        // session row does nothing for a socket already established, so
        // any live terminal/execute/collab connection must be closed here
        // too, otherwise the reset accomplishes nothing against an
        // attacker who already has an open shell.
        closeAllConnectionsForUser(userId);

        recordAuditLog(db, {
          userId: req.user?.id,
          eventType: "USER_PASSWORD_RESET_BY_ADMIN",
          details: {
            targetUserId: userId,
            targetUsername: existing.username,
            action: "admin_password_reset_and_session_invalidation",
            adminActor: req.user?.username,
          },
          ipAddress: req.ip,
        });

        res.json({
          ok: true,
          message: `Password for ${existing.username} has been reset. All active sessions have been invalidated.`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 6.4 User Management — Destructive User Deletion with Cascade Cleanup
  router.delete(
    "/users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId))
          throw new ApiError(400, "invalid user id", "invalid_id");

        // Safeguard 1: Self-Deletion Protection
        if (req.user?.id === userId) {
          throw new ApiError(
            400,
            "Cannot delete your own active administrator account",
            "cannot_delete_self",
          );
        }

        const target = db
          .prepare("SELECT id, username, role FROM users WHERE id = ?")
          .get(userId) as
          { id: number; username: string; role: string } | undefined;
        if (!target)
          throw new ApiError(404, "user not found", "user_not_found");

        // Safeguard 2: Last Admin Protection
        if (target.role === "admin") {
          const adminCountRow = db
            .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
            .get() as { count: number };
          if (adminCountRow.count <= 1) {
            throw new ApiError(
              400,
              "Cannot delete the last remaining administrator account",
              "cannot_delete_last_admin",
            );
          }
        }

        // Cascade Cleanup Phase:
        // 1. Projects & Workspaces cleanup
        const projects = db
          .prepare("SELECT id FROM projects WHERE owner_id = ?")
          .all(userId) as Array<{ id: string }>;
        for (const p of projects) {
          // Disconnect any live collaborators before the workspace disappears under them
          try {
            collaborationManager.getRoom(p.id)?.dispose();
          } catch {
            // Best-effort: room may not exist
          }

          // Stop & reap active Docker container
          try {
            await sandboxManager.stopProjectSandbox(p.id);
          } catch (err) {
            console.error(
              `[delete-user] failed to stop sandbox for project ${p.id}:`,
              err,
            );
          }

          // Delete workspace directory on disk
          try {
            const wsPath = join(cfg.workspacesDir, p.id);
            rmSync(wsPath, { recursive: true, force: true });
          } catch (err) {
            console.error(
              `[delete-user] failed to rm workspace dir for project ${p.id}:`,
              err,
            );
          }

          // Delete project runs and snapshots
          db.prepare("DELETE FROM snapshots WHERE project_id = ?").run(p.id);
          db.prepare("DELETE FROM runs WHERE project_id = ?").run(p.id);
        }

        // 2. Delete projects
        db.prepare("DELETE FROM projects WHERE owner_id = ?").run(userId);

        // 3. Delete sessions
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        invalidateCachedSessionsForUser(userId);
        // Close any live terminal/execute/collab connections too — the
        // user's projects/workspace are being deleted in this same
        // request, so a connection they already hold open must not be
        // allowed to keep executing code or editing files past this point.
        closeAllConnectionsForUser(userId);

        // 4. Delete user's runs
        db.prepare("DELETE FROM runs WHERE user_id = ?").run(userId);

        // 5. Delete snapshots
        db.prepare("DELETE FROM snapshots WHERE user_id = ?").run(userId);

        // 6. Delete user record
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);

        // 7. Audit log (Preserved for accountability)
        recordAuditLog(db, {
          userId: req.user?.id,
          eventType: "USER_DELETED_BY_ADMIN",
          details: {
            deletedUserId: userId,
            deletedUsername: target.username,
            deletedRole: target.role,
            projectsPurged: projects.length,
            adminActor: req.user?.username,
          },
          ipAddress: req.ip,
        });

        res.json({
          ok: true,
          message: `User ${target.username} and all ${projects.length} workspace(s) successfully deleted.`,
          deletedUserId: userId,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 7. Project Management / Overview
  router.get("/projects", (req: Request, res: Response, next: NextFunction) => {
    try {
      checkLimit(req);
      const rows = db
        .prepare(
          `
        SELECT p.id, p.name, p.language, p.owner_id, p.created_at, p.updated_at,
               u.username as owner_username,
               COUNT(DISTINCT s.id) as snapshot_count,
               COUNT(DISTINCT r.id) as run_count
        FROM projects p
        JOIN users u ON u.id = p.owner_id
        LEFT JOIN snapshots s ON s.project_id = p.id
        LEFT JOIN runs r ON r.project_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
      `,
        )
        .all() as Array<{
        id: string;
        name: string;
        language: string;
        owner_id: number;
        created_at: string;
        updated_at: string;
        owner_username: string;
        snapshot_count: number;
        run_count: number;
      }>;

      res.json({ projects: rows, total: rows.length });
    } catch (err) {
      next(err);
    }
  });

  // 8. Searchable Audit Logs
  router.get("/audit", (req: Request, res: Response, next: NextFunction) => {
    try {
      checkLimit(req);
      const eventType =
        typeof req.query.event_type === "string"
          ? req.query.event_type
          : undefined;
      const userId =
        typeof req.query.user_id === "string"
          ? parseInt(req.query.user_id, 10)
          : undefined;
      const projectId =
        typeof req.query.project_id === "string"
          ? req.query.project_id
          : undefined;
      const limit =
        typeof req.query.limit === "string"
          ? parseInt(req.query.limit, 10)
          : 50;
      const offset =
        typeof req.query.offset === "string"
          ? parseInt(req.query.offset, 10)
          : 0;

      const { logs, total } = queryAuditLogs(db, {
        eventType,
        userId,
        projectId,
        limit,
        offset,
      });
      res.json({ logs, total });
    } catch (err) {
      next(err);
    }
  });

  // 9. Diagnostic Health
  router.get(
    "/health",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const dockerLive = isDockerRunning();
        const runnerImg = isRunnerImageAvailable();
        let dbLive = false;
        try {
          db.prepare("SELECT 1").get();
          dbLive = true;
        } catch {}

        res.json({
          ok: dbLive && dockerLive,
          database: { live: dbLive, walMode: true },
          docker: { live: dockerLive, runnerImage: runnerImg },
          sandboxManager: {
            activeCount: (await sandboxManager.getAllActiveSandboxes()).length,
            maxSandboxes: cfg.maxSandboxes,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // 10. Database Backups
  router.get(
    "/backups",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const backups = await listDatabaseBackups(cfg);
        res.json({
          backups: backups.map((b) => ({
            filename: b.filename,
            sizeBytes: b.sizeBytes,
            createdAt: b.createdAt,
            integrity: b.integrity,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/backups",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const actorUserId = (req as any).user?.id;
        const backup = await createDatabaseBackup(db, cfg, {
          actorUserId,
          ipAddress: req.ip,
        });
        res.status(201).json({
          ok: true,
          backup: {
            filename: backup.filename,
            sizeBytes: backup.sizeBytes,
            createdAt: backup.createdAt,
            integrity: backup.integrity,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/backups/:filename",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const filename = req.params.filename;
        if (
          !BACKUP_FILENAME_RE.test(filename) ||
          filename.includes("..") ||
          filename.includes("/") ||
          filename.includes("\\") ||
          filename.includes("\0")
        ) {
          throw new ApiError(
            400,
            "Invalid backup filename",
            "invalid_filename",
          );
        }

        const filePath = join(cfg.backupDir, filename);
        if (!existsSync(filePath)) {
          throw new ApiError(404, "Backup not found", "not_found");
        }

        // Log the download attempt before streaming starts, not after
        // completion — a full-database export (password hashes, session
        // tokens) is sensitive enough that even an interrupted/aborted
        // transfer should leave an audit trail.
        const actorUserId = (req as any).user?.id;
        recordAuditLog(db, {
          userId: actorUserId,
          eventType: "DATABASE_BACKUP_DOWNLOADED",
          details: { filename },
          ipAddress: req.ip,
        });

        res.download(filePath, filename);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/backups/:filename",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const actorUserId = (req as any).user?.id;
        const filename = req.params.filename;
        await deleteDatabaseBackup(db, cfg, filename, {
          actorUserId,
          ipAddress: req.ip,
        });
        res.json({ ok: true, deleted: filename });
      } catch (err) {
        next(err);
      }
    },
  );

  // Milestone 31 — Per-project workspace & snapshot-body disaster-recovery
  // backups. Deliberately admin-only, matching the database backup routes
  // above exactly; never exposed to ordinary collaborators. Project-ID
  // routes intentionally do NOT require the source project to still exist
  // (see workspaceBackup.ts's own doc comment) — a backup must remain
  // manageable after its source project is deleted, or it fails at the one
  // moment it exists to help with.
  router.post(
    "/workspace-backups/:projectId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const { projectId } = req.params;
        assertValidProjectId(projectId);
        const actorUserId = (req as any).user?.id;
        const backup = await createWorkspaceBackup(cfg, db, projectId, {
          actorUserId,
          ipAddress: req.ip,
        });
        res.status(201).json({
          ok: true,
          backup: {
            filename: backup.filename,
            projectId: backup.projectId,
            sizeBytes: backup.sizeBytes,
            createdAt: backup.createdAt,
            workspaceFileCount: backup.workspaceFileCount,
            snapshotCount: backup.snapshotCount,
            skippedWorkspaceFiles: backup.skippedWorkspaceFiles,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/workspace-backups/:projectId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const { projectId } = req.params;
        assertValidProjectId(projectId);
        const backups = await listWorkspaceBackups(cfg, projectId);
        res.json({
          backups: backups.map((b) => ({
            filename: b.filename,
            projectId: b.projectId,
            sizeBytes: b.sizeBytes,
            createdAt: b.createdAt,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/workspace-backups/:projectId/:filename",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const { projectId, filename } = req.params;
        assertValidProjectId(projectId);
        const backups = await listWorkspaceBackups(cfg, projectId);
        const match = backups.find((b) => b.filename === filename);
        if (!match) {
          throw new ApiError(404, "Workspace backup not found", "not_found");
        }

        const actorUserId = (req as any).user?.id;
        // audit_logs.project_id is ON DELETE CASCADE and a workspace
        // backup deliberately outlives its source project's deletion (see
        // workspaceBackup.ts) — a since-deleted project's id can't be used
        // as the FK-linked project_id (the insert would silently fail),
        // so fall back to null, keeping the real id in `details`.
        const stillExists = getProject(db, projectId) !== null;
        recordAuditLog(db, {
          userId: actorUserId,
          projectId: stillExists ? projectId : null,
          eventType: "WORKSPACE_BACKUP_DOWNLOADED",
          details: { filename, projectId },
          ipAddress: req.ip,
        });

        res.download(match.filePath, filename);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/workspace-backups/:projectId/:filename",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        checkLimit(req);
        const { projectId, filename } = req.params;
        const actorUserId = (req as any).user?.id;
        await deleteWorkspaceBackup(cfg, db, projectId, filename, {
          actorUserId,
          ipAddress: req.ip,
        });
        res.json({ ok: true, deleted: filename });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
