import { createApp } from './app.js';
import { resolveConfig, IS_WINDOWS } from './config.js';
import { openDb } from './db.js';
import { setupWebSocketServer } from './ws/index.js';
import { sandboxManager } from './execution/sandbox.js';
import { deleteExpiredSessions } from './auth/middleware.js';
import { hashPassword } from './auth/passwords.js';
import { ensureAdminUser } from './db.js';

const config = resolveConfig();
const db = openDb(config.dbPath);
const app = createApp(config, db);

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
async function bootstrapAdmin(): Promise<void> {
  const adminUser = config.adminUsername;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    const { count } = db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
      .get() as { count: number };
    if (count === 0) {
      console.error(
        '[admin] ADMIN_PASSWORD is not set and no administrator account exists. ' +
          'Set ADMIN_USERNAME and ADMIN_PASSWORD and restart to provision the initial admin.',
      );
      process.exit(1);
    }
    return;
  }

  if (!ADMIN_USERNAME_RE.test(adminUser)) {
    console.error(`[admin] ADMIN_USERNAME "${adminUser}" is invalid: must be 3-32 characters of [a-zA-Z0-9_].`);
    process.exit(1);
    return;
  }
  if (adminPass.length < config.minPasswordLength) {
    console.error(`[admin] ADMIN_PASSWORD must be at least ${config.minPasswordLength} characters.`);
    process.exit(1);
    return;
  }

  const hash = await hashPassword(adminPass);
  ensureAdminUser(db, adminUser, hash);
}

async function start(): Promise<void> {
  await bootstrapAdmin();

  // Startup hardening: drop expired sessions, then reconcile Docker state
  // (removes orphaned containers, rebuilds preview port mappings). Reconcile is
  // awaited so sandbox-dependent operations never observe stale state.
  deleteExpiredSessions(db);
  try {
    await sandboxManager.reconcile(config, db);
  } catch (err) {
    console.error('[sandbox] startup reconciliation failed:', err);
  }

  sandboxManager.startReaper(config);
  const sessionGcTimer = setInterval(() => {
    try {
      deleteExpiredSessions(db);
    } catch (err) {
      console.error('[auth] session GC failed:', err);
    }
  }, config.sessionGcIntervalMs);
  sessionGcTimer.unref();

  const server = app.listen(config.port, () => {
    console.log(`Cloud IDE backend listening on http://localhost:${config.port}`);
    console.log(`  data dir:    ${config.dataDir}`);
    console.log(`  platform:    ${process.platform}`);
    console.log(`  run user:    ${config.runUser.user}${!IS_WINDOWS ? ` (uid ${config.runUser.uid})` : ''}`);
    if (!IS_WINDOWS) {
      console.log(`  cgroup root: ${config.cgroupRoot}`);
    }
  });

  const wss = setupWebSocketServer(server, db, config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining...`);

    // Stop background maintenance first.
    sandboxManager.stopReaper();
    clearInterval(sessionGcTimer);

    // Close WebSocket connections cleanly. Closing each client triggers its
    // teardown (kills in-flight exec controllers and PTY sessions).
    for (const client of wss.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {}
    }
    wss.close();

    // Force-exit fallback in case long-lived connections never drain. This is
    // safe: persistent sandboxes, workspaces and the WAL-mode SQLite database
    // are left intact and recovered on the next startup.
    const forceTimer = setTimeout(() => {
      console.error('[shutdown] grace period elapsed, forcing exit');
      process.exit(0);
    }, config.shutdownGraceMs);
    forceTimer.unref();

    // Stop accepting new connections and wait for in-flight requests.
    server.close(() => {
      clearTimeout(forceTimer);
      try {
        db.close();
      } catch {}
      console.log('[shutdown] graceful shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[startup] fatal error:', err);
  process.exit(1);
});
