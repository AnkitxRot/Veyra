import type { WebSocket } from "ws";
import * as pty from "node-pty";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import { sandboxManager } from "../execution/sandbox.js";

export async function handleTerminalConnection(
  ws: WebSocket,
  projectId: string,
  cfg: AppConfig,
): Promise<void> {
  const cwd = await workspacePath(cfg, projectId);

  let containerId: string;
  try {
    containerId = await sandboxManager.ensureProjectSandbox(
      projectId,
      cfg,
      cwd,
    );
  } catch (err: any) {
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

  // The client may have disconnected while the awaits above were pending; the
  // ws 'close' listener below is registered too late to ever see that event, so
  // spawning here would leak an orphaned `docker exec` shell nobody kills.
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  const ptyProcess = pty.spawn(
    "docker",
    ["exec", "-it", "-e", "TERM=xterm-256color", containerId, "bash"],
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

  ws.on("close", () => {
    ptyProcess.kill();
  });

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
