import type { Router } from "express";
type ProjectTelemetryRange = NonNullable<
  NonNullable<Parameters<typeof telemetryHistorian.queryProjectTelemetry>[1]>["range"]
>;
import type { Request } from "express";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { deleteProject, requireOwnedProject, requireProjectAccess } from "./service.js";
import { sandboxManager } from "../execution/sandbox.js";
import { detectPreviewPorts } from "../execution/previewProbe.js";
import { queryTimeline, queryWhileAway } from "../collab/timeline.js";
import { getLastSeen, touchLastSeen } from "../collab/lastSeen.js";
import { telemetryHistorian } from "../execution/historian.js";

export function registerTelemetryRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;

  router.delete("/:id", async (req, res, next) => {
    try {
      await deleteProject(cfg, db, userOf(req).id, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Live Container Resource Telemetry
  router.get("/:id/stats", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "viewer",
      );
      const stats = await sandboxManager.getContainerStats(project.id);
      res.json({ stats });
    } catch (err) {
      next(err);
    }
  });

  // Auto-detect running web-preview servers. Owner-only, exactly like the
  // preview proxy itself (resolveProxyEntry -> requireOwnedProject). Probes
  // only the fixed ALLOWED_PREVIEW_PORTS of THIS project's sandbox — never a
  // client-supplied host or port. See execution/previewProbe.ts.
  router.get("/:id/preview/ports", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      res.json(await detectPreviewPorts(project.id, cfg));
    } catch (err) {
      next(err);
    }
  });

  // Historical Resource Telemetry
  router.get("/:id/telemetry", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const range = (req.query.range as ProjectTelemetryRange | undefined) || "5m";
      const startTime = req.query.start as string | undefined;
      const endTime = req.query.end as string | undefined;
      const maxPoints = Math.min(
        Math.max(parseInt(req.query.maxPoints as string, 10) || 60, 10),
        300,
      );

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
  router.get("/:id/runs/:executionId/telemetry", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const result = telemetryHistorian.queryExecutionTelemetry(project.id, req.params.executionId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Project Health Center & Resource Health
  router.get("/:id/health", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const health = telemetryHistorian.getProjectHealth(project.id);
      res.json({ health });
    } catch (err) {
      next(err);
    }
  });

  // Active & Recent Resource Anomalies
  router.get("/:id/anomalies", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const anomalies = db
        .prepare(
          `SELECT * FROM resource_anomalies WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`,
        )
        .all(project.id);
      res.json({ anomalies });
    } catch (err) {
      next(err);
    }
  });

  // Execution / Job History
  router.get("/:id/runs", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

      const runs = db
        .prepare(
          `
          SELECT id, project_id, user_id, language, file_path, status, exit_code, signal, duration_ms, peak_memory_bytes, created_at
          FROM runs
          WHERE project_id = ? AND user_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(project.id, userOf(req).id, limit, offset);

      const totalRow = db
        .prepare("SELECT COUNT(*) as total FROM runs WHERE project_id = ? AND user_id = ?")
        .get(project.id, userOf(req).id) as { total: number };

      res.json({ runs, total: totalRow.total, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // M60: Collaboration history (Team Activity timeline). Viewer access — every
  // collaborator can see the project's engineering story. Read-only union of
  // collaboration_changes + runs + audited Git/snapshot events; safe columns
  // only; deterministic ordering; opaque (at,id) cursor.
  router.get("/:id/collab/timeline", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
      const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
      const before =
        typeof req.query.before === "string" && req.query.before.length <= 256
          ? req.query.before
          : null;
      res.json(
        queryTimeline(db, req.params.id, {
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          before,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // M60: "While you were away". Authoritative boundary is the server-side
  // collab_last_seen for the caller, clamped to COLLAB_AWAY_MAX_LOOKBACK_MS.
  router.get("/:id/collab/while-away", (req, res, next) => {
    try {
      const user = userOf(req);
      requireProjectAccess(db, user.id, req.params.id, "viewer");
      const stored = getLastSeen(db, req.params.id, user.id);
      const clampBoundary = new Date(Date.now() - cfg.collabAwayMaxLookbackMs).toISOString();
      const since = stored && stored > clampBoundary ? stored : clampBoundary;
      const { events } = queryWhileAway(db, req.params.id, user.id, since, cfg.collabAwayMaxEvents);
      // Group by author, most-recently-active author first.
      const byAuthor = new Map<number, typeof events>();
      for (const e of events) {
        const k = e.actor.userId ?? -1;
        const arr = byAuthor.get(k);
        if (arr) arr.push(e);
        else byAuthor.set(k, [e]);
      }
      const groupedByAuthor = [...byAuthor.entries()]
        .map(([userId, evs]) => ({
          userId,
          username: evs[0]!.actor.username,
          events: evs,
        }))
        .sort((a, b) => (b.events[0]?.at ?? "").localeCompare(a.events[0]?.at ?? ""));
      res.json({ since, events, groupedByAuthor });
    } catch (err) {
      next(err);
    }
  });

  // M60: acknowledge the while-away card — advances collab_last_seen so a
  // refresh / repeated reconnect does not re-surface the same events.
  router.post("/:id/collab/while-away/ack", (req, res, next) => {
    try {
      const user = userOf(req);
      requireProjectAccess(db, user.id, req.params.id, "viewer");
      const upTo =
        typeof req.body?.upTo === "string" &&
        req.body.upTo.length <= 40 &&
        !Number.isNaN(Date.parse(req.body.upTo))
          ? req.body.upTo
          : new Date().toISOString();
      touchLastSeen(db, req.params.id, user.id, upTo);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
