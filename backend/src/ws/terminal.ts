import type { WebSocket } from "ws";
import * as pty from "node-pty";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { workspacePath } from "../projects/service.js";
import { sandboxManager } from "../execution/sandbox.js";
import { RunGate } from "../execution/runGate.js";
import { resolveSecretsForInjection } from "../projectsecrets/store.js";
import {
  writeContainerSecretsFile,
  renderSecretsEnvFile,
  type ContainerSecretsFile,
} from "../projectsecrets/inject.js";

/**
 * Per-user concurrent terminal PTY count. Separate resource class from
 * `sandboxGate` (sandbox.ts) — a user can have many terminal tabs open
 * against one project's single sandbox — same reasoning as searchGate being
 * separate from runGate. Exported so tests can inspect/reset it directly.
 */
export const terminalGate = new RunGate();

export async function handleTerminalConnection(
  ws: WebSocket,
  projectId: string,
  cfg: AppConfig,
  userId: number,
  db?: Db,
): Promise<void> {
  if (!terminalGate.acquire(userId, cfg.maxTerminalsPerUser)) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: `[terminal] too many concurrent terminals (max ${cfg.maxTerminalsPerUser})\r\n`,
        }),
      );
      ws.close();
    }
    return;
  }

  // Every exit path below — sandbox failure, disconnect-during-startup,
  // normal close, socket error — must release exactly once. Guard with a
  // flag rather than relying on a single call site, since 'close' and
  // 'error' can both fire for the same connection.
  let permitReleased = false;
  const releasePermit = () => {
    if (permitReleased) return;
    permitReleased = true;
    terminalGate.release(userId);
  };

  const cwd = await workspacePath(cfg, projectId);

  let containerId: string;
  try {
    containerId = await sandboxManager.ensureProjectSandbox(
      projectId,
      cfg,
      cwd,
      userId,
    );
  } catch (err: any) {
    releasePermit();
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: `[terminal] failed to start sandbox: ${err.message}\r\n`,
        }),
      );
      ws.close();
    }
    return;
  }

  // M47: resolve + stage project secrets before the shell starts. Access
  // authorization is already enforced upstream (ws/index.ts requires the
  // 'editor' role for /ws/terminal, so viewers never reach here). Fail
  // closed: if secrets exist but cannot be prepared, do not open a shell
  // without them.
  let secretsFile: ContainerSecretsFile | null = null;
  try {
    const env = db
      ? resolveSecretsForInjection(db, cfg, projectId, {
          userId,
          context: "terminal",
        })
      : {};
    const content = renderSecretsEnvFile(env);
    if (content.length > 0) {
      secretsFile = await writeContainerSecretsFile(containerId, content);
    }
  } catch (err: any) {
    releasePermit();
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: `[terminal] project secrets are unavailable: ${
            err?.code === "secrets_key_unavailable"
              ? "encryption is not configured on this server"
              : "could not prepare secrets"
          }\r\n`,
        }),
      );
      ws.close();
    }
    return;
  }

  // The client may have disconnected while the awaits above were pending; the
  // ws 'close' listener below is registered too late to ever see that event, so
  // spawning here would leak an orphaned `docker exec` shell nobody kills.
  if (ws.readyState !== ws.OPEN) {
    releasePermit();
    if (secretsFile) void secretsFile.cleanup();
    return;
  }

  const bashArgs = secretsFile
    ? ["bash", "-c", `set -a; . '${secretsFile.path}'; set +a; exec bash`]
    : ["bash"];

  const ptyProcess = pty.spawn(
    "docker",
    ["exec", "-it", "-e", "TERM=xterm-256color", containerId, ...bashArgs],
    {
      name: "xterm-color",
      cols: 80,
      rows: 30,
    },
  );

  ptyProcess.onData((data) => {
    // Terminal output is sandbox activity: keep the idle reaper from killing
    // the container this live shell is running inside.
    sandboxManager.touch(projectId);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });

  ws.on("message", (msg) => {
    try {
      // Any inbound traffic means the client is alive and using this terminal,
      // even if the payload turns out to be malformed.
      sandboxManager.touch(projectId);
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === "data") {
        ptyProcess.write(parsed.data);
      } else if (parsed.type === "resize") {
        ptyProcess.resize(parsed.cols || 80, parsed.rows || 30);
      }
    } catch {
      // ignore parse errors
    }
  });

  // Both 'close' and 'error' can fire for the same connection (an abrupt
  // socket error isn't always followed by 'close' promptly); guard the
  // whole teardown once so the pty is never signaled twice.
  let torndown = false;
  const teardown = () => {
    if (torndown) return;
    torndown = true;
    releasePermit();
    ptyProcess.kill();
    if (secretsFile) {
      const f = secretsFile;
      secretsFile = null;
      void f.cleanup();
    }
  };
  ws.on("close", teardown);
  ws.on("error", teardown);

  ptyProcess.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: "\r\n[terminal] Process exited.\r\n",
        }),
      );
      ws.close();
    }
  });
}
