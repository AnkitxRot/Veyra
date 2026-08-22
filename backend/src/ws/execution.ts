import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { runProject } from '../execution/pipeline.js';
import { workspacePath } from '../projects/service.js';
import type { SandboxController } from '../execution/sandbox.js';
import { runGate } from '../execution/runGate.js';
import { telemetryHistorian } from '../execution/historian.js';

export async function handleExecutionConnection(
  ws: WebSocket,
  projectId: string,
  userId: number,
  cfg: AppConfig,
  db?: Db,
): Promise<void> {
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
  let activeCleanup: (() => void) | null = null;

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
        const executionId = randomUUID();
        telemetryHistorian.trackExecutionStart(projectId, executionId);

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          telemetryHistorian.trackExecutionEnd(projectId, executionId);
          runGate.release(userId);
          running = false;
          controller = null;
          activeCleanup = null;
        };
        activeCleanup = finish;

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

          const execSummary = telemetryHistorian.queryExecutionTelemetry(projectId, executionId).summary;
          
          // Record run into SQLite execution history
          if (db) {
            try {
              db.prepare(`
                INSERT INTO runs (id, project_id, user_id, language, file_path, status, exit_code, signal, duration_ms, peak_memory_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                executionId,
                projectId,
                userId,
                result.language ?? 'unknown',
                result.mainFile ?? (parsed.activeFile || 'unknown'),
                result.type,
                result.exitCode ?? (result.type === 'success' ? 0 : 1),
                result.signal ?? null,
                result.durationMs,
                execSummary.peakMemoryBytes || 0
              );
            } catch (dbErr) {
              console.error('[execution] failed to record run history:', dbErr);
            }
          }

          if (ws.readyState === ws.OPEN) {
            if (result.type !== 'success' && result.stderr) {
              ws.send(JSON.stringify({ type: 'stderr', data: result.stderr }));
            }
            ws.send(JSON.stringify({
              type: 'exit',
              executionId,
              result,
              telemetrySummary: execSummary,
            }));
          }
        } catch (err) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', data: err instanceof Error ? err.message : String(err) }));
          }
        } finally {
          finish();
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
    } catch {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    if (controller) {
      controller.kill();
    }
    if (activeCleanup) {
      activeCleanup();
    }
  });
}
