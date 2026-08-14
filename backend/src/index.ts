import { createApp } from './app.js';
import { resolveConfig, IS_WINDOWS } from './config.js';
import { openDb } from './db.js';
import { setupWebSocketServer } from './ws/index.js';
import { sandboxManager } from './execution/sandbox.js';
import { deleteExpiredSessions } from './auth/middleware.js';

const config = resolveConfig();
const db = openDb(config.dbPath);
const app = createApp(config, db);

// Startup hardening: drop expired sessions, reconcile Docker state
// (removes orphaned containers, rebuilds preview port mappings), and
// start background lifecycle maintenance.
deleteExpiredSessions(db);
sandboxManager.reconcile(config, db).catch((err) => {
  console.error('[sandbox] startup reconciliation failed:', err);
});
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

setupWebSocketServer(server, db, config);
