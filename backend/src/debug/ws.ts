import type { WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import { debugSessions } from "./manager.js";
import type { DebugSession } from "./session.js";

const WS_OPEN = 1;
const MAX_QUEUED_FRAMES = 32;

/**
 * `/ws/debug` — authenticated, project-authorized, user-owned debugger.
 *
 * Query: `projectId` (required, already authorized by the upgrade handler).
 *
 * The client never names an executable, adapter, container, or host path.
 * Messages are JSON objects with a `type` field from the mediated command
 * set (`launch`, `continue`, …), plus server `status` / `stopped` frames.
 *
 * Launch may arrive on the socket while `attach()` is still creating the
 * sandbox. Frames are queued until the session is ready so a slow Docker
 * start cannot silently drop the first command.
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

  const queued: unknown[] = [];
  let buffering = true;
  let attached: DebugSession | null = null;

  const decode = (data: unknown): unknown | undefined => {
    try {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : String(data);
      if (text.length > cfg.debugMessageMaxBytes) return undefined;
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const dispatch = (data: unknown): void => {
    if (!attached) return;
    const parsed = decode(data);
    if (parsed === undefined) return;
    attached.handleClientMessage(ws, parsed);
  };

  ws.on("message", (data) => {
    if (buffering) {
      if (queued.length >= MAX_QUEUED_FRAMES) return;
      queued.push(data);
      return;
    }
    dispatch(data);
  });

  const session = await debugSessions.attach({
    projectId,
    userId,
    cfg,
    socket: ws,
    workspaceDir,
  });

  if (!session) {
    buffering = false;
    queued.length = 0;
    sendStatus(
      ws,
      "unavailable",
      "debugger unavailable (sandbox or capacity); editor remains usable",
    );
    ws.on("error", () => {});
    ws.on("close", () => {});
    return;
  }

  attached = session;
  buffering = false;
  for (const data of queued) dispatch(data);
  queued.length = 0;

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
