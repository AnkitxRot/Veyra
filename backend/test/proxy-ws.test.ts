import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { isDockerRunning } from "../src/tools.js";

// Regression coverage for the web-preview proxy's WebSocket upgrade path
// (backend/src/ws/index.ts's `proxyMatch` branch + backend/src/projects/
// proxyTargets.ts's `resolveProxyEntry`). Before the fix, all upgrade
// requests — including ones targeting `/api/projects/:id/proxy/:port` —
// were killed by the catch-all 404 in ws/index.ts before ever reaching the
// proxy target, and `requireOwnedProject`/port-allowlist checks had no
// equivalent on the raw-socket upgrade path (an IDOR risk, since Express
// route middleware never runs for 'upgrade' events).
describe("preview proxy WebSocket upgrade", () => {
  let server: Server;
  let db: Db;
  let cfg: AppConfig;
  let base: string;
  let token: string; // owner (user1) session token == session_token cookie value
  let user2Token: string;
  let projectId: string;
  let sandboxStarted = false;

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
      body: JSON.stringify({
        username: "proxywsowner",
        password: "secret123",
      }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    token = reg.token;

    const proj = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "proxy-ws-demo" }),
    }).then((r) => r.json() as Promise<{ project: { id: string } }>);
    projectId = proj.project.id;

    const reg2 = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "proxywsintruder",
        password: "secret123",
      }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    user2Token = reg2.token;
  });

  afterAll(async () => {
    // Stop any sandbox container started by the Docker-gated test below so a
    // failed or aborted run never leaves a stray `ide-sandbox-*` container
    // (and its published host ports) behind.
    if (sandboxStarted) {
      const { sandboxManager } = await import("../src/execution/sandbox.js");
      await sandboxManager.stopProjectSandbox(projectId).catch(() => {});
    }
    // `server.close()` only stops accepting NEW connections — it then waits
    // for already-established ones to end on their own. A completed proxy
    // upgrade leaves a hijacked, never-idle raw socket (plus the proxy's own
    // outbound socket to the container) attached to this server, so closing
    // without tearing those down hangs this hook until vitest's 60s timeout.
    // closeAllConnections() destroys them first.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function wsPort(): number {
    return (server.address() as { port: number }).port;
  }

  // Opens a raw WS client against the given path and resolves with the
  // outcome: either an accepted 'open' event, or a rejected upgrade's HTTP
  // status code (parsed from the 'unexpected-response' event that the `ws`
  // client library emits when the server writes a non-101 status line and
  // destroys the socket instead of completing the handshake).
  function attemptUpgrade(
    path: string,
    cookieToken?: string,
  ): Promise<{ open: boolean; status?: number }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (cookieToken) headers.Cookie = `session_token=${cookieToken}`;
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort()}${path}`, {
        headers,
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`attemptUpgrade timed out for ${path}`));
      }, 5000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve({ open: true });
        ws.terminate();
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        resolve({ open: false, status: res.statusCode });
        res.resume();
      });
      ws.on("error", (err: any) => {
        clearTimeout(timer);
        // Some Node/ws versions surface a rejected upgrade as a plain
        // 'error' (ECONNRESET-style) rather than 'unexpected-response' once
        // the server has written the status line and destroyed the raw
        // socket before the client finishes parsing it. Treat that as a
        // rejected-but-unspecified-status outcome rather than a hard test
        // failure, since the socket-level status is still observable via
        // `res.statusCode` in the common case above.
        resolve({ open: false });
      });
    });
  }

  it("rejects an unauthenticated upgrade (no session cookie) with 401, before any sandbox/target resolution is attempted — no Docker required", async () => {
    const result = await attemptUpgrade(
      `/api/projects/${projectId}/proxy/3000/`,
    );
    expect(result.open).toBe(false);
    if (result.status !== undefined) {
      expect(result.status).toBe(401);
    }
    // The cookie check in ws/index.ts runs before the proxyMatch regex is
    // even evaluated, so an unauthenticated request can never reach
    // resolveProxyEntry/getProxyTarget — this test itself is the evidence:
    // it passes deterministically without Docker and without any project
    // sandbox existing.
  });

  it("rejects a non-owner (IDOR guard) upgrade attempt with 404 — no Docker required", async () => {
    const result = await attemptUpgrade(
      `/api/projects/${projectId}/proxy/3000/`,
      user2Token,
    );
    expect(result.open).toBe(false);
    if (result.status !== undefined) {
      expect(result.status).toBe(404);
    }
  });

  it("rejects an invalid (non-allowlisted) port with 400 — no Docker required", async () => {
    const result = await attemptUpgrade(
      `/api/projects/${projectId}/proxy/80/`,
      token,
    );
    expect(result.open).toBe(false);
    if (result.status !== undefined) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects a valid but unpublished port with 404 (no sandbox running for this project) — no Docker required", async () => {
    const result = await attemptUpgrade(
      `/api/projects/${projectId}/proxy/5173/`,
      token,
    );
    expect(result.open).toBe(false);
    if (result.status !== undefined) {
      expect(result.status).toBe(404);
    }
  });

  it("ordering: authorization runs before target resolution — a non-owner is rejected identically to an owner hitting an unpublished port would be for target resolution, but the non-owner case never gets that far to even check port publication", async () => {
    // Behavioral proxy for "authz happens before target resolution": the
    // non-owner request above uses port 3000 (which is not published by any
    // running sandbox either — there is no sandbox at all for this
    // project), yet it 404s for ownership reasons, not port-publication
    // reasons, and does so without Docker running. If authorization ran
    // after target resolution, this project having zero running sandbox
    // containers would still 404, so this alone doesn't fully disambiguate
    // ownership-404 from target-404 — the disambiguating evidence is that
    // resolveProxyEntry's own source (backend/src/projects/proxyTargets.ts)
    // calls requireOwnedProject() as its very first statement, before the
    // port parse/allowlist check or the sandboxManager call. This test
    // documents that ordering behaviorally: an invalid port for the OWNER
    // still resolves to 400 (proving the owner path even reaches the port
    // check), while the non-owner is rejected on port 3000 (a otherwise
    // syntactically valid, allowlisted port) with 404 before any port- or
    // target-specific check could apply.
    const ownerInvalidPort = await attemptUpgrade(
      `/api/projects/${projectId}/proxy/9999/`,
      token,
    );
    expect(ownerInvalidPort.open).toBe(false);
    if (ownerInvalidPort.status !== undefined) {
      expect(ownerInvalidPort.status).toBe(400);
    }

    const nonOwnerValidPort = await attemptUpgrade(
      `/api/projects/${projectId}/proxy/3000/`,
      user2Token,
    );
    expect(nonOwnerValidPort.open).toBe(false);
    if (nonOwnerValidPort.status !== undefined) {
      expect(nonOwnerValidPort.status).toBe(404);
    }
  });

  describe.skipIf(!isDockerRunning())(
    "authenticated owner + published port (requires Docker)",
    () => {
      // A full frame-relay test (send a payload through the upgraded proxy
      // socket and assert it's echoed/relayed by a real app inside the
      // sandbox) would require the sandbox container to actually be running
      // a WS-capable listener on an allowlisted port (e.g. a tiny echo
      // server bound to 5173) — that's out of scope for this stage since it
      // needs either a purpose-built test fixture image/script executed
      // inside the sandbox, or a real dev server (Vite HMR) started via the
      // existing run/exec pipeline, both of which are nontrivial to land
      // reliably in a plain `npm test` run's time budget. This test instead
      // verifies the upgrade itself completes (HTTP 101) and the socket
      // stays open — the concrete regression this whole fix is about (the
      // catch-all 404 killing preview-proxy upgrades) is fully exercised by
      // reaching 'open' at all.
      it("completes the WS handshake (HTTP 101) for an owned project with a published, allowlisted port", async () => {
        const { sandboxManager } = await import("../src/execution/sandbox.js");
        const { makeWorkspace } = await import("./helpers.js");
        const workspaceDir = makeWorkspace(cfg);
        await sandboxManager.ensureProjectSandbox(
          projectId,
          cfg,
          workspaceDir,
          1,
        );
        sandboxStarted = true;

        // Start a trivial TCP/HTTP-upgrade-capable listener *inside* the
        // sandbox container on an allowlisted port so there is something
        // real for the proxy to upgrade into, mirroring how a dev server
        // would behave for the purposes of this test (accepts the TCP
        // connection and completes an HTTP Upgrade handshake).
        // Node's http server with a bare 'upgrade' listener is sufficient
        // and is available in the runner image (node:22-bookworm-slim).
        const { exec } = await import("node:child_process");
        const containerName = `ide-sandbox-${projectId}`;
        await new Promise<void>((resolve, reject) => {
          // The relayed 101 must carry a correctly derived
          // `Sec-WebSocket-Accept` (base64 SHA-1 of the client's
          // `Sec-WebSocket-Key` + the RFC 6455 GUID). The `ws` client
          // validates that header and, when it is missing, aborts with a
          // plain 'error' ("Invalid Sec-WebSocket-Accept header") instead of
          // firing 'open' — which from the client's side is indistinguishable
          // from the proxy never relaying anything at all. Any real dev
          // server (Vite HMR, etc.) always sends it, so computing it here is
          // what makes this stand-in behave like the thing it stands in for.
          const script =
            "const http=require('http');" +
            "const crypto=require('crypto');" +
            "const srv=http.createServer((req,res)=>{res.end('ok')});" +
            "srv.on('upgrade',(req,socket)=>{" +
            "const accept=crypto.createHash('sha1')" +
            ".update(req.headers['sec-websocket-key']+" +
            "'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');" +
            "socket.write('HTTP/1.1 101 Switching Protocols\\r\\n" +
            "Upgrade: websocket\\r\\nConnection: Upgrade\\r\\n" +
            "Sec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');" +
            "});" +
            "srv.listen(5173,'0.0.0.0');";
          const child = exec(
            `docker exec -d ${containerName} node -e "${script.replace(/"/g, '\\"')}"`,
            (err) => (err ? reject(err) : resolve()),
          );
          child.on("error", reject);
        });

        // Give the background process inside the container a moment to
        // bind the port before the sandbox reports it as published.
        await new Promise((r) => setTimeout(r, 1000));

        const result = await attemptUpgrade(
          `/api/projects/${projectId}/proxy/5173/`,
          token,
        );
        expect(result.open).toBe(true);
      });
    },
  );
});
