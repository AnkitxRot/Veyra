// M5a load harness: boots a real backend instance (real Express app, real
// SQLite DB, real instrumented DB/event-loop observability, real Docker
// sandbox path) in-process, exactly mirroring src/index.ts's production
// wiring — not a mock. Distinct from test/helpers.ts's startTestApi(),
// which deliberately skips instrumentDb()/startEventLoopMonitor() since
// unit/integration tests don't need load-test evidence.
import { createServer } from "node:http";
import { openDb, ensureAdminUser, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import {
  setupWebSocketServer,
  getHeartbeatController,
} from "../src/ws/index.js";
import { hashPassword } from "../src/auth/passwords.js";
import {
  instrumentDb,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  resetObservabilityForTests,
  getObservabilitySnapshot,
  type ObservabilitySnapshot,
} from "../src/observability.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { activeConnectionCount } from "../src/ws/connectionRegistry.js";
import { collaborationManager } from "../src/collab/manager.js";
import { makeTestConfig } from "../test/helpers.js";
import type { AppConfig, ConfigOverrides } from "../src/config.js";

export const LOAD_TEST_ADMIN_USERNAME = "loadtest_admin";
export const LOAD_TEST_ADMIN_PASSWORD = "loadtest-admin-password-1234";

export interface LoadTestServer {
  cfg: AppConfig;
  db: Db;
  baseUrl: string;
  wsBase: string;
  adminToken: string;
  snapshot(): ObservabilitySnapshot;
  close(): Promise<void>;
}

export async function bootstrapLoadTestServer(
  configOverrides: ConfigOverrides = {},
): Promise<LoadTestServer> {
  const cfg = makeTestConfig(configOverrides);
  resetObservabilityForTests();
  startEventLoopMonitor();
  const db = instrumentDb(openDb(cfg.dbPath));
  ensureAdminUser(
    db,
    LOAD_TEST_ADMIN_USERNAME,
    await hashPassword(LOAD_TEST_ADMIN_PASSWORD),
  );

  const app = createApp(cfg, db);
  const server = createServer(app);
  const wss = setupWebSocketServer(server, db, cfg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: LOAD_TEST_ADMIN_USERNAME,
      password: LOAD_TEST_ADMIN_PASSWORD,
    }),
  });
  const loginData = (await loginRes.json()) as { token: string };

  return {
    cfg,
    db,
    baseUrl,
    wsBase,
    adminToken: loginData.token,
    snapshot: () =>
      getObservabilitySnapshot({
        activeConnectionCount,
        getActiveRoomCount: () => collaborationManager.getActiveRoomCount(),
        getActiveSandboxCount: () => sandboxManager.getActiveSandboxCount(),
      }),
    close: async () => {
      stopEventLoopMonitor();
      getHeartbeatController(wss)?.stop();
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await sandboxManager.cleanupAllSandboxes().catch(() => {});
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
