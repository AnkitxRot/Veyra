import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import {
  languageServers,
  resetLanguageServersForTests,
} from "../src/lsp/manager.js";
import type { AppConfig } from "../src/config.js";
import type { LspSpawnRequest } from "../src/lsp/process.js";

const fakeLsp = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

function spawnFake() {
  return (_req: LspSpawnRequest) =>
    spawn(process.execPath, [fakeLsp], {
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

describe("lsp websocket authz", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let token: string;
  let otherToken: string;
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
      body: JSON.stringify({ username: "lspowner", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    token = reg.token;

    const other = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "lspstranger", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    otherToken = other.token;

    const proj = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "lsp-ws-demo" }),
    }).then((r) => r.json() as Promise<{ project: { id: string } }>);
    projectId = proj.project.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetLanguageServersForTests();
    languageServers.setSpawnForTests(spawnFake());
    languageServers.setContainerForTests(() => "ide-sandbox-ws");
  });
  afterEach(() => {
    resetLanguageServersForTests();
  });

  function port(): number {
    return (server.address() as { port: number }).port;
  }

  it("rejects an unauthenticated upgrade", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/lsp?projectId=${projectId}&language=python`,
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
      `ws://127.0.0.1:${port()}/ws/lsp?projectId=${projectId}&language=python`,
      { headers: { Cookie: `session_token=${otherToken}` } },
    );
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on("open", () => reject(new Error("opened for stranger")));
      ws.on("error", () => {});
    });
    expect(code).toBe(403);
  });

  it("rejects an unknown language", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/lsp?projectId=${projectId}&language=not-a-lang`,
      { headers: { Cookie: `session_token=${token}` } },
    );
    const { status, closeCode } = await new Promise<{
      status: any;
      closeCode: number;
    }>((resolve, reject) => {
      let status: any;
      ws.on("message", (data) => {
        status = JSON.parse(String(data));
      });
      ws.on("close", (code) => resolve({ status, closeCode: code }));
      ws.on("error", reject);
    });
    expect(status?.state).toBe("unavailable");
    expect(closeCode).toBe(1008);
  });

  it("connects, becomes ready, and reuses the session on a second socket", async () => {
    const url = `ws://127.0.0.1:${port()}/ws/lsp?projectId=${projectId}&language=python`;
    const headers = { Cookie: `session_token=${token}` };
    const a = new WebSocket(url, { headers });
    const statuses: string[] = [];
    a.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "status") statuses.push(msg.state);
    });
    await new Promise<void>((resolve, reject) => {
      a.on("open", () => resolve());
      a.on("error", reject);
    });
    await waitFor(() => statuses.includes("ready"));
    const b = new WebSocket(url, { headers });
    await new Promise<void>((resolve, reject) => {
      b.on("open", () => resolve());
      b.on("error", reject);
    });
    expect(languageServers.sessionCount()).toBe(1);
    await waitFor(
      () => languageServers.sessionFor(projectId, "python")?.clientCount === 2,
    );
    expect(languageServers.sessionFor(projectId, "python")?.clientCount).toBe(2);
    a.close();
    b.close();
  });

  it("unknown path stays 404", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port()}/ws/nope?projectId=${projectId}`,
      { headers: { Cookie: `session_token=${token}` } },
    );
    const code = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on("error", () => {});
    });
    expect(code).toBe(404);
  });
});
