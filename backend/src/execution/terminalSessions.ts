/**
 * M79 — TerminalSessionRegistry.
 *
 * A narrowly-scoped registry of live/detached PTY terminal sessions, keyed by
 * the authenticated `(userId, projectId, terminalId)` triple. It exists so a
 * dropped `/ws/terminal` socket detaches (rather than killing) its PTY for a
 * bounded grace window, letting a reconnecting client of the SAME user reattach
 * to the same shell and replay the output produced while it was gone.
 *
 * It is deliberately NOT a general process supervisor: no scheduling, no
 * multi-terminal orchestration, no cross-session routing. The `terminalId` is
 * an opaque client-generated value and is never a standalone lookup key — a
 * different user or project simply produces a different registry key.
 */

export const DEFAULT_TERMINAL_DETACH_GRACE_MS = 90_000;
export const TERMINAL_RING_MAX_BYTES = 256 * 1024;

const TRUNCATION_MARKER =
  "\r\n\x1b[2m[... earlier terminal output truncated ...]\x1b[0m\r\n";

export type TerminalEndedReason =
  | "grace_expired"
  | "process_exited"
  | "container_stopped"
  | "authorization_revoked";

/** The subset of a node-pty process the registry drives. */
export interface RegistryPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** The subset of a `ws` WebSocket the registry drives. */
export interface RegistrySocket {
  readyState: number;
  send(data: string): void;
  close(): void;
}

const WS_OPEN = 1;

interface Entry {
  userId: number;
  projectId: string;
  terminalId: string;
  pty: RegistryPty;
  containerId: string;
  ring: TerminalRingBuffer;
  /** Monotonic per-session output chunk counter. First chunk is seq 1. */
  seq: number;
  liveWs: RegistrySocket | null;
  state: "attached" | "detached" | "ended";
  detachedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  graceMs: number;
  secretsCleanup: (() => void | Promise<void>) | null;
  ptyExited: boolean;
  /** Bumped on every attach; guards a stale grace callback (RACE #1). */
  generation: number;
  /** Called exactly once when the session is reaped — releases the gate slot. */
  onEnd: () => void;
}

export interface CreateArgs {
  userId: number;
  projectId: string;
  terminalId: string;
  pty: RegistryPty;
  containerId: string;
  graceMs?: number;
  secretsCleanup?: (() => void | Promise<void>) | null;
  onEnd?: () => void;
}

export interface AttachResult {
  ok: boolean;
  /** Only present on failure. */
  reason?: TerminalEndedReason;
}

/**
 * Ordered chunk ring with a hard byte ceiling. Never persisted anywhere; the
 * sole purpose is short-lived reconnect replay.
 */
export class TerminalRingBuffer {
  private chunks: Array<{ seq: number; data: string }> = [];
  private bytes = 0;
  private evicted = false;
  private readonly max: number;

  constructor(max = TERMINAL_RING_MAX_BYTES) {
    this.max = max;
  }

  push(seq: number, data: string): void {
    this.chunks.push({ seq, data });
    this.bytes += Buffer.byteLength(data, "utf8");
    while (this.bytes > this.max && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(dropped.data, "utf8");
      this.evicted = true;
    }
  }

  get byteLength(): number {
    return this.bytes;
  }

  /**
   * Everything with `seq > lastSeq`, concatenated in order. `truncated` is true
   * when older data the client had not yet seen was already evicted.
   */
  since(lastSeq: number): { data: string; truncated: boolean } {
    const kept = this.chunks.filter((c) => c.seq > lastSeq);
    const oldest = this.chunks.length > 0 ? this.chunks[0].seq : Infinity;
    const truncated = this.evicted && oldest > lastSeq + 1;
    const body = kept.map((c) => c.data).join("");
    return {
      data: truncated ? TRUNCATION_MARKER + body : body,
      truncated,
    };
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.evicted = false;
  }
}

function keyOf(userId: number, projectId: string, terminalId: string): string {
  // `|` is collision-free here: userId is numeric, projectId is a UUID, and
  // terminalId is validated to /^[A-Za-z0-9_-]{1,128}$/ upstream.
  return `${userId}|${projectId}|${terminalId}`;
}

export class TerminalSessionRegistry {
  private sessions = new Map<string, Entry>();
  /** Recently-reaped keys → why, so a late reattach can report the real
   *  reason instead of a generic miss. Bounded, insertion-ordered. */
  private tombstones = new Map<string, TerminalEndedReason>();
  private static readonly TOMBSTONE_CAP = 64;

  private tombstone(key: string, reason: TerminalEndedReason): void {
    this.tombstones.delete(key);
    this.tombstones.set(key, reason);
    while (this.tombstones.size > TerminalSessionRegistry.TOMBSTONE_CAP) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  /** Create a fresh attached session. Throws if a live one already exists for
   *  this exact key (the caller must reattach, not re-create). */
  create(args: CreateArgs): void {
    const key = keyOf(args.userId, args.projectId, args.terminalId);
    const existing = this.sessions.get(key);
    if (existing && existing.state !== "ended") {
      throw new Error("terminal session already exists for this key");
    }
    const entry: Entry = {
      userId: args.userId,
      projectId: args.projectId,
      terminalId: args.terminalId,
      pty: args.pty,
      containerId: args.containerId,
      ring: new TerminalRingBuffer(),
      seq: 0,
      liveWs: null,
      state: "attached",
      detachedAt: null,
      graceTimer: null,
      graceMs: args.graceMs ?? DEFAULT_TERMINAL_DETACH_GRACE_MS,
      secretsCleanup: args.secretsCleanup ?? null,
      ptyExited: false,
      generation: 0,
      onEnd: args.onEnd ?? (() => {}),
    };
    this.sessions.set(key, entry);

    args.pty.onData((data) => this.pushOutput(key, data));
    args.pty.onExit(() => {
      const e = this.sessions.get(key);
      if (e) e.ptyExited = true;
      this.reap(args.userId, args.projectId, args.terminalId, "process_exited");
    });
  }

  /** Record one PTY output chunk: advance the seq, ring it, fan it to the
   *  live socket. The only caller is the `pty.onData` wiring in `create`. */
  private pushOutput(key: string, data: string): void {
    const entry = this.sessions.get(key);
    if (!entry || entry.state === "ended" || !data) return;
    entry.seq += 1;
    entry.ring.push(entry.seq, data);
    const ws = entry.liveWs;
    if (ws && ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify({ type: "data", seq: entry.seq, data }));
      } catch {
        /* ignore */
      }
    }
  }

  has(userId: number, projectId: string, terminalId: string): boolean {
    const e = this.sessions.get(keyOf(userId, projectId, terminalId));
    return !!e && e.state !== "ended";
  }

  /** If a session for this key existed and was reaped recently, the reason
   *  (from the bounded tombstone map); otherwise `null`. Lets `/ws/terminal`
   *  tell a reconnecting client its session is gone instead of silently
   *  spawning a fresh shell under the same UI. */
  reapedReason(
    userId: number,
    projectId: string,
    terminalId: string,
  ): TerminalEndedReason | null {
    return (
      this.tombstones.get(keyOf(userId, projectId, terminalId)) ?? null
    );
  }

  /**
   * Bind `ws` as the session's single live socket. Replays `seq > lastSeq` from
   * the ring FIRST (synchronously), then marks attached so live frames follow
   * without interleaving. Fails honestly if the PTY is gone.
   */
  attach(
    userId: number,
    projectId: string,
    terminalId: string,
    ws: RegistrySocket,
    lastSeq: number,
  ): AttachResult {
    const key = keyOf(userId, projectId, terminalId);
    const entry = this.sessions.get(key);
    if (!entry || entry.state === "ended") {
      const reason = this.tombstones.get(key);
      return reason ? { ok: false, reason } : { ok: false };
    }
    if (entry.ptyExited) {
      this.reap(userId, projectId, terminalId, "process_exited");
      return { ok: false, reason: "process_exited" };
    }

    // Single-writer invariant: a second valid attach displaces the first.
    if (entry.liveWs && entry.liveWs !== ws) {
      const stale = entry.liveWs;
      entry.liveWs = null;
      try {
        stale.close();
      } catch {
        /* ignore */
      }
    }

    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.detachedAt = null;
    entry.state = "attached";
    entry.generation += 1;

    const replay = entry.ring.since(lastSeq);
    if (replay.data.length > 0 && ws.readyState === WS_OPEN) {
      try {
        ws.send(
          JSON.stringify({ type: "data", seq: entry.seq, data: replay.data }),
        );
      } catch {
        /* ignore */
      }
    }
    entry.liveWs = ws;
    return { ok: true };
  }

  /** Unbind the live socket and arm the bounded grace timer. */
  detach(userId: number, projectId: string, terminalId: string): void {
    const key = keyOf(userId, projectId, terminalId);
    const entry = this.sessions.get(key);
    if (!entry || entry.state === "ended") return;

    entry.liveWs = null;
    entry.state = "detached";
    entry.detachedAt = Date.now();
    const gen = entry.generation;
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = setTimeout(() => {
      const e = this.sessions.get(key);
      // RACE #1: a reattach bumps `generation`; the old timer is a no-op.
      if (e && e.state === "detached" && e.generation === gen) {
        this.reap(userId, projectId, terminalId, "grace_expired");
      }
    }, entry.graceMs);
    (entry.graceTimer as { unref?: () => void }).unref?.();
  }

  writeInput(
    userId: number,
    projectId: string,
    terminalId: string,
    data: string,
  ): void {
    const entry = this.sessions.get(keyOf(userId, projectId, terminalId));
    if (!entry || entry.state === "ended") return;
    try {
      entry.pty.write(data);
    } catch {
      /* ignore */
    }
  }

  resize(
    userId: number,
    projectId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    const entry = this.sessions.get(keyOf(userId, projectId, terminalId));
    if (!entry || entry.state === "ended") return;
    try {
      entry.pty.resize(cols || 80, rows || 30);
    } catch {
      /* ignore */
    }
  }

  /** Kill the PTY, clean secrets, release the gate slot, drop the entry.
   *  Idempotent — a second call for the same key does nothing. */
  reap(
    userId: number,
    projectId: string,
    terminalId: string,
    reason: TerminalEndedReason,
  ): void {
    const key = keyOf(userId, projectId, terminalId);
    const entry = this.sessions.get(key);
    if (!entry || entry.state === "ended") return;

    entry.state = "ended";
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    const ws = entry.liveWs;
    entry.liveWs = null;
    if (ws && ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ended", reason }));
      } catch {
        /* ignore */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (!entry.ptyExited) {
      try {
        entry.pty.kill();
      } catch {
        /* ignore */
      }
    }
    if (entry.secretsCleanup) {
      try {
        void entry.secretsCleanup();
      } catch {
        /* ignore */
      }
    }
    entry.ring.clear();
    this.sessions.delete(key);
    this.tombstone(key, reason);
    try {
      entry.onEnd();
    } catch {
      /* ignore */
    }
  }

  reapProject(projectId: string): void {
    for (const entry of [...this.sessions.values()]) {
      if (entry.projectId === projectId) {
        this.reap(
          entry.userId,
          entry.projectId,
          entry.terminalId,
          "container_stopped",
        );
      }
    }
  }

  reapUser(userId: number): void {
    for (const entry of [...this.sessions.values()]) {
      if (entry.userId === userId) {
        this.reap(
          entry.userId,
          entry.projectId,
          entry.terminalId,
          "authorization_revoked",
        );
      }
    }
  }

  reapUserProject(userId: number, projectId: string): void {
    for (const entry of [...this.sessions.values()]) {
      if (entry.userId === userId && entry.projectId === projectId) {
        this.reap(
          entry.userId,
          entry.projectId,
          entry.terminalId,
          "authorization_revoked",
        );
      }
    }
  }

  /** Live + detached sessions for a user (excludes ended). */
  countForUser(userId: number): number {
    let n = 0;
    for (const entry of this.sessions.values()) {
      if (entry.userId === userId && entry.state !== "ended") n += 1;
    }
    return n;
  }

  /** Test/observability accessor — never exposes the PTY or containerId. */
  describe(
    userId: number,
    projectId: string,
    terminalId: string,
  ): { state: string; seq: number; ringBytes: number; attached: boolean } | null {
    const e = this.sessions.get(keyOf(userId, projectId, terminalId));
    if (!e) return null;
    return {
      state: e.state,
      seq: e.seq,
      ringBytes: e.ring.byteLength,
      attached: e.liveWs !== null,
    };
  }

  size(): number {
    return this.sessions.size;
  }

  disposeAll(): void {
    for (const entry of [...this.sessions.values()]) {
      this.reap(
        entry.userId,
        entry.projectId,
        entry.terminalId,
        "container_stopped",
      );
    }
  }
}

export const terminalSessions = new TerminalSessionRegistry();
