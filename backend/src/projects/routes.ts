import { Router } from "express";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { registerCollaboratorRoutes } from "./collaboratorRoutes.js";
import { registerCrudRoutes } from "./crudRoutes.js";
import { registerExecutionRoutes } from "./executionRoutes.js";
import { registerFileRoutes } from "./fileRoutes.js";
import { registerSearchRoutes } from "./searchRoutes.js";
import { registerSnapshotRoutes } from "./snapshotRoutes.js";
import { registerTelemetryRoutes } from "./telemetryRoutes.js";

// Route registration order matters (static paths before "/:id"); keep it as-is.
export function projectRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router();
  registerCrudRoutes(router, cfg, db);
  registerCollaboratorRoutes(router, cfg, db);
  registerTelemetryRoutes(router, cfg, db);
  registerSnapshotRoutes(router, cfg, db);
  registerFileRoutes(router, cfg, db);
  registerSearchRoutes(router, cfg, db);
  registerExecutionRoutes(router, cfg, db);

  return router;
}
