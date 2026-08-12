import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { parse } from 'node:url';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { requireOwnedProject } from '../projects/service.js';
import { handleTerminalConnection } from './terminal.js';
import { handleExecutionConnection } from './execution.js';
import { hashToken } from '../auth/middleware.js';

export function setupWebSocketServer(server: any, db: Db, cfg: AppConfig): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    const { pathname, query } = parse(req.url || '', true);
    
    // Auth validation — prefer cookie, fall back to query param (e.g. scratch-test.js)
    let token = '';
    if (req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token && typeof query.token === 'string') {
      token = query.token;
    }
    
    const projectId = query.projectId as string;
    
    if (!token || !projectId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const row = db
      .prepare(
        `SELECT s.token, s.expires_at, u.id, u.username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(hashToken(token)) as { token: string; expires_at: string; id: number; username: string } | undefined;
      
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      requireOwnedProject(db, row.id, projectId);
    } catch (err) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pathname === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, projectId, cfg).catch(err => {
          console.error('[ws] terminal connection error:', err);
          ws.close();
        });
      });
    } else if (pathname === '/ws/execute') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleExecutionConnection(ws, projectId, cfg).catch(err => {
          console.error('[ws] execution connection error:', err);
          ws.close();
        });
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });
}
