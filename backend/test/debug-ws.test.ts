import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import type { AppConfig } from "../src/config.js";
import type { DebugSpawnRequest } from "../src/debug/process.js";

const fakeDap = fileURLToPath(new URL("./fixtures/fake-dap.mjs", import.meta.url));

function spawnFake() {
  return (_req: DebugSpawnRequest) =>
    spawn(process.execPath, [fakeDap], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

describe("debug websocket authz", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let token: string;
  let otherToken: string;
  let viewerToken: string;
  let projectId: string;

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

    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dbgowner", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    token = reg.token;

    const other = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dbgstranger", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    otherToken = other.token;

    const viewer = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dbgviewer", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    viewerToken = viewer.token;

    const proj = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "dbg-ws-demo" }),
    }).then((r) => r.json() as Promise<{ project: { id: string } }>);
    projectId = proj.project.id;

    await fetch(`${base}/api/projects/${projectId}/collaborators`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ username: "dbgviewer", role: "viewer" }),
    });
    mkdirSync(join(cfg.workspacesDir, projectId), { recursive: true });
    writeFileSync(join(cfg.workspacesDir, projectId, "main.py"), "x = 1\ny = 2\nz = x + y\n");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetDebugSessionsForTests();
    debugSessions.setSpawnForTests(spawnFake());
    debugSessions.setContainerForTests(() => "ide-sandbox-ws");
  });
  afterEach(() => {
    resetDebugSessionsForTests();
  });

  function port(): number {
    return (server.address() as { port: number }).port;
  }

  it("rejects an unauthenticated upgrade", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/debug?projectId=${projectId}`,
    );
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on("open", () => reject(new Error("opened without auth")));
      ws.on("error", () => {});
    });
    expect(code).toBe(401);
  });

  it("rejects a user who does not have the project", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/debug?projectId=${projectId}`,
      { headers: { Cookie: `session_token=${otherToken}` } },
    );
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on("open", () => reject(new Error("opened for outsider")));
      ws.on("error", () => {});
    });
    expect(code).toBe(403);
  });

  it("rejects a viewer (debug requires editor)", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/debug?projectId=${projectId}`,
      { headers: { Cookie: `session_token=${viewerToken}` } },
    );
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on("open", () => reject(new Error("opened for viewer")));
      ws.on("error", () => {});
    });
    expect(code).toBe(403);
  });

  it("accepts the owner and speaks the mediated protocol", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/debug?projectId=${projectId}`,
      { headers: { Cookie: `session_token=${token}` } },
    );
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (data) => {
      messages.push(JSON.parse(String(data)));
    });
    await waitFor(() => messages.some((m) => m.type === "status"));
    ws.send(
      JSON.stringify({
        type: "launch",
        language: "python",
        entryFile: "main.py",
        breakpoints: { "main.py": [3] },
      }),
    );
    await waitFor(
      () => messages.some((m) => m.type === "status" && m.state === "paused"),
      5000,
    );
    ws.close();
  });

  it("does not drop a launch sent before attach finishes", async () => {
    debugSessions.setAttachDelayForTests(250);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/debug?projectId=${projectId}`,
      { headers: { Cookie: `session_token=${token}` } },
    );
    const messages: any[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(String(data)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "launch",
        language: "python",
        entryFile: "main.py",
        breakpoints: { "main.py": [3] },
      }),
    );
    await waitFor(
      () => messages.some((m) => m.type === "status" && m.state === "paused"),
      15_000,
    );
    ws.close();
  });
});
