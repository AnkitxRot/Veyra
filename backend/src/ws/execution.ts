import type { WebSocket } from 'ws';
import type { AppConfig } from '../config.js';
import { runProject } from '../execution/pipeline.js';
import { workspacePath } from '../projects/service.js';
import type { SandboxController } from '../execution/sandbox.js';
import { runGate } from '../execution/runGate.js';

export async function handleExecutionConnection(ws: WebSocket, projectId: string, userId: number, cfg: AppConfig): Promise<void> {
  let cwd: string;
  try {
    cwd = await workspacePath(cfg, projectId);
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', data: `Workspace not found: ${err.message}` }));
      ws.close();
    }
    return;
  }
  
  let controller: SandboxController | null = null;
  let running = false;

  ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      
      if (parsed.type === 'start') {
        if (running) {
          ws.send(JSON.stringify({ type: 'error', data: 'Execution already running' }));
          return;
        }
        if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
          ws.send(JSON.stringify({ type: 'error', data: 'Concurrent execution limit reached' }));
          return;
        }
        running = true;
        
        try {
          const result = await runProject(cfg, projectId, cwd, {
            language: parsed.language,
            activeFile: parsed.activeFile,
            onStdout: (data) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'stdout', data }));
            },
            onStderr: (data) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'stderr', data }));
            },
            onStatus: (data) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'status', data }));
            },
            onController: (ctrl) => {
              controller = ctrl;
            }
          });
          
          if (ws.readyState === ws.OPEN) {
            if (result.type !== 'success' && result.stderr) {
              ws.send(JSON.stringify({ type: 'stderr', data: result.stderr }));
            }
            ws.send(JSON.stringify({ type: 'exit', result }));
          }
        } catch (err) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', data: err instanceof Error ? err.message : String(err) }));
          }
        } finally {
          running = false;
          controller = null;
          runGate.release(userId);
        }
      } else if (parsed.type === 'stdin') {
        if (controller) {
          controller.writeStdin(parsed.data);
        }
      } else if (parsed.type === 'stop') {
        if (controller) {
          controller.kill();
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    if (controller) {
      controller.kill();
    }
  });
}
