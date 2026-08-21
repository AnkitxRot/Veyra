import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { parse } from 'node:url';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { requireOwnedProject, requireProjectAccess } from '../projects/service.js';
import { handleTerminalConnection } from './terminal.js';
import { handleExecutionConnection } from './execution.js';
import { hashToken } from '../auth/middleware.js';
import { AdminTelemetryStreamManager } from '../admin/telemetry-stream.js';
import { collaborationManager } from '../collab/manager.js';

export function setupWebSocketServer(server: any, db: Db, cfg: AppConfig): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const adminStreamManager = AdminTelemetryStreamManager.getInstance();
  adminStreamManager.init(db, cfg);

  server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    const { pathname, query } = parse(req.url || '', true);
    
    // Auth validation — session cookie or header
    let token = '';
    if (req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token && typeof query.token === 'string') {
      token = query.token;
    }
    
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const hashedToken = hashToken(token);
    const row = db
      .prepare(
        `SELECT s.token, s.expires_at, u.id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(hashedToken) as { token: string; expires_at: string; id: number; username: string; role?: string } | undefined;
      
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 1. Admin Telemetry & Event Stream Upgrade
    if (pathname === '/ws/admin' || pathname === '/ws/admin/telemetry') {
      if (row.role !== 'admin') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        adminStreamManager.addClient(ws);
      });
      return;
    }

    // 2. Project Workload & Collaboration Upgrades
    const projectId = query.projectId as string;
    if (!projectId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    let accessRole: 'owner' | 'editor' | 'viewer';
    try {
      const minRole = (pathname === '/ws/terminal' || pathname === '/ws/execute') ? 'editor' : 'viewer';
      const access = requireProjectAccess(db, row.id, projectId, minRole);
      accessRole = access.role;
    } catch (err) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pathname === '/ws/collab') {
      const room = collaborationManager.getOrCreateRoom(projectId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        room.addClient(ws, {
          userId: row.id,
          username: row.username,
          role: accessRole,
        });

        ws.on('message', (data: any) => {
          const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
          room.handleMessage(ws, u8);
        });

        ws.on('close', () => {
          room.removeClient(ws);
        });

        ws.on('error', () => {
          room.removeClient(ws);
        });
      });
    } else if (pathname === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, projectId, cfg).catch((err) => {
          console.error('[ws] terminal connection error:', err);
          ws.close();
        });
      });
    } else if (pathname === '/ws/execute') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleExecutionConnection(ws, projectId, row.id, cfg, db).catch((err) => {
          console.error('[ws] execution connection error:', err);
          ws.close();
        });
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}
