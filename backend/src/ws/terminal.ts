import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import * as pty from "node-pty";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { workspacePath } from "../projects/service.js";
import { sandboxManager } from "../execution/sandbox.js";
import { RunGate } from "../execution/runGate.js";
import {
  terminalSessions,
  type RegistryPty,
} from "../execution/terminalSessions.js";
import { resolveSecretsForInjection } from "../projectsecrets/store.js";
import {
  writeContainerSecretsFile,
  renderSecretsEnvFile,
  type ContainerSecretsFile,
} from "../projectsecrets/inject.js";

/**
 * Per-user concurrent terminal PTY count. Separate resource class from
 * `sandboxGate` (sandbox.ts). M79: a detached session still holds its slot
 * until reaped, and a reattach does not acquire a second one — the slot is
 * released exactly once, by the registry's `onEnd` callback wired below.
 * Exported so tests can inspect/reset it directly.
 */
export const terminalGate = new RunGate();

const TERMINAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function wireSocketToSession(
  ws: WebSocket,
  userId: number,
  projectId: string,
  terminalId: string,
): void {
  ws.on("message", (msg) => {
    // Any inbound traffic proves the client is alive and using this terminal.
    sandboxManager.touch(projectId);
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === "data") {
        terminalSessions.writeInput(userId, projectId, terminalId, parsed.data);
      } else if (parsed.type === "resize") {
        terminalSessions.resize(
          userId,
          projectId,
          terminalId,
          parsed.cols || 80,
          parsed.rows || 30,
        );
      }
    } catch {
      // ignore parse errors
    }
  });

  // Both 'close' and 'error' can fire for the same connection; detach once.
  // Scope the detach to THIS socket — if a newer socket has already displaced
  // it (single-writer takeover), this socket's late close must not detach the
  // successor's session.
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    terminalSessions.detach(
      userId,
      projectId,
      terminalId,
      ws as unknown as { readyState: number; send(d: string): void; close(): void },
    );
  };
  ws.on("close", detach);
  ws.on("error", detach);
}

export async function handleTerminalConnection(
  ws: WebSocket,
  projectId: string,
  cfg: AppConfig,
  userId: number,
  db?: Db,
  terminalIdParam?: string,
  lastSeqParam = 0,
): Promise<void> {
  const lastSeq =
    Number.isFinite(lastSeqParam) && lastSeqParam >= 0
      ? Math.floor(lastSeqParam)
      : 0;
  // A well-formed client-supplied id enables reattach. Anything else is a
  // fresh, server-owned session (back-compat with older clients).
  const terminalId =
    typeof terminalIdParam === "string" && TERMINAL_ID_RE.test(terminalIdParam)
      ? terminalIdParam
      : randomUUID();

  // -------------------------------------------------------------------------
  // REATTACH — an existing session for THIS (userId, projectId, terminalId).
  // Editor authorization was already enforced for this projectId in
  // ws/index.ts's upgrade handler, so it runs on every reattach too.
  // -------------------------------------------------------------------------
  if (terminalSessions.has(userId, projectId, terminalId)) {
    const res = terminalSessions.attach(
      userId,
      projectId,
      terminalId,
      ws as unknown as {
        readyState: number;
        send(d: string): void;
        close(): void;
      },
      lastSeq,
    );
    if (!res.ok) {
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: "ended",
            reason: res.reason ?? "process_exited",
          }),
        );
        ws.close();
      }
      return;
    }
    sandboxManager.touch(projectId);
    wireSocketToSession(ws, userId, projectId, terminalId);
    return;
  }

  // -------------------------------------------------------------------------
  // GONE — the client expected a reattach (it was streaming a session on this
  // terminalId, so it sent a non-zero lastSeq) but the server has no such
  // session: it was reaped (grace expiry / container teardown / role loss).
  // Report it honestly and close — a fresh shell needs an explicit new
  // terminalId from the client, never a silent respawn under the same UI.
  // -------------------------------------------------------------------------
  if (lastSeq > 0) {
    if (ws.readyState === ws.OPEN) {
      const reason =
        terminalSessions.reapedReason(userId, projectId, terminalId) ??
        "grace_expired";
      ws.send(JSON.stringify({ type: "ended", reason }));
      ws.close();
    }
    return;
  }

  // -------------------------------------------------------------------------
  // FRESH — spawn a new PTY and register the session.
  // -------------------------------------------------------------------------
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

  // M47: resolve + stage project secrets before the shell starts. Fail closed.
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

  // The client may have disconnected while the awaits above were pending.
  if (ws.readyState !== ws.OPEN) {
    releasePermit();
    if (secretsFile) void secretsFile.cleanup();
    return;
  }

  const bashArgs = secretsFile
    ? ["bash", "-c", `set -a; . '${secretsFile.path}'; set +a; exec bash`]
    : ["bash"];

  // `pty.spawn` can throw synchronously (docker CLI missing, a ConPTY init
  // failure on Windows, an ENOMEM). If it does, the gate slot acquired above
  // and the staged secrets file would both leak for the process lifetime —
  // after `maxTerminalsPerUser` such failures the user can never open a
  // terminal again. Release both and report the failure instead.
  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(
      "docker",
      ["exec", "-it", "-e", "TERM=xterm-256color", containerId, ...bashArgs],
      {
        name: "xterm-color",
        cols: 80,
        rows: 30,
      },
    );
  } catch (err: any) {
    releasePermit();
    if (secretsFile) void secretsFile.cleanup();
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: `[terminal] failed to start shell: ${err?.message ?? "spawn error"}\r\n`,
        }),
      );
      ws.close();
    }
    return;
  }

  // Adapter: the registry drives output/exit; every output chunk also keeps
  // the sandbox reaper away from this live shell's container.
  const registryPty: RegistryPty = {
    onData: (cb) =>
      ptyProcess.onData((data) => {
        sandboxManager.touch(projectId);
        cb(data);
      }),
    onExit: (cb) => ptyProcess.onExit(() => cb()),
    write: (data) => ptyProcess.write(data),
    resize: (cols, rows) => ptyProcess.resize(cols, rows),
    kill: () => ptyProcess.kill(),
  };

  const capturedSecrets = secretsFile;
  secretsFile = null; // ownership transfers to the registry entry

  try {
    terminalSessions.create({
      userId,
      projectId,
      terminalId,
      pty: registryPty,
      containerId,
      graceMs: cfg.terminalDetachGraceMs,
      secretsCleanup: capturedSecrets
        ? () => capturedSecrets.cleanup()
        : null,
      onEnd: releasePermit,
    });
  } catch (err: any) {
    // e.g. a concurrent connection for the same terminalId won the create
    // race. No registry entry exists for this call, so nothing will fire
    // `onEnd`/cleanup — release the slot, drop the secrets, kill this PTY.
    releasePermit();
    if (capturedSecrets) void capturedSecrets.cleanup();
    try {
      ptyProcess.kill();
    } catch {
      /* ignore */
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: `[terminal] failed to start shell: ${err?.message ?? "session error"}\r\n`,
        }),
      );
      ws.close();
    }
    return;
  }

  const attached = terminalSessions.attach(
    userId,
    projectId,
    terminalId,
    ws as unknown as {
      readyState: number;
      send(d: string): void;
      close(): void;
    },
    lastSeq,
  );
  if (!attached.ok) {
    // The PTY exited synchronously between create and attach. The registry
    // already reaped the entry and released the slot via `onEnd`.
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "ended",
          reason: attached.reason ?? "process_exited",
        }),
      );
      ws.close();
    }
    return;
  }
  wireSocketToSession(ws, userId, projectId, terminalId);
}
