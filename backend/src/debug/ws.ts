import type { WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import { debugSessions } from "./manager.js";

const WS_OPEN = 1;

/**
 * `/ws/debug` — authenticated, project-authorized, user-owned debugger.
 *
 * Query: `projectId` (required, already authorized by the upgrade handler).
 *
 * The client never names an executable, adapter, container, or host path.
 * Messages are JSON objects with a `type` field from the mediated command
 * set (`launch`, `continue`, …), plus server `status` / `stopped` frames.
 */
export async function handleDebugConnection(
  ws: WebSocket,
  projectId: string,
  userId: number,
  cfg: AppConfig,
): Promise<void> {
  let workspaceDir: string;
  try {
    workspaceDir = await workspacePath(cfg, projectId);
  } catch (err: any) {
    sendStatus(ws, "unavailable", err?.message ?? "workspace not found");
    ws.close();
    return;
  }

  if (ws.readyState !== WS_OPEN) return;

  const session = await debugSessions.attach({
    projectId,
    userId,
    cfg,
    socket: ws,
    workspaceDir,
  });

  if (!session) {
    sendStatus(
      ws,
      "unavailable",
      "debugger unavailable (sandbox or capacity); editor remains usable",
    );
    ws.on("message", () => {});
    ws.on("error", () => {});
    ws.on("close", () => {});
    return;
  }

  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : String(data);
      if (text.length > cfg.debugMessageMaxBytes) return;
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    session.handleClientMessage(ws, parsed);
  });

  const drop = () => {
    session.clearSocket(ws);
  };
  ws.on("close", drop);
  ws.on("error", (err) => {
    console.error("[ws] debug socket error:", err);
    drop();
  });
}

function sendStatus(ws: WebSocket, state: string, message?: string): void {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "status", state, language: null, message }));
  } catch {}
}
