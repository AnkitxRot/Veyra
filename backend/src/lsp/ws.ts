import type { WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import { workspacePath } from "../projects/service.js";
import { getLspLanguage } from "./languages.js";
import { languageServers } from "./manager.js";

const WS_OPEN = 1;

/**
 * `/ws/lsp` — authenticated, project-authorized language-server bridge.
 *
 * Query: `projectId` (required, already authorized by the upgrade handler)
 *        `language` (allowlisted: `python` | `typescript`)
 *
 * The client never names an executable. Messages are JSON-RPC 2.0 objects
 * (one WebSocket text frame per message), plus server `status` frames.
 */
export async function handleLspConnection(
  ws: WebSocket,
  projectId: string,
  languageRaw: unknown,
  userId: number,
  cfg: AppConfig,
): Promise<void> {
  const spec = getLspLanguage(languageRaw);
  if (!spec) {
    sendStatus(ws, "unavailable", String(languageRaw ?? ""), "unsupported language");
    ws.close(1008, "unsupported language");
    return;
  }

  let workspaceDir: string;
  try {
    workspaceDir = await workspacePath(cfg, projectId);
  } catch (err: any) {
    sendStatus(ws, "unavailable", spec.id, err?.message ?? "workspace not found");
    ws.close();
    return;
  }

  if (ws.readyState !== WS_OPEN) return;

  const session = await languageServers.attach({
    projectId,
    language: spec.id,
    userId,
    cfg,
    socket: ws,
    workspaceDir,
  });

  if (!session) {
    sendStatus(
      ws,
      "busy",
      spec.id,
      "language server capacity reached; editor remains usable",
    );
    // Keep the socket open so the client can show degraded state without
    // treating a close as "retry forever".
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
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    session.handleClientMessage(ws, parsed);
  });

  const drop = () => {
    session.removeClient(ws);
  };
  ws.on("close", drop);
  ws.on("error", (err) => {
    console.error("[ws] lsp socket error:", err);
    drop();
  });
}

function sendStatus(
  ws: WebSocket,
  state: string,
  language: string,
  message?: string,
): void {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "status", state, language, message }));
  } catch {}
}
