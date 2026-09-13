import type { AppConfig } from "../config.js";
import { spawnSandboxDebug, type DebugSpawnFn } from "./process.js";
import {
  DebugSession,
  type DebugClientSocket,
  type DebugSessionLimits,
} from "./session.js";

export interface AttachDebugOpts {
  projectId: string;
  userId: number;
  cfg: AppConfig;
  socket: DebugClientSocket;
  workspaceDir: string;
  spawn?: DebugSpawnFn;
  containerId?: string;
}

function limitsFromConfig(cfg: AppConfig): DebugSessionLimits {
  return {
    startupTimeoutMs: cfg.debugStartupTimeoutMs,
    requestTimeoutMs: cfg.debugRequestTimeoutMs,
    sessionTimeoutMs: cfg.debugSessionTimeoutMs,
    messageMaxBytes: cfg.debugMessageMaxBytes,
    maxStackFrames: cfg.debugMaxStackFrames,
    maxVariables: cfg.debugMaxVariables,
    maxOutputChars: cfg.debugMaxOutputChars,
  };
}

function keyOf(projectId: string, userId: number): string {
  return `${projectId}:${userId}`;
}

function isLive(session: DebugSession): boolean {
  const s = session.currentState;
  return s === "starting" || s === "running" || s === "paused";
}

/**
 * User-owned debugger sessions. Isolation is the project sandbox; control is
 * per (project, user). Collaborators cannot operate another user's session.
 */
export class DebugSessionManager {
  private readonly sessions = new Map<string, DebugSession>();
  private spawnOverride: DebugSpawnFn | null = null;
  private containerOverride: ((projectId: string) => string) | null = null;
  private liveCount = 0;

  setSpawnForTests(fn: DebugSpawnFn | null): void {
    this.spawnOverride = fn;
  }

  setContainerForTests(fn: ((projectId: string) => string) | null): void {
    this.containerOverride = fn;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  liveSessionCount(): number {
    return this.liveCount;
  }

  sessionFor(projectId: string, userId: number): DebugSession | undefined {
    return this.sessions.get(keyOf(projectId, userId));
  }

  async attach(opts: AttachDebugOpts): Promise<DebugSession | null> {
    const key = keyOf(opts.projectId, opts.userId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.setSocket(opts.socket);
      return existing;
    }

    const containerId =
      opts.containerId ??
      this.containerOverride?.(opts.projectId) ??
      (await this.ensureContainer(opts));
    if (!containerId) return null;

    const spawn = opts.spawn ?? this.spawnOverride ?? spawnSandboxDebug;
    const session = new DebugSession(
      opts.projectId,
      opts.userId,
      opts.workspaceDir,
      containerId,
      {
        spawn,
        onDead: (s) => {
          const k = keyOf(s.projectId, s.userId);
          if (this.sessions.get(k) === s) this.sessions.delete(k);
        },
        tryAcquire: () => this.tryAcquire(opts.projectId, opts.userId, opts.cfg),
        release: () => {
          if (this.liveCount > 0) this.liveCount -= 1;
        },
      },
      limitsFromConfig(opts.cfg),
    );
    this.sessions.set(key, session);
    session.setSocket(opts.socket);
    return session;
  }

  disposeProject(projectId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.projectId === projectId) session.dispose("project_deleted");
    }
  }

  disposeUser(userId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.userId === userId) session.dispose("logout");
    }
  }

  disposeAll(reason = "server_shutdown"): void {
    for (const session of [...this.sessions.values()]) {
      session.dispose(reason);
    }
    this.sessions.clear();
    this.liveCount = 0;
  }

  private tryAcquire(
    projectId: string,
    userId: number,
    cfg: AppConfig,
  ): boolean {
    if (this.liveCount >= cfg.maxDebugSessions) return false;
    let perProject = 0;
    let perUser = 0;
    for (const s of this.sessions.values()) {
      if (!isLive(s)) continue;
      if (s.projectId === projectId) perProject += 1;
      if (s.userId === userId) perUser += 1;
    }
    if (perProject >= cfg.maxDebugSessionsPerProject) return false;
    if (perUser >= cfg.maxDebugSessionsPerUser) return false;
    this.liveCount += 1;
    return true;
  }

  private async ensureContainer(opts: AttachDebugOpts): Promise<string | null> {
    try {
      const { sandboxManager } = await import("../execution/sandbox.js");
      const { isDockerRunningAsync, isRunnerImageAvailableAsync } =
        await import("../tools.js");
      if (!(await isDockerRunningAsync())) return null;
      if (!(await isRunnerImageAvailableAsync())) return null;
      const id = await sandboxManager.ensureProjectSandbox(
        opts.projectId,
        opts.cfg,
        opts.workspaceDir,
        opts.userId,
      );
      sandboxManager.touch(opts.projectId);
      return id;
    } catch {
      return null;
    }
  }
}

export const debugSessions = new DebugSessionManager();

export function resetDebugSessionsForTests(): void {
  debugSessions.disposeAll("test_reset");
  debugSessions.setSpawnForTests(null);
  debugSessions.setContainerForTests(null);
}
