import { createApp } from './app.js';
import { resolveConfig, IS_WINDOWS } from './config.js';
import { openDb } from './db.js';
import { setupWebSocketServer } from './ws/index.js';
import { sandboxManager } from './execution/sandbox.js';
import { deleteExpiredSessions } from './auth/middleware.js';

const config = resolveConfig();
const db = openDb(config.dbPath);
const app = createApp(config, db);

async function start(): Promise<void> {
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
