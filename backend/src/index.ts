import { createApp } from './app.js';
import { resolveConfig, IS_WINDOWS } from './config.js';
import { openDb } from './db.js';
import { setupWebSocketServer } from './ws/index.js';

const config = resolveConfig();
const app = createApp(config);
const db = openDb(config.dbPath);

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
