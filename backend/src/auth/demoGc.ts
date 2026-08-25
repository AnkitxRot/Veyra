import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { deleteProject } from "../projects/service.js";
import { closeAllConnectionsForUser } from "../ws/connectionRegistry.js";
import { invalidateCachedSessionsForUser } from "./sessionCache.js";
import { recordAuditLog } from "../audit.js";

export interface DemoGcResult {
  cleanedUsers: number;
  cleanedProjects: number;
}

let inFlightGc: Promise<DemoGcResult> | null = null;

/**
 * Single-flight, idempotent garbage collector for expired guest demo accounts.
 *
 * Demo accounts (`evaluator_*`) created by `/api/auth/demo` are temporary
 * evaluation sandboxes. When their TTL expires (or sessions expire and TTL
 * elapsed), this helper cleans up all associated resources:
 *   1. Disposes live collaboration rooms and in-memory telemetry state
 *   2. Stops running Docker sandboxes
 *   3. Removes workspace and snapshot directories from disk
 *   4. Closes any live WebSockets and invalidates cached sessions
 *   5. Purges database records (projects, runs, snapshots, sessions, user)
 *   6. Emits an audit log entry for the purge
 */
export async function cleanupExpiredDemoAccounts(
  cfg: AppConfig,
  db: Db,
  now: number = Date.now(),
): Promise<DemoGcResult> {
  if (inFlightGc) {
    return inFlightGc;
  }
  inFlightGc = (async () => {
    try {
      return await executeDemoGc(cfg, db, now);
    } finally {
      inFlightGc = null;
    }
  })();
  return inFlightGc;
}

async function executeDemoGc(
  cfg: AppConfig,
  db: Db,
  now: number,
): Promise<DemoGcResult> {
  const ttlMs = cfg.demoAccountTtlMs ?? 2 * 3600 * 1000;
  const cutoffIso = new Date(now - ttlMs).toISOString();
  const nowIso = new Date(now).toISOString();

  // Find demo users:
  // 1. Username must match 'evaluator_%'
  // 2. Role must be 'user' (never admin)
  // 3. User created_at <= cutoffIso (created at least demoAccountTtlMs ago)
  // 4. No active unexpired session (expires_at > nowIso)
  const candidateUsers = db
    .prepare(
      `SELECT u.id, u.username, u.created_at
       FROM users u
       WHERE u.username LIKE 'evaluator_%'
         AND u.role = 'user'
         AND u.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.user_id = u.id AND s.expires_at > ?
         )`,
    )
    .all(cutoffIso, nowIso) as unknown as Array<{
    id: number;
    username: string;
    created_at: string;
  }>;

  let cleanedUsers = 0;
  let cleanedProjects = 0;

  for (const user of candidateUsers) {
    try {
      // Find all projects owned by this demo user
      const projects = db
        .prepare("SELECT id FROM projects WHERE owner_id = ?")
        .all(user.id) as unknown as Array<{ id: string }>;

      // Delete each project using deleteProject (handles rooms, sandboxes, telemetry, disk, DB)
      for (const p of projects) {
        try {
          await deleteProject(cfg, db, user.id, p.id);
          cleanedProjects++;
        } catch (err) {
          console.error(
            `[demo-gc] failed to delete project ${p.id} for demo user ${user.username}:`,
            err,
          );
          // Fallback cleanup for partially-removed projects
          try {
            await fs.rm(join(cfg.dataDir, "snapshots", p.id), {
              recursive: true,
              force: true,
            });
          } catch {}
          try {
            await fs.rm(join(cfg.workspacesDir, p.id), {
              recursive: true,
              force: true,
            });
          } catch {}
          db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
          cleanedProjects++;
        }
      }

      // Sever any lingering live WebSocket connections
      closeAllConnectionsForUser(user.id);

      // Invalidate session cache
      invalidateCachedSessionsForUser(user.id);

      // Purge DB user and remaining cascade rows
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      db.prepare("DELETE FROM runs WHERE user_id = ?").run(user.id);
      db.prepare("DELETE FROM snapshots WHERE user_id = ?").run(user.id);
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

      // Record audit entry
      try {
        recordAuditLog(db, {
          userId: null,
          eventType: "DEMO_ACCOUNTS_GC",
          details: {
            purgedUserId: user.id,
            username: user.username,
            projectsPurged: projects.length,
          },
        });
      } catch {}

      cleanedUsers++;
    } catch (err) {
      console.error(
        `[demo-gc] failed to purge demo user ${user.username} (${user.id}):`,
        err,
      );
    }
  }

  return { cleanedUsers, cleanedProjects };
}
