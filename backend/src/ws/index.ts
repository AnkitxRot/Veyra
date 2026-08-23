import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { parse } from "node:url";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { requireProjectAccess } from "../projects/service.js";
import { handleTerminalConnection } from "./terminal.js";
import { handleExecutionConnection } from "./execution.js";
import { hashToken } from "../auth/middleware.js";
import { AdminTelemetryStreamManager } from "../admin/telemetry-stream.js";
import { collaborationManager } from "../collab/manager.js";
import {
  registerConnection,
  unregisterConnection,
} from "./connectionRegistry.js";

export function setupWebSocketServer(
  server: any,
  db: Db,
  cfg: AppConfig,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const adminStreamManager = AdminTelemetryStreamManager.getInstance();
  adminStreamManager.init(db, cfg);

  server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
    const { pathname, query } = parse(req.url || "", true);

    // Auth validation — session cookie or header
    let token = "";
    if (req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token && typeof query.token === "string") {
      token = query.token;
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

    // 2. Project Workload & Collaboration Upgrades
    const projectId = query.projectId as string;
    if (!projectId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    let accessRole: "owner" | "editor" | "viewer";
    try {
      const minRole =
        pathname === "/ws/terminal" || pathname === "/ws/execute"
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
        registerConnection(row.id, ws);
        room.addClient(ws, {
          userId: row.id,
          username: row.username,
          role: accessRole,
        });

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
        handleTerminalConnection(ws, projectId, cfg).catch((err) => {
          console.error("[ws] terminal connection error:", err);
          ws.close();
        });
      });
    } else if (pathname === "/ws/execute") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        registerConnection(row.id, ws);
        ws.on("close", () => unregisterConnection(row.id, ws));
        ws.on("error", (err) => {
          console.error("[ws] execution socket error:", err);
          unregisterConnection(row.id, ws);
        });
        handleExecutionConnection(ws, projectId, row.id, cfg, db).catch(
          (err) => {
            console.error("[ws] execution connection error:", err);
            ws.close();
          },
        );
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  return wss;
}
