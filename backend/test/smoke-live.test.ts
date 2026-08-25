import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { isDockerRunningAsync } from "../src/tools.js";

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const smokeScriptPath = join(__dirname, "..", "..", "scripts", "smoke-test.js");

describe("Milestone 23 — Smoke Harness Live Server Execution", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;

  beforeAll(async () => {
    cfg = makeTestConfig();
    db = openDb(":memory:");
    const app = createApp(cfg, db);
    server = createServer(app);
    setupWebSocketServer(server, db, cfg);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      db.close();
    } catch {}
  });

  it("executes the full smoke test suite against a running server instance", async () => {
    const isDocker = await isDockerRunningAsync();
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        smokeScriptPath,
        `--url=${base}`,
      ]);

      expect(stdout).toContain("Veyra Automated Production Deployment Smoke Test");
      expect(stdout).toContain("[PASS] 1. Liveness Check");
      expect(stdout).toContain("[PASS] 2. Readiness Check");
      expect(stdout).toContain("[PASS] 3. Authentication & Session");
      expect(stdout).toContain("[PASS] 4. User Preferences Persistence");
      expect(stdout).toContain("[PASS] 5. Project Creation");
      expect(stdout).toContain("[PASS] 6. File Write & Read Fidelity");
      expect(stdout).toContain("[PASS] 7. Docker Sandbox Code Execution");
      expect(stdout).toContain("[PASS] 8. Preview Proxy Routing");
      expect(stdout).toContain("[PASS] 9. Workspace PKZIP Export");
      expect(stdout).toContain("[PASS] 10. WebSocket Collaboration Handshake");
      expect(stdout).toContain("[PASS] 11. Cleanup & Teardown");
      expect(stdout).toContain("Result:          ALL CHECKS PASSED (DEPLOYMENT READY)");
    } catch (err: any) {
      if (!isDocker) {
        // In a Docker-unavailable test environment, Scenario 7 fails with missing_toolchain
        // and reports exit 1, but all preceding and succeeding steps execute and cleanup succeeds.
        expect(err.code).toBe(1);
        expect(err.stdout).toContain("[PASS] 1. Liveness Check");
        expect(err.stdout).toContain("[PASS] 3. Authentication & Session");
        expect(err.stdout).toContain("[PASS] 4. User Preferences Persistence");
        expect(err.stdout).toContain("[PASS] 5. Project Creation");
        expect(err.stdout).toContain("[PASS] 6. File Write & Read Fidelity");
        expect(err.stdout).toContain("[FAIL] 7. Docker Sandbox Code Execution");
        expect(err.stdout).toContain("Docker Sandbox unavailable");
        expect(err.stdout).toContain("[PASS] 8. Preview Proxy Routing");
        expect(err.stdout).toContain("[PASS] 9. Workspace PKZIP Export");
        expect(err.stdout).toContain("[PASS] 10. WebSocket Collaboration Handshake");
        expect(err.stdout).toContain("[PASS] 11. Cleanup & Teardown");
        expect(err.stdout).toContain("Smoke Suite Summary");
      } else {
        throw err;
      }
    }
  });
});
