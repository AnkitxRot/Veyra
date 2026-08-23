import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { parse } from "node:url";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { makeTestConfig } from "./helpers.js";
import { ensureAdminUser, openDb, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/passwords.js";
import { activeConnectionCountForUser } from "../src/ws/connectionRegistry.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";

describe("ws URL parsing", () => {
  it("extracts pathname and query from /ws/execute URL", () => {
    const url = "/ws/execute?projectId=abc123";
    const { pathname, query } = parse(url, true);
    expect(pathname).toBe("/ws/execute");
    expect(query.projectId).toBe("abc123");
  });

  it("only consumes projectId from the query (auth is cookie-only)", () => {
    // A token in the URL must never be honored; the upgrade handler reads
    // the session_token cookie exclusively. Only projectId is consumed.
    const url = "/ws/execute?projectId=abc123&token=xyz";
    const { query } = parse(url, true);
    expect(query.projectId).toBe("abc123");
  });

  it("handles missing query params", () => {
    const { pathname, query } = parse("/ws/execute", true);
    expect(pathname).toBe("/ws/execute");
    expect(query.projectId).toBeUndefined();
    expect(query.token).toBeUndefined();
  });

  it("rejects empty projectId", () => {
    const { query } = parse("/ws/execute?projectId=", true);
    expect(query.projectId).toBe("");
    expect(!!query.projectId).toBe(false); // empty string is falsy
  });
});

describe("ws server survives a malformed client frame", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let token: string;
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
      body: JSON.stringify({ username: "wsmalformed", password: "secret123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    token = reg.token;

    const proj = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "ws-malformed-demo" }),
    }).then((r) => r.json() as Promise<{ project: { id: string } }>);
    projectId = proj.project.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function wsPort(): number {
    return (server.address() as { port: number }).port;
  }

  it("does not crash the process when /ws/execute receives an invalid frame (no stdin/output needed, no Docker required)", async () => {
    // Before the fix, ws/index.ts registered no 'error' listener on the
    // per-connection WebSocket for /ws/terminal or /ws/execute. Node's
    // EventEmitter throws synchronously when an 'error' event has zero
    // listeners, which — for a socket-level/protocol-level error raised
    // deep inside the `ws` library's frame receiver — becomes an uncaught
    // exception that crashes the entire backend process, dropping every
    // connected user, not just the offending connection. This test proves
    // the fix by asserting no uncaughtException fires when a genuinely
    // malformed frame (invalid opcode, unmasked — a real RFC 6455
    // violation) is written directly onto the raw TCP socket, bypassing
    // the `ws` client library's own frame encoder (which would never
    // produce an invalid frame on its own).
    let uncaught: unknown = null;
    const onUncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", onUncaught);

    try {
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${wsPort()}/ws/execute?projectId=${projectId}`,
        { headers: { Cookie: `session_token=${token}` } },
      );
      await new Promise<void>((resolve, reject) => {
        clientWs.on("open", () => resolve());
        clientWs.on("error", reject);
      });

      const rawSocket: any = (clientWs as any)._socket;
      // FIN=1, RSV=000, opcode=0xF (reserved/invalid per RFC 6455 5.2),
      // MASK=0 (client frames MUST be masked — also a protocol violation
      // on its own), payload length 0.
      rawSocket.write(Buffer.from([0x8f, 0x00]));

      // Give the server's receiver a moment to parse the frame and emit
      // 'error' (or, pre-fix, throw uncaught) before asserting.
      await new Promise((r) => setTimeout(r, 300));

      expect(uncaught).toBeNull();

      // The process — and this server instance specifically — must still
      // be alive and serving requests after the malformed frame.
      const health = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(health.status).toBe(200);

      clientWs.terminate();
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  });
});

describe("admin ws server survives a malformed client frame", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let adminToken: string;
  let adminUserId: number;

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

    // /ws/admin upgrades require role === 'admin', which register/login
    // never grants; promote via the same helper admin.test.ts uses.
    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wsmalformedadmin", adminHash);
    const login = await fetch(`${base}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "wsmalformedadmin",
        password: "AdminPass@123",
      }),
    }).then(
      (r) => r.json() as Promise<{ token: string; user: { id: number } }>,
    );
    adminToken = login.token;
    adminUserId = login.user.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not crash the process and unregisters the connection when /ws/admin receives an invalid frame (no Docker required)", async () => {
    // Same bug class as the /ws/execute test above, for the admin
    // telemetry stream branch: a per-connection WebSocket needs its own
    // 'error' listener (Node's EventEmitter throws synchronously when
    // 'error' has zero listeners, crashing the whole backend), and the
    // connection registry entry must be released on the error path so a
    // dead socket cannot linger as a live connection for that user.
    let uncaught: unknown = null;
    const onUncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", onUncaught);
    // The admin branch must own its own 'error' handling. Today
    // AdminTelemetryStreamManager.addClient() also attaches an 'error'
    // listener, which masks a missing one here — so assert on this
    // branch's own observable handler output, otherwise this test would
    // still pass with the handler deleted.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/admin`,
        { headers: { Cookie: `session_token=${adminToken}` } },
      );
      await new Promise<void>((resolve, reject) => {
        clientWs.on("open", () => resolve());
        clientWs.on("error", reject);
      });

      expect(activeConnectionCountForUser(adminUserId)).toBe(1);

      const rawSocket: any = (clientWs as any)._socket;
      // FIN=1, RSV=000, opcode=0xF (reserved/invalid per RFC 6455 5.2),
      // MASK=0 (client frames MUST be masked), payload length 0.
      rawSocket.write(Buffer.from([0x8f, 0x00]));

      await new Promise((r) => setTimeout(r, 300));

      expect(uncaught).toBeNull();

      // The /ws/admin branch's own error listener must have handled it.
      const handled = errorSpy.mock.calls.some(
        (call) => call[0] === "[ws] admin socket error:",
      );
      expect(handled).toBe(true);

      // The offending connection must be gone from the registry — it is
      // the only connection this admin user holds in this test.
      expect(activeConnectionCountForUser(adminUserId)).toBe(0);

      // The process — and this server instance specifically — must still
      // be alive and serving requests after the malformed frame.
      const health = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(health.status).toBe(200);

      clientWs.terminate();
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      errorSpy.mockRestore();
    }
  });
});
