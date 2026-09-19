import express from "express";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { IS_WINDOWS } from "./config.js";
import { openDb, type Db } from "./db.js";
import { errorMiddleware, ApiError } from "./errors.js";
import { authRoutes } from "./auth/routes.js";
import { requireAuth, requireAdmin } from "./auth/middleware.js";
import { projectRoutes } from "./projects/routes.js";
import { projectSecretRoutes } from "./projectsecrets/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { aiRoutes } from "./ai/routes.js";
import { gitRoutes } from "./git/routes.js";
import { commentRoutes } from "./comments/routes.js";
import { getSystemCapabilitiesAsync } from "./tools.js";
import { initCgroupRoot, sandboxManager } from "./execution/sandbox.js";

import { telemetryHistorian } from "./execution/historian.js";
import { collaborationHistorian } from "./collab/historian.js";
import { collaborationManager } from "./collab/manager.js";

export function initDirectories(cfg: AppConfig): void {
  mkdirSync(cfg.workspacesDir, { recursive: true });
  if (!IS_WINDOWS) {
    initCgroupRoot(cfg.cgroupRoot);
  }
}

function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Preview renders in a same-origin iframe; SAMEORIGIN permits that while
    // blocking cross-origin framing.
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  };
}

export function createApp(cfg: AppConfig, existingDb?: Db): express.Express {
  initDirectories(cfg);
  const db = existingDb ?? openDb(cfg.dbPath);
  telemetryHistorian.init(db, cfg);
  collaborationManager.init(cfg, db);
  // M60: derived collaboration history. The historian broadcasts each closed
  // burst / callout back into the live room as a receive-only `collab_change`.
  collaborationHistorian.init(db, cfg);
  collaborationHistorian.setBroadcaster((projectId, ev) =>
    collaborationManager.broadcastCollabChange(
      projectId,
      ev as unknown as Record<string, unknown>,
    ),
  );
  // M74: let the sandbox lifecycle consult collaboration-room occupancy so an
  // occupied project's container is not idle-reaped and an empty one is
  // released sooner. Consumption lands in a later M74 commit.
  sandboxManager.setRoomOccupancyProvider((projectId) =>
    collaborationManager.roomOccupancy(projectId),
  );
  sandboxManager.setDb(db);
  const app = express();
  app.disable("x-powered-by");

  // Behind a reverse proxy (TLS termination / load balancer) trust the first
  // hop so req.ip and req.protocol reflect the real client. Without this, auth
  // rate limiting keys on the proxy address and secure cookies misbehave.
  if (cfg.trustProxy) {
    app.set("trust proxy", 1);
  } else {
    app.set("trust proxy", false);
  }

  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(securityHeaders());

  // Liveness: cheap, and deliberately independent of Docker so the process is
  // not restarted just because the execution runtime is unavailable.
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      status: "live",
      runUser: cfg.runUser.user,
      platform: process.platform,
    });
  });

  // Readiness: verifies the runtime dependencies needed to actually do work.
  app.get("/api/health/ready", async (_req, res) => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const caps = await getSystemCapabilitiesAsync();
    const ready = dbOk && caps.docker && caps.runnerImage;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      status: ready ? "ready" : "not_ready",
      checks: {
        database: dbOk,
        docker: caps.docker,
        runnerImage: caps.runnerImage,
      },
    });
  });

  app.get("/api/system/capabilities", async (_req, res) => {
    res.json(await getSystemCapabilitiesAsync());
  });

  app.use("/api/auth", authRoutes(db, cfg));
  app.use("/api/projects", requireAuth(db), projectRoutes(cfg, db));
  app.use("/api/projects", requireAuth(db), projectSecretRoutes(cfg, db));
  app.use("/api/projects", requireAuth(db), aiRoutes(cfg, db));
  app.use("/api/projects", requireAuth(db), gitRoutes(cfg, db));
  app.use("/api/projects", requireAuth(db), commentRoutes(cfg, db));
  app.use("/api/admin", requireAdmin(db), adminRoutes(cfg, db));

  // Production frontend serving: the built Vite SPA. Only enabled when the
  // build output exists, so tests and dev (Vite proxy) are unaffected.
  const indexHtml = join(cfg.frontendDist, "index.html");
  if (existsSync(indexHtml)) {
    app.use(express.static(cfg.frontendDist, { index: "index.html" }));
    // SPA fallback for client-side routes. Never intercept /api or /ws.
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
        return next();
      }
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, _res, next) =>
    next(new ApiError(404, "not found", "not_found")),
  );
  app.use(errorMiddleware);

  return app;
}
