import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { parse } from "node:url";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { requireProjectAccess } from "../projects/service.js";
import { handleTerminalConnection } from "./terminal.js";
import { handleExecutionConnection } from "./execution.js";
import { handleLspConnection } from "../lsp/ws.js";
import { handleDebugConnection } from "../debug/ws.js";
import { hashToken } from "../auth/middleware.js";
import { AdminTelemetryStreamManager } from "../admin/telemetry-stream.js";
import { collaborationManager } from "../collab/manager.js";
import { insertLastSeenIfAbsent } from "../collab/lastSeen.js";
import { ApiError } from "../errors.js";
import { resolveProxyEntry } from "../projects/proxyTargets.js";
import {
  registerConnection,
  unregisterConnection,
  registerProxySocket,
  unregisterProxySocket,
} from "./connectionRegistry.js";

// ---------------------------------------------------------------------------
// M3 (BUG-4): WebSocket hardening — payload limits + heartbeat reaper.
//
// Two failure classes are closed here:
//  1. Frame-size abuse: without `maxPayload`, ws accepts ~100 MiB frames,
//     letting any authenticated socket allocate unbounded memory before any
//     handler runs. The limit now matches the REST JSON body budget (1 MiB);
//     violations fail the connection with standard close code 1009.
//  2. Dead peers: half-open TCP connections (sleep, NAT drops, crashes) held
//     PTY terminals, room seats, and registry entries until OS-level timeouts
//     fired. A server-initiated ping/pong sweep now detects non-responders
//     within two intervals and terminates them; existing per-route
//     close/error handlers perform the actual resource cleanup.
//
// Design notes:
//  - Controller + socket metadata live in module-level WeakMaps so multiple
//    server instances (tests!) never contaminate each other and finished
//    sockets are GC-able without manual deregistration.
//  - The public signature of setupWebSocketServer is unchanged; cadence is
//    configured via WS_HEARTBEAT_INTERVAL_MS (read at start()).
// ---------------------------------------------------------------------------

export const DEFAULT_WS_MAX_PAYLOAD = 1024 * 1024; // 1 MiB
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatController {
  /** Idempotently arms the periodic sweep (no-op while already running). */
  start(): void;
  /** Clears the interval. Safe to call repeatedly; sweep() stays usable. */
  stop(): void;
  /** Synchronous single pass over wss.clients — deterministic testing hook
   *  and the primitive the interval drives in production. */
  sweep(): void;
}

interface SocketMetadata {
  isAlive: boolean;
  pathname?: string;
  userId?: string;
}

const heartbeatControllers = new WeakMap<
  WebSocketServer,
  HeartbeatController
>();
const socketMeta = new WeakMap<WebSocket, SocketMetadata>();

function resolveHeartbeatIntervalMs(): number {
  const raw = Number(process.env.WS_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_WS_HEARTBEAT_INTERVAL_MS;
}

/**
 * Registers a freshly upgraded WebSocket with the heartbeat subsystem:
 * seeds liveness metadata, refreshes it on pong, and adds an observational
 * error listener that attributes frame-limit violations (the socket's own
 * route handler remains responsible for teardown/logging semantics).
 */
function adoptClient(
  ws: WebSocket,
  meta: Omit<SocketMetadata, "isAlive">,
): void {
  socketMeta.set(ws, { isAlive: true, ...meta });

  ws.on("pong", () => {
    const m = socketMeta.get(ws);
    if (m) m.isAlive = true;
  });

  // Observational only: oversized frames make ws emit a RangeError
  // (code WS_ERR_UNSUPPORTED_MESSAGE_LENGTH) and fail the connection with
  // 1009 on its own. We log attribution here so abuse is traceable without
  // altering the route-specific error handling that already exists.
  ws.on("error", (err) => {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("WS_ERR_")) {
      const m = socketMeta.get(ws);
      console.warn(
        "[ws] frame_limit_violation",
        JSON.stringify({
          event: "ws_frame_limit_violation",
          code,
          message: err instanceof Error ? err.message : String(err),
          pathname: m?.pathname ?? null,
          userId: m?.userId ?? null,
        }),
      );
    }
  });
}

function createHeartbeatController(wss: WebSocketServer): HeartbeatController {
  let timer: NodeJS.Timeout | null = null;

  const sweep = (): void => {
    for (const client of wss.clients) {
      const meta = socketMeta.get(client);
      if (!meta) continue; // foreign/unmanaged socket (e.g. raw proxy pipe)

      if (meta.isAlive === false) {
        console.warn(
          "[ws] heartbeat timeout",
          JSON.stringify({
            event: "ws_heartbeat_timeout",
            pathname: meta.pathname ?? null,
            userId: meta.userId ?? null,
            reason: "heartbeat_timeout",
          }),
        );
        try {
          client.terminate();
        } catch {}
      } else {
        meta.isAlive = false;
        try {
          client.ping();
        } catch {
          try {
            client.terminate();
          } catch {}
        }
      }
    }
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const start = (): void => {
    if (!timer) {
      timer = setInterval(sweep, resolveHeartbeatIntervalMs());
      // Never hold the process open on our account; performGracefulShutdown
      // additionally stops us explicitly.
      timer.unref?.();
    }
  };

  return { start, stop, sweep };
}

/**
 * Returns the heartbeat controller bound to this server instance, or
 * undefined when the server was not created through setupWebSocketServer.
 */
export function getHeartbeatController(
  wss: WebSocketServer,
): HeartbeatController | undefined {
  return heartbeatControllers.get(wss);
}

export function setupWebSocketServer(
  server: any,
  db: Db,
  cfg: AppConfig,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: DEFAULT_WS_MAX_PAYLOAD,
  });
  const adminStreamManager = AdminTelemetryStreamManager.getInstance();
  adminStreamManager.init(db, cfg);

  const heartbeat = createHeartbeatController(wss);
  heartbeatControllers.set(wss, heartbeat);
  heartbeat.start();

  server.on(
    "upgrade",
    async (req: IncomingMessage, socket: any, head: Buffer) => {
      const { pathname, query } = parse(req.url || "", true);

      // Auth validation — session cookie
      let token = "";
      if (req.headers.cookie) {
        const match = req.headers.cookie.match(
          /(?:^|;\s*)session_token=([^;]+)/,
        );
        if (match) token = match[1];
      }

      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const hashedToken = hashToken(token);
      const row = db
        .prepare(
          `SELECT s.token, s.expires_at, u.id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
        )
        .get(hashedToken) as
        | {
            token: string;
            expires_at: string;
            id: number;
            username: string;
            role?: string;
          }
        | undefined;

      if (!row || new Date(row.expires_at).getTime() < Date.now()) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // 1. Admin Telemetry & Event Stream Upgrade
      if (pathname === "/ws/admin" || pathname === "/ws/admin/telemetry") {
        if (row.role !== "admin") {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          adoptClient(ws, {
            pathname: pathname ?? undefined,
            userId: String(row.id),
          });
          registerConnection(row.id, ws);
          ws.on("close", () => unregisterConnection(row.id, ws));
          // Own the 'error' path here rather than relying on addClient()
          // happening to attach one: an 'error' event with zero listeners
          // throws synchronously and takes down the whole process, and the
          // connection registry must be cleaned up on the error path too.
          ws.on("error", (err) => {
            console.error("[ws] admin socket error:", err);
            unregisterConnection(row.id, ws);
          });
          adminStreamManager.addClient(ws);
        });
        return;
      }

      // 2. Web Preview Proxy Upgrade (project id comes from the URL path,
      // not ?projectId=, so this must run before the projectId query-param
      // block below — otherwise every preview upgrade would get a spurious
      // 400).
      const proxyMatch = pathname?.match(
        /^\/api\/projects\/([^/]+)\/proxy\/(\d+)(?:\/.*)?$/,
      );
      if (proxyMatch) {
        const [, proxyProjectId, proxyPortRaw] = proxyMatch;
        try {
          const { entry } = await resolveProxyEntry(
            db,
            row.id,
            proxyProjectId,
            proxyPortRaw,
            cfg,
          );
          registerProxySocket(row.id, socket);
          socket.on("close", () => unregisterProxySocket(row.id, socket));
          socket.on("error", (err: unknown) => {
            console.error("[ws] proxy socket error:", err);
            unregisterProxySocket(row.id, socket);
          });
          entry.proxy.upgrade(req, socket, head);
        } catch (err) {
          if (err instanceof ApiError) {
            const reasonPhrase =
              err.status === 400
                ? "400 Bad Request"
                : err.status === 401
                  ? "401 Unauthorized"
                  : err.status === 403
                    ? "403 Forbidden"
                    : err.status === 404
                      ? "404 Not Found"
                      : "500 Internal Server Error";
            socket.write(`HTTP/1.1 ${reasonPhrase}\r\n\r\n`);
          } else {
            console.error("[ws] proxy upgrade error:", err);
            socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          }
          socket.destroy();
        }
        return;
      }

      // 3. Project Workload & Collaboration Upgrades
      const projectId = query.projectId as string;
      if (!projectId) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      let accessRole: "owner" | "editor" | "viewer";
      try {
        const minRole =
          pathname === "/ws/terminal" ||
          pathname === "/ws/execute" ||
          pathname === "/ws/debug"
            ? "editor"
            : "viewer";
        const access = requireProjectAccess(db, row.id, projectId, minRole);
        accessRole = access.role;
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      if (pathname === "/ws/collab") {
        const room = collaborationManager.getOrCreateRoom(projectId);
        wss.handleUpgrade(req, socket, head, (ws) => {
          adoptClient(ws, {
            pathname: pathname ?? undefined,
            userId: String(row.id),
          });
          registerConnection(row.id, ws);
          room.addClient(ws, {
            userId: row.id,
            username: row.username,
            role: accessRole,
          });
          // M60: seed a last-seen boundary on the FIRST ever connect to this
          // project (no-op afterwards) — a first-time collaborator has no
          // "while you were away" backlog. The boundary then advances only on
          // disconnect and on while-away ack.
          insertLastSeenIfAbsent(db, projectId, row.id);

          ws.on("message", (data: any) => {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            room.handleMessage(ws, u8);
          });

          ws.on("close", () => {
            unregisterConnection(row.id, ws);
            room.removeClient(ws);
          });

          ws.on("error", () => {
            unregisterConnection(row.id, ws);
            room.removeClient(ws);
          });
        });
      } else if (pathname === "/ws/terminal") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          adoptClient(ws, {
            pathname: pathname ?? undefined,
            userId: String(row.id),
          });
          registerConnection(row.id, ws);
          ws.on("close", () => unregisterConnection(row.id, ws));
          // ws (the library) throws and crashes the process on an 'error'
          // event with no listeners — a single client sending a malformed
          // frame or dropping the TCP connection abnormally would otherwise
          // take down the whole server for every connected user.
          ws.on("error", (err) => {
            console.error("[ws] terminal socket error:", err);
            unregisterConnection(row.id, ws);
          });
          const terminalId =
            typeof query.terminalId === "string"
              ? query.terminalId
              : undefined;
          const lastSeqRaw = Number(query.lastSeq);
          handleTerminalConnection(
            ws,
            projectId,
            cfg,
            row.id,
            db,
            terminalId,
            Number.isFinite(lastSeqRaw) ? lastSeqRaw : 0,
          ).catch((err) => {
            console.error("[ws] terminal connection error:", err);
            ws.close();
          });
        });
      } else if (pathname === "/ws/execute") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          adoptClient(ws, {
            pathname: pathname ?? undefined,
            userId: String(row.id),
          });
          registerConnection(row.id, ws);
          ws.on("close", () => unregisterConnection(row.id, ws));
          ws.on("error", (err) => {
            console.error("[ws] execution socket error:", err);
            unregisterConnection(row.id, ws);
          });
          handleExecutionConnection(
            ws,
            projectId,
            row.id,
            row.username,
            cfg,
            db,
          ).catch((err) => {
            console.error("[ws] execution connection error:", err);
            ws.close();
          });
        });
      } else if (pathname === "/ws/debug") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          adoptClient(ws, {
            pathname: pathname ?? undefined,
            userId: String(row.id),
          });
          registerConnection(row.id, ws);
          ws.on("close", () => unregisterConnection(row.id, ws));
          ws.on("error", (err) => {
            console.error("[ws] debug socket error:", err);
            unregisterConnection(row.id, ws);
          });
          handleDebugConnection(ws, projectId, row.id, cfg).catch((err) => {
            console.error("[ws] debug connection error:", err);
            ws.close();
          });
        });
      } else if (pathname === "/ws/lsp") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          adoptClient(ws, {
            pathname: pathname ?? undefined,
            userId: String(row.id),
          });
          registerConnection(row.id, ws);
          ws.on("close", () => unregisterConnection(row.id, ws));
          ws.on("error", (err) => {
            console.error("[ws] lsp socket error:", err);
            unregisterConnection(row.id, ws);
          });
          const language =
            typeof query.language === "string" ? query.language : "";
          handleLspConnection(ws, projectId, language, row.id, cfg).catch(
            (err) => {
              console.error("[ws] lsp connection error:", err);
              ws.close();
            },
          );
        });
      } else {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
      }
    },
  );

  return wss;
}
