import type { AppConfig } from "../config.js";
import { getLspLanguage, type LspLanguageSpec } from "./languages.js";
import { spawnSandboxLsp, type LspSpawnFn } from "./process.js";
import {
  LspSession,
  type LspClientSocket,
  type LspSessionLimits,
} from "./session.js";

export interface AttachLspOpts {
  projectId: string;
  language: string;
  userId: number;
  cfg: AppConfig;
  socket: LspClientSocket;
  /**
   * Trusted workspace directory (from `workspacePath`). Unused by the
   * sandbox spawn itself — the container already mounts it at `/workspace`.
   * Kept so tests and future local-spawn adapters have a real path.
   */
  workspaceDir: string;
  /** Test injection: skip Docker and spawn a local fake language server. */
  spawn?: LspSpawnFn;
  /** Test injection: skip `ensureProjectSandbox`. */
  containerId?: string;
}

function limitsFromConfig(cfg: AppConfig): LspSessionLimits {
  return {
    startupTimeoutMs: cfg.lspStartupTimeoutMs,
    idleTimeoutMs: cfg.lspIdleTimeoutMs,
    restartWindowMs: cfg.lspRestartWindowMs,
    maxRestarts: cfg.lspMaxRestarts,
    messageMaxBytes: cfg.lspMessageMaxBytes,
    maxPendingPerClient: 64,
  };
}

function keyOf(projectId: string, language: string): string {
  return `${projectId}:${language}`;
}

/**
 * Project-scoped language-server processes. Isolation is the sandbox
 * container; reuse is per (project, language), never across projects.
 */
export class LanguageServerManager {
  private readonly sessions = new Map<string, LspSession>();
  private spawnOverride: LspSpawnFn | null = null;
  private containerOverride: ((projectId: string) => string) | null = null;

  /** Test-only: replace Docker spawn with a local process factory. */
  setSpawnForTests(fn: LspSpawnFn | null): void {
    this.spawnOverride = fn;
  }

  /** Test-only: skip sandbox creation. */
  setContainerForTests(fn: ((projectId: string) => string) | null): void {
    this.containerOverride = fn;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  sessionFor(projectId: string, language: string): LspSession | undefined {
    return this.sessions.get(keyOf(projectId, language));
  }

  activeProcessCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.pid) n += 1;
    }
    return n;
  }

  async attach(opts: AttachLspOpts): Promise<LspSession | null> {
    const spec = getLspLanguage(opts.language);
    if (!spec) return null;

    const existing = this.sessions.get(keyOf(opts.projectId, spec.id));
    if (existing) {
      existing.addClient(opts.socket);
      return existing;
    }

    if (this.sessions.size >= opts.cfg.maxLspServers) {
      const victim = this.pickIdleVictim();
      if (victim) victim.dispose("evicted");
    }
    if (this.sessions.size >= opts.cfg.maxLspServers) {
      return null;
    }

    const perProject = this.sessionsForProject(opts.projectId).length;
    if (perProject >= opts.cfg.maxLspServersPerProject) {
      return null;
    }

    const containerId =
      opts.containerId ??
      this.containerOverride?.(opts.projectId) ??
      (await this.ensureContainer(opts));
    if (!containerId) return null;

    const spawn = opts.spawn ?? this.spawnOverride ?? spawnSandboxLsp;
    const session = new LspSession(
      opts.projectId,
      spec,
      containerId,
      {
        spawn,
        onDead: (s) => {
          const k = keyOf(s.projectId, s.language.id);
          if (this.sessions.get(k) === s) this.sessions.delete(k);
        },
      },
      limitsFromConfig(opts.cfg),
    );
    this.sessions.set(keyOf(opts.projectId, spec.id), session);
    session.addClient(opts.socket);
    session.start();
    return session;
  }

  disposeProject(projectId: string): void {
    for (const session of this.sessionsForProject(projectId)) {
      session.dispose("project_deleted");
    }
  }

  disposeAll(reason = "server_shutdown"): void {
    for (const session of [...this.sessions.values()]) {
      session.dispose(reason);
    }
    this.sessions.clear();
  }

  private sessionsForProject(projectId: string): LspSession[] {
    const out: LspSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) out.push(session);
    }
    return out;
  }

  private pickIdleVictim(): LspSession | null {
    let oldest: LspSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.clientCount !== 0) continue;
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = session;
      }
    }
    return oldest;
  }

  private async ensureContainer(opts: AttachLspOpts): Promise<string | null> {
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

export const languageServers = new LanguageServerManager();

/** Test helper: drop every session without going through production shutdown. */
export function resetLanguageServersForTests(): void {
  languageServers.disposeAll("test_reset");
  languageServers.setSpawnForTests(null);
  languageServers.setContainerForTests(null);
}

export type { LspLanguageSpec };
