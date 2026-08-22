import type { WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { AppConfig } from '../config.js';
import { workspacePath } from '../projects/service.js';
import { sandboxManager } from '../execution/sandbox.js';

export async function handleTerminalConnection(ws: WebSocket, projectId: string, cfg: AppConfig): Promise<void> {
  const cwd = await workspacePath(cfg, projectId);

  let containerId: string;
  try {
    containerId = await sandboxManager.ensureProjectSandbox(projectId, cfg, cwd);
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: `[terminal] failed to start sandbox: ${err.message}\r\n` }));
      ws.close();
    }
    return;
  }

  const ptyProcess = pty.spawn('docker', ['exec', '-it', '-e', 'TERM=xterm-256color', containerId, 'bash'], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
  });

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'data') {
        ptyProcess.write(parsed.data);
      } else if (parsed.type === 'resize') {
        ptyProcess.resize(parsed.cols || 80, parsed.rows || 30);
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    ptyProcess.kill();
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: '\r\n[terminal] Process exited.\r\n' }));
      ws.close();
    }
  });
}
