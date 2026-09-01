import { createApp } from "./app.js";
import { resolveConfig, IS_WINDOWS, type AppConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { setupWebSocketServer, getHeartbeatController } from "./ws/index.js";
import { sandboxManager } from "./execution/sandbox.js";
import { telemetryHistorian } from "./execution/historian.js";
import { collaborationHistorian } from "./collab/historian.js";
import { deleteExpiredSessions } from "./auth/middleware.js";
import { cleanupExpiredDemoAccounts } from "./auth/demoGc.js";
import { hashPassword } from "./auth/passwords.js";
import { ensureAdminUser } from "./db.js";
import { collaborationManager } from "./collab/manager.js";
import { verifySecretsKeyOnStartup } from "./projectsecrets/store.js";
import { instrumentDb, startEventLoopMonitor } from "./observability.js";
import type { WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";

const ADMIN_USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

/**
 * Bootstrap the local administrator account. ADMIN_PASSWORD is required on
 * first run (when no admin account exists yet); once one exists, startup
 * proceeds without it and the existing account's password is left untouched.
 * Runs to completion before the HTTP listener opens, so no request can race
 * the initial admin insert. `admin` (or ADMIN_USERNAME) is reserved from
 * public registration in auth/routes.ts, so this can't be pre-empted by a
 * squatted username.
 */
async function bootstrapAdmin(config: AppConfig, db: Db): Promise<void> {
  const adminUser = config.adminUsername;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    const { count } = db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
      .get() as { count: number };
    if (count === 0) {
      console.error(
        "[admin] ADMIN_PASSWORD is not set and no administrator account exists. " +
          "Set ADMIN_USERNAME and ADMIN_PASSWORD and restart to provision the initial admin.",
      );
      process.exit(1);
    }
    return;
  }

  if (!ADMIN_USERNAME_RE.test(adminUser)) {
    console.error(
      `[admin] ADMIN_USERNAME "${adminUser}" is invalid: must be 3-32 characters of [a-zA-Z0-9_].`,
    );
    process.exit(1);
    return;
  }
  if (adminPass.length < config.minPasswordLength) {
    console.error(
      `[admin] ADMIN_PASSWORD must be at least ${config.minPasswordLength} characters.`,
    );
    process.exit(1);
    return;
  }

  const hash = await hashPassword(adminPass);
  ensureAdminUser(db, adminUser, hash);
}
export interface GracefulShutdownContext {
  server: HttpServer;
  wss: WebSocketServer;
  db: Db;
  config: AppConfig;
}

/**
 * M2 (BUG-2 fix): graceful teardown with collaboration persistence.
 *
 * Ordering contract:
 *   0. Background maintenance stops (reaper / telemetry sampling) so no new
 *      Docker or DB work starts while draining.
 *   1. Stop accepting new HTTP requests; drop idle keep-alive sockets.
 *   2. Stop accepting new WS upgrades; close (then hard-terminate stragglers)
 *      every live WS client.
 *   3. Flush ALL dirty collaboration rooms to disk — bounded by a timeout
 *      guard so one wedged room can never hold the process hostage. This is
 *      the step whose absence dropped up to 10s of collaborative edits on
 *      every restart/deploy.
 *   4. Close the SQLite database.
 *   5. Exit(0) via the injected exit hook (overridable in tests).
 *
 * A force-exit timer armed across the whole sequence guarantees termination
 * even if some socket refuses to drain, matching the previous behavior.
 */
export async function performGracefulShutdown(
  ctx: GracefulShutdownContext,
  options: { signal?: string; exit?: (code: number) => void } = {},
): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const { server, wss, db, config } = ctx;
  console.log(
    `[shutdown] ${options.signal ?? "shutdown"} received, draining...`,
  );

  // Force-exit fallback armed for the entire sequence.
  const forceTimer = setTimeout(() => {
    console.error("[shutdown] grace period elapsed, forcing exit");
    exit(0);
  }, config.shutdownGraceMs);
  forceTimer.unref();

  // 0. Stop background maintenance. The WS heartbeat sweep is maintenance:
  //    halting it first guarantees no terminate/ping work races the socket
  //    teardown below, and its (unref'd) interval can never delay exit.
  getHeartbeatController(wss)?.stop();
  sandboxManager.stopReaper();
  try {
    telemetryHistorian.stop();
  } catch (err) {
    console.error("[shutdown] telemetry historian stop failed:", err);
  }
  try {
    // M60: close every open edit burst and drain the write queue
    // synchronously (node:sqlite is synchronous) before the DB is closed.
    collaborationHistorian.stop();
  } catch (err) {
    console.error("[shutdown] collaboration historian stop failed:", err);
  }

  // 1. Stop accepting new HTTP requests. Idle keep-alive sockets are closed
  //    explicitly so the drain promise below resolves promptly even when
  //    browsers hold connection pools open.
  server.closeIdleConnections?.();
  const drained = new Promise<void>((resolve) => server.close(() => resolve()));

  // 2. Close every live WS client gracefully; stragglers that ignore the
  //    close handshake are terminated shortly so they cannot stall the drain.
  for (const client of wss.clients) {
    try {
      client.close(1001, "server shutting down");
    } catch {}
    const terminateTimer = setTimeout(() => {
      try {
        client.terminate();
      } catch {}
    }, 2000);
    terminateTimer.unref?.();
  }
  wss.close();

  // 3. Persist all dirty collaboration rooms. Budget: min(5s, grace-1s),
  //    i.e. bounded strictly inside the force-exit window so the database
  //    close below still runs under any plausible timing.
  const flushBudgetMs = Math.max(
    0,
    Math.min(5000, config.shutdownGraceMs - 1000),
  );
  const flushed = Promise.race([
    collaborationManager.flushAllRooms(),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, flushBudgetMs);
      t.unref?.();
    }),
  ]).catch((err) => {
    console.error("[shutdown] collaboration room flush failed:", err);
  });

  await Promise.all([drained, flushed]);

  // 4. Durable resources last.
  clearTimeout(forceTimer);
  try {
    db.close();
  } catch {}

  console.log("[shutdown] graceful shutdown complete");
  // 5.
  exit(0);
}

async function start(): Promise<void> {
  // Bootstrap is deliberately INSIDE start() so that importing this module
  // (e.g. from the shutdown regression tests, which need
  // performGracefulShutdown) never opens the real database, binds :3000, or
  // kicks off background maintenance as an import side effect.
  const config = resolveConfig();
  startEventLoopMonitor();
  const db = instrumentDb(openDb(config.dbPath));
  const app = createApp(config, db);

  await bootstrapAdmin(config, db);
  verifySecretsKeyOnStartup(config, db);

  // Startup hardening: drop expired sessions, purge expired demo accounts,
  // then reconcile Docker state (removes orphaned containers, rebuilds preview
  // port mappings). Reconcile is awaited so sandbox-dependent operations never
  // observe stale state.
  deleteExpiredSessions(db);
  try {
    await cleanupExpiredDemoAccounts(config, db);
  } catch (err) {
    console.error("[auth] startup demo GC failed:", err);
  }
  try {
    await sandboxManager.reconcile(config, db);
  } catch (err) {
    console.error("[sandbox] startup reconciliation failed:", err);
  }

  sandboxManager.startReaper(config);
  const sessionGcTimer = setInterval(() => {
    try {
      deleteExpiredSessions(db);
      void cleanupExpiredDemoAccounts(config, db).catch((err) => {
        console.error("[auth] periodic demo GC failed:", err);
      });
    } catch (err) {
      console.error("[auth] session GC failed:", err);
    }
  }, config.sessionGcIntervalMs);
  sessionGcTimer.unref();

  const server = app.listen(config.port, () => {
    console.log(
      `Cloud IDE backend listening on http://localhost:${config.port}`,
    );
    console.log(`  data dir:    ${config.dataDir}`);
    console.log(`  platform:    ${process.platform}`);
    console.log(
      `  run user:    ${config.runUser.user}${!IS_WINDOWS ? ` (uid ${config.runUser.uid})` : ""}`,
    );
    if (!IS_WINDOWS) {
      console.log(`  cgroup root: ${config.cgroupRoot}`);
    }
  });

  const wss = setupWebSocketServer(server, db, config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sessionGcTimer);
    void performGracefulShutdown({ server, wss, db, config }, { signal });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Auto-start only in real runtime. Under test runners (vitest sets VITEST=1;
// NODE_ENV=test is the conventional signal) importing this module must stay
// side-effect free — tests construct their own config/db/app and invoke
// performGracefulShutdown() directly.
const SHOULD_AUTO_START =
  !process.env.VITEST && process.env.NODE_ENV !== "test";

if (SHOULD_AUTO_START) {
  start().catch((err) => {
    console.error("[startup] fatal error:", err);
    process.exit(1);
  });
}
