import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { projectDir } from "../projects/service.js";
import { assertInsideWorkspace, safeResolve } from "../files/service.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Reserved: y-protocols auth message type (received but not handled).
const _MESSAGE_AUTH = 2;
const MESSAGE_CUSTOM = 3;

// M6: broadcast coalescing + backpressure defaults. Conservative on
// purpose, not tuned to a specific measured ceiling — M5c found no
// DB-side reason to be aggressive here, and this milestone's own
// before/after load evidence (see backend/load-test/results/) is what
// actually justifies these numbers, not intuition. Both coalescing
// windows and both watermarks are per-room constructor overrides
// specifically so tests and load measurement can vary them without
// touching these module-level defaults.
export const DEFAULT_YJS_COALESCE_MS = 25;
export const DEFAULT_AWARENESS_COALESCE_MS = 50;
export const DEFAULT_HIGH_WATERMARK_BYTES = 1_000_000;
export const DEFAULT_LOW_WATERMARK_BYTES = 200_000;
const SLOW_CLIENT_RECHECK_MS = 500;

// M54: Collaborative Run Awareness. Ephemeral, in-memory only — no
// durable/SQLite state, no client->server path. A terminal run status
// lingers briefly so late/paused clients still observe the outcome, then
// is cleared. A stuck "running" entry (execution socket died without a
// terminal publish) is swept after a hard age cap.
const RUN_STATUS_LINGER_MS = 10_000;
const RUN_STATUS_MAX_AGE_MS = 30 * 60 * 1000;
const RUN_STATUS_SWEEP_MS = 60_000;

// M55: server-authoritative awareness identity + bounded ephemeral metadata.
// The collaboration `user` identity was previously client-asserted and
// rebroadcast verbatim, so a modified client could advertise another user's
// id/name/role. Every inbound MESSAGE_AWARENESS update is now rebuilt
// server-side: identity is forced to the authenticated WS session, only the
// connection's own awareness clientIDs may be written, and the remaining
// ephemeral fields are enum/-bounds-checked. Nothing here is persisted.
const AWARENESS_STATUS_VALUES = new Set(["online", "idle", "dnd"]);
const AWARENESS_ACTIVITY_VALUES = new Set([
  "viewing",
  "editing",
  "running",
  "terminal",
  "searching",
  "reviewing",
]);
const AWARENESS_MAX_ENTRIES_PER_FRAME = 64;
const AWARENESS_MAX_CLIENT_IDS_PER_CONNECTION = 8;
const AWARENESS_MAX_PATH_LEN = 512;
const AWARENESS_MAX_DETAIL_LEN = 200;
// Generous ceiling for a Monaco line/column — far beyond any real file, but
// bounded so a peer can't be fed absurd/NaN/Infinity coordinates.
const AWARENESS_MAX_COORD = 5_000_000;

// M56: Collaboration-Safe Destructive Operations.
//  - `flushBeforeDestructiveDispose()` persists a live room's latest
//    in-memory Y.Doc state to disk BEFORE a destructive workspace
//    replacement (full restore / replace-import) disposes it, closing the
//    silent data-loss window. Timeout-bounded, best-effort, no double flush.
//  - `activeFileDirty` is the single bounded awareness bit that lets a
//    destructive operation know another collaborator has UNSAVED local
//    buffer changes in an affected file (distinct from merely "editing").
//    Server-attributed, never persisted, no arbitrary path list.
//  - `emitExternalMutationNotice()` sends bounded, metadata-only notices to
//    non-initiating collaborators whose active file was mutated externally.
const FLUSH_BEFORE_DISPOSE_TIMEOUT_MS = 5000;
const EXTERNAL_MUTATION_NOTICE_DEDUP_MS = 1000;
const EXTERNAL_MUTATION_NOTICE_DEDUP_MAX_ENTRIES = 500;
const DESTRUCTIVE_MUTATION_TTL_MS = 60_000;
const DESTRUCTIVE_MUTATION_MAX_ENTRIES = 200;

/**
 * The closed set of workspace mutations that can produce an external-mutation
 * notice. Every value maps to an operation that actually exists in the
 * codebase today — no free-form types.
 */
export const MUTATION_TYPES = [
  "replace",
  "git_checkout",
  "workspace_restore",
  "workspace_import",
  "snapshot_restore",
  "upload",
] as const;
export type MutationType = (typeof MUTATION_TYPES)[number];

function isMutationType(v: unknown): v is MutationType {
  return (
    typeof v === "string" && (MUTATION_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Metadata-only frame delivered to an affected non-initiating collaborator.
 * NEVER carries file contents, diffs, selected text, commands, stdout/stderr,
 * environment, or secrets. Every field is server-authoritative.
 */
export interface ExternalMutationNotice {
  type: "external_mutation_notice";
  /** Workspace-relative path, or null for a whole-workspace replacement. */
  path: string | null;
  mutationType: MutationType;
  actor: { userId: number; username: string };
  timestamp: number;
  matchCount?: number;
}

/**
 * Safe, route-facing view of a collaborator's relationship to a file. Contains
 * no WebSocket, Y.Doc, or Y.Text reference and no file content. `dirty` is
 * `"unknown"` when the collaborator's client has not reported an
 * `activeFileDirty` bit — it must NEVER be rendered as "unsaved" in that case.
 */
export interface CollaboratorFileState {
  userId: number;
  username: string;
  role: "owner" | "editor" | "viewer";
  path: string;
  open: boolean;
  editing: boolean;
  dirty: boolean | "unknown";
}

interface DestructiveMutationRecord {
  mutationType: MutationType;
  actor: { userId: number; username: string };
  timestamp: number;
}

export type RunState = "running" | "success" | "failed" | "stopped";

export interface RunStatusEntry {
  executionId: string;
  userId: number;
  username: string;
  state: RunState;
  file: string | null;
  language: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

export interface CollaborationRoomOptions {
  yjsCoalesceMs?: number;
  awarenessCoalesceMs?: number;
  highWatermarkBytes?: number;
  lowWatermarkBytes?: number;
}

/** Rejects if the wrapped promise has not settled within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface CollaboratorClientState {
  userId: number;
  username: string;
  role: "owner" | "editor" | "viewer";
  activeFile?: string | null;
  /**
   * Real Yjs awareness clientIDs observed in awareness updates sent by this
   * connection. Populated lazily as the client broadcasts presence; used to
   * remove exactly this connection's awareness states on disconnect.
   */
  awarenessClientIds?: Set<number>;
}

export class CollaborationRoom {
  public readonly projectId: string;
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public readonly clients: Map<WebSocket, CollaboratorClientState> = new Map();

  private readonly cfg: AppConfig;
  private readonly db: Db;
  private readonly dirtyFiles: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxFlushTimer: NodeJS.Timeout | null = null;
  private lastFlushTime: number = Date.now();
  private idleDisposeTimer: NodeJS.Timeout | null = null;
  private readonly onDisposeCallback: (projectId: string) => void;

  // M6: coalescing + backpressure. See DEFAULT_* constants above for the
  // rationale; these are the per-room, possibly-overridden values actually
  // in effect.
  private readonly yjsCoalesceMs: number;
  private readonly awarenessCoalesceMs: number;
  private readonly highWatermarkBytes: number;
  private readonly lowWatermarkBytes: number;

  /** Yjs updates awaiting the next coalesce flush, in arrival order. Never
   *  grows unboundedly: it is fully drained on every flush, at most
   *  `yjsCoalesceMs` apart, regardless of client speed — this buffer holds
   *  pending *outbound* work, not per-client backlog (see slowClients). */
  private pendingYjsUpdates: Uint8Array[] = [];
  private pendingYjsOrigins: Set<unknown> = new Set();
  private yjsCoalesceTimer: NodeJS.Timeout | null = null;

  /** Awareness clientIDs that changed since the last flush. Re-encoded from
   *  LIVE awareness state at flush time (not a snapshot taken when queued),
   *  so "latest state wins" is automatic — the same trailing-edge-coalesce
   *  shape as the frontend's utils/throttleLatest.ts. */
  private pendingAwarenessClientIds: Set<number> = new Set();
  private pendingAwarenessOrigins: Set<unknown> = new Set();
  private awarenessCoalesceTimer: NodeJS.Timeout | null = null;

  /** Clients currently backpressured on Yjs updates: broadcasts are skipped
   *  entirely (never queued per-client — see the field doc above) until
   *  `bufferedAmount` drops back to the low watermark, at which point
   *  `sendCatchUp` sends one full-document update using the existing sync
   *  protocol's `messageYjsUpdate` framing. This is what makes skipping
   *  safe: nothing is ever permanently lost, only deferred. */
  private readonly slowClients: Set<WebSocket> = new Set();
  private slowClientRecheckTimer: NodeJS.Timeout | null = null;

  // M54: ephemeral run-status registry, keyed by executionId. Populated
  // exclusively by the real server-side execution lifecycle via
  // CollaborationManager.notifyRunStatus — never from a client message.
  private readonly runStatus = new Map<string, RunStatusEntry>();
  private readonly runStatusLingerTimers = new Map<string, NodeJS.Timeout>();
  private runStatusSweepTimer: NodeJS.Timeout | null = null;

  /** Set at the start of dispose(). awareness.destroy() below internally
   *  calls setLocalState(null), which fires this room's own
   *  awareness "update" listener — without this guard that would re-arm
   *  awarenessCoalesceTimer via queueAwarenessUpdate() *after* dispose()'s
   *  timer-clearing block already ran, leaking one timer per disposal. */
  private disposed = false;

  /** M56: in-flight `flushBeforeDestructiveDispose()` promise. Reused by a
   *  concurrent caller so a destructive replacement can never trigger two
   *  overlapping pre-dispose flushes of the same room. */
  private flushBeforeDisposePromise: Promise<{
    flushed: boolean;
    remainingDirty: string[];
  }> | null = null;

  /** Observability-only: count of physical ws.send() calls this room has
   *  actually issued for broadcasts (Yjs + awareness + catch-up combined),
   *  not counting the per-connection handshake sends in addClient() or the
   *  direct sync-protocol reply in handleMessage(). This is the metric
   *  M6's load evidence uses to demonstrate coalescing actually reduces
   *  physical message volume — added because no existing metric answers
   *  that question. */
  private broadcastSendCount = 0;

  constructor(
    projectId: string,
    cfg: AppConfig,
    db: Db,
    onDispose: (projectId: string) => void,
    options: CollaborationRoomOptions = {},
  ) {
    this.projectId = projectId;
    this.cfg = cfg;
    this.db = db;
    this.onDisposeCallback = onDispose;
    this.yjsCoalesceMs = options.yjsCoalesceMs ?? DEFAULT_YJS_COALESCE_MS;
    this.awarenessCoalesceMs =
      options.awarenessCoalesceMs ?? DEFAULT_AWARENESS_COALESCE_MS;
    this.highWatermarkBytes =
      options.highWatermarkBytes ?? DEFAULT_HIGH_WATERMARK_BYTES;
    this.lowWatermarkBytes =
      options.lowWatermarkBytes ?? DEFAULT_LOW_WATERMARK_BYTES;

    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Track document updates for debounced disk persistence, and queue the
    // outbound broadcast for coalescing rather than sending it immediately.
    // Persistence scheduling stays synchronous and unaffected by coalescing
    // — it only arms/resets a timer, no I/O happens here.
    this.doc.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== "external_mutation") {
        this.scheduleDebouncedPersistence();
      }
      this.queueYjsUpdate(update, origin);
    });

    // Per-file dirty tracking for genuine remote edits.
    //
    // The "update" listener above only arms the flush timers; it cannot tell
    // WHICH file changed. Incoming client edits arrive via
    // syncProtocol.readSyncMessage(), which mutates this.doc directly and
    // never routes through ensureFileLoaded()/markFileDirty(). Without the
    // hook below, dirtyFiles stays permanently empty in production, so
    // flushToDisk()'s per-file retry tracking and scheduleIdleDisposal()'s
    // "never dispose while content is unpersisted" guard never engage — a
    // failed write would be logged and the only copy of the content dropped.
    //
    // This uses transaction.changed rather than per-Y.Text .observe() or
    // transaction.changedParentTypes, because neither of those can see a file
    // the server never explicitly opened: when an incoming update references
    // an unknown key, Yjs materializes it as a bare AbstractType whose
    // _callObserver() is a no-op, so it never fires .observe() and never
    // lands in changedParentTypes. transaction.changed is populated by
    // Item.integrate() regardless of the type's concrete class, so it is the
    // only signal that cannot miss a file.
    this.doc.on("afterTransaction", (tr: Y.Transaction) => {
      // Content applied under these origins already matches disk, so it must
      // not be queued for a write-back. Every handleExternalFileMutation()
      // caller writes (or deletes) the file itself BEFORE notifying the room;
      // marking those dirty would issue a redundant write, and for the delete
      // case would resurrect the just-deleted file as an empty file on the
      // next flush. "initial_disk_load" seeds a Y.Text from the very file it
      // just read.
      if (
        tr.origin === "external_mutation" ||
        tr.origin === "initial_disk_load"
      ) {
        return;
      }
      if (tr.changed.size === 0) return;

      const shares = this.doc.share as Map<string, unknown>;
      for (const changedType of tr.changed.keys()) {
        // Map the changed shared type back to its top-level key (the file
        // path). Nested types match nothing here and are correctly ignored —
        // files are always top-level Y.Text instances.
        for (const [key, type] of shares.entries()) {
          if (type === changedType) {
            this.markFileDirty(key);
            break;
          }
        }
      }
    });

    // Track awareness changes and queue the broadcast for coalescing —
    // ephemeral, so it is fine (by design) for a burst to collapse into one
    // send of the latest state rather than one send per change.
    this.awareness.on(
      "update",
      ({ added, updated, removed }: any, origin: any) => {
        const changedClients = added.concat(updated, removed);
        this.queueAwarenessUpdate(changedClients, origin);
      },
    );
  }

  // --- M6: Yjs update coalescing ------------------------------------------

  private queueYjsUpdate(update: Uint8Array, origin: unknown): void {
    if (this.disposed) return;
    this.pendingYjsUpdates.push(update);
    this.pendingYjsOrigins.add(origin);
    if (!this.yjsCoalesceTimer) {
      this.yjsCoalesceTimer = setTimeout(() => {
        this.yjsCoalesceTimer = null;
        this.flushYjsUpdates();
      }, this.yjsCoalesceMs);
    }
  }

  private flushYjsUpdates(): void {
    if (this.pendingYjsUpdates.length === 0) return;

    // Multiple raw Yjs updates accumulated within the window are merged
    // into exactly one valid update via Y.mergeUpdates — this combines the
    // underlying CRDT operations losslessly (it is not a "keep the latest"
    // reduction; every operation from every merged update survives), it
    // just reduces how many physical WS frames are needed to deliver them.
    const merged =
      this.pendingYjsUpdates.length === 1
        ? this.pendingYjsUpdates[0]
        : Y.mergeUpdates(this.pendingYjsUpdates);
    // A single shared origin across the whole window (the common case: one
    // person typing) is excluded from the broadcast, exactly matching the
    // original per-update "don't echo my own edit back to me" behavior. If
    // the window mixed edits from multiple origins, no single client
    // already has 100% of the merged update, so it goes to everyone —
    // still correct either way since Y.applyUpdate is idempotent for any
    // operations a recipient already has.
    const soleOrigin =
      this.pendingYjsOrigins.size === 1
        ? this.pendingYjsOrigins.values().next().value
        : undefined;
    this.pendingYjsUpdates = [];
    this.pendingYjsOrigins = new Set();

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, merged);
    const message = encoding.toUint8Array(encoder);

    for (const [client] of this.clients.entries()) {
      if (client === soleOrigin) continue;
      if (client.readyState !== 1 /* OPEN */) continue;
      this.sendYjsBroadcast(client, message);
    }
  }

  // --- M6: awareness coalescing --------------------------------------------

  private queueAwarenessUpdate(clientIds: number[], origin: unknown): void {
    if (this.disposed) return;
    for (const id of clientIds) this.pendingAwarenessClientIds.add(id);
    this.pendingAwarenessOrigins.add(origin);
    if (!this.awarenessCoalesceTimer) {
      this.awarenessCoalesceTimer = setTimeout(() => {
        this.awarenessCoalesceTimer = null;
        this.flushAwareness();
      }, this.awarenessCoalesceMs);
    }
  }

  private flushAwareness(): void {
    if (this.pendingAwarenessClientIds.size === 0) return;
    const changedIds = Array.from(this.pendingAwarenessClientIds);
    const soleOrigin =
      this.pendingAwarenessOrigins.size === 1
        ? this.pendingAwarenessOrigins.values().next().value
        : undefined;
    this.pendingAwarenessClientIds = new Set();
    this.pendingAwarenessOrigins = new Set();

    // Re-encoded from the LIVE awareness table right now, not from a
    // snapshot taken when each individual change was queued — so the very
    // latest state for each changed clientID always wins, even if that
    // client changed state multiple times within the window.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedIds),
    );
    const message = encoding.toUint8Array(encoder);

    for (const [client] of this.clients.entries()) {
      if (client === soleOrigin) continue;
      if (client.readyState !== 1) continue;
      this.sendAwarenessBroadcast(client, message);
    }
  }

  // --- M6: backpressure -----------------------------------------------------

  /**
   * Yjs updates: a client already marked slow is skipped unconditionally
   * (recovery is handled separately by the recheck timer, not by retrying
   * here) until it drops back to the low watermark, at which point it gets
   * a full-document catch-up instead of the merged delta it missed. This is
   * the one path that must never silently lose data, so unlike awareness it
   * needs the persistent slowClients tracking + guaranteed recheck below.
   */
  private sendYjsBroadcast(client: WebSocket, message: Uint8Array): void {
    if (this.slowClients.has(client)) return;
    if (client.bufferedAmount > this.highWatermarkBytes) {
      this.markSlow(client);
      return;
    }
    try {
      client.send(message);
      this.broadcastSendCount++;
    } catch {}
  }

  /**
   * Awareness: stops feeding a backpressured client FIRST — at half the
   * Yjs high watermark, not the full one — since presence is ephemeral and
   * safe to simply skip. No persistent tracking is needed: the state is
   * re-encoded from live truth on every flush (see flushAwareness), so the
   * very next successful send (whenever the buffer drains, or via
   * sendCatchUp if the client also crosses into full Yjs backpressure)
   * always carries the current truth regardless of what was skipped.
   */
  private sendAwarenessBroadcast(client: WebSocket, message: Uint8Array): void {
    if (this.slowClients.has(client)) return;
    if (client.bufferedAmount > this.highWatermarkBytes / 2) return;
    try {
      client.send(message);
      this.broadcastSendCount++;
    } catch {}
  }

  private markSlow(client: WebSocket): void {
    if (this.slowClients.has(client)) return;
    this.slowClients.add(client);
    if (!this.slowClientRecheckTimer) {
      this.slowClientRecheckTimer = setInterval(() => {
        this.recheckSlowClients();
      }, SLOW_CLIENT_RECHECK_MS);
      this.slowClientRecheckTimer.unref?.();
    }
  }

  /**
   * Polls backpressured clients' bufferedAmount independently of ordinary
   * broadcast activity — necessary because a slow client is skipped
   * unconditionally by sendYjsBroadcast, so nothing else would ever notice
   * it recovering in a quiet room. Self-cancels once no client is slow.
   */
  private recheckSlowClients(): void {
    if (this.slowClients.size === 0) {
      if (this.slowClientRecheckTimer) {
        clearInterval(this.slowClientRecheckTimer);
        this.slowClientRecheckTimer = null;
      }
      return;
    }
    for (const client of Array.from(this.slowClients)) {
      if (client.readyState !== 1) {
        // Gone. removeClient() handles this connection's room membership
        // separately; there is nothing left here to recover.
        this.slowClients.delete(client);
        continue;
      }
      if (client.bufferedAmount <= this.lowWatermarkBytes) {
        this.slowClients.delete(client);
        this.sendCatchUp(client);
      }
    }
    if (this.slowClients.size === 0 && this.slowClientRecheckTimer) {
      clearInterval(this.slowClientRecheckTimer);
      this.slowClientRecheckTimer = null;
    }
  }

  /**
   * Recovery path for a client that was skipped one or more Yjs broadcasts
   * while backpressured. Deliberately uses only the existing sync protocol
   * rather than inventing a new message: a full-document update is just a
   * regular messageYjsUpdate whose payload happens to be the whole document
   * (Y.encodeStateAsUpdate with no state vector) instead of an incremental
   * delta. Y.applyUpdate is idempotent for anything the client already has,
   * so this is always safe, and it needs no per-client tracking of what was
   * actually missed — the alternative (a precise delta) would require the
   * client to first resend its own state vector, an extra round trip this
   * avoids entirely.
   */
  private sendCatchUp(client: WebSocket): void {
    try {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(this.doc));
      client.send(encoding.toUint8Array(encoder));
      this.broadcastSendCount++;
    } catch {}
    try {
      const states = this.awareness.getStates();
      if (states.size > 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            Array.from(states.keys()),
          ),
        );
        client.send(encoding.toUint8Array(encoder));
        this.broadcastSendCount++;
      }
    } catch {}
  }

  /** Observability-only gauge: physical broadcast sends issued by this room
   *  so far (see the field's doc comment above for exactly what counts). */
  public getBroadcastSendCount(): number {
    return this.broadcastSendCount;
  }

  // --- M54: collaborative run awareness -----------------------------------

  /**
   * Records and broadcasts a run-status transition. The only caller is
   * CollaborationManager.notifyRunStatus, driven by the authenticated
   * execution WebSocket lifecycle in ws/execution.ts. Nothing a client
   * sends can reach here.
   */
  public handleRunStatus(input: RunStatusEntry): void {
    if (this.disposed) return;

    this.runStatus.set(input.executionId, input);
    this.broadcastRunStatus({ type: "run_status", ...input });

    const existingLinger = this.runStatusLingerTimers.get(input.executionId);
    if (existingLinger) {
      clearTimeout(existingLinger);
      this.runStatusLingerTimers.delete(input.executionId);
    }

    if (input.state === "running") {
      this.ensureRunStatusSweep();
      return;
    }

    // Terminal state: keep it visible briefly, then clear.
    const timer = setTimeout(() => {
      this.runStatusLingerTimers.delete(input.executionId);
      this.runStatus.delete(input.executionId);
      this.broadcastRunStatus({
        type: "run_status",
        executionId: input.executionId,
        userId: input.userId,
        state: "cleared",
      });
    }, RUN_STATUS_LINGER_MS);
    timer.unref?.();
    this.runStatusLingerTimers.set(input.executionId, timer);
  }

  private broadcastRunStatus(obj: unknown): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_CUSTOM);
    encoding.writeVarString(enc, JSON.stringify(obj));
    const frame = encoding.toUint8Array(enc);
    for (const [client] of this.clients.entries()) {
      if (client.readyState !== 1 /* OPEN */) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  private ensureRunStatusSweep(): void {
    if (this.runStatusSweepTimer) return;
    this.runStatusSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of Array.from(this.runStatus.entries())) {
        if (
          entry.state === "running" &&
          now - entry.startedAt > RUN_STATUS_MAX_AGE_MS
        ) {
          this.runStatus.delete(id);
          const linger = this.runStatusLingerTimers.get(id);
          if (linger) {
            clearTimeout(linger);
            this.runStatusLingerTimers.delete(id);
          }
          this.broadcastRunStatus({
            type: "run_status",
            executionId: id,
            userId: entry.userId,
            state: "cleared",
          });
        }
      }
      const stillRunning = Array.from(this.runStatus.values()).some(
        (e) => e.state === "running",
      );
      if (!stillRunning && this.runStatusSweepTimer) {
        clearInterval(this.runStatusSweepTimer);
        this.runStatusSweepTimer = null;
      }
    }, RUN_STATUS_SWEEP_MS);
    this.runStatusSweepTimer.unref?.();
  }

  /**
   * Initializes a file's collaborative Y.Text from the workspace filesystem if not already loaded.
   *
   * `filePath` originates from a client-controlled `file_open` message, so it
   * must clear the same boundary the REST file routes enforce (safeResolve +
   * assertInsideWorkspace) BEFORE it is used for a read or handed to
   * doc.getText(). Without it, a crafted key made the server process read an
   * arbitrary host file and broadcast its contents to every client in the
   * room. The realpath half is required, not just the lexical one: a symlink
   * planted inside the attacker's own bind-mounted workspace escapes a
   * traversal-string check (same attack already blocked in flushToDisk()).
   *
   * Validation runs before doc.getText() because Y.Doc.get() materializes the
   * key in doc.share as a side effect; a rejected path must never be
   * registered there, where flushToDisk()'s "no dirty files" fallback would
   * later pick it up and it would linger for the room's lifetime.
   *
   * The sole caller invokes this as a floating promise, so neither a rejected
   * path nor a missing file may throw: both resolve to an empty Y.Text.
   */
  public async ensureFileLoaded(filePath: string): Promise<Y.Text> {
    const baseDir = projectDir(this.cfg, this.projectId);
    let fullPath: string;
    try {
      fullPath = safeResolve(baseDir, filePath);
      await assertInsideWorkspace(baseDir, fullPath);
    } catch (err) {
      console.warn(
        `[CollabRoom:${this.projectId}] Refusing to load ${filePath}: path escapes the workspace`,
        err,
      );
      // Detached instance: never registered in doc.share, so it is never
      // broadcast, never flushed, and holds no room state.
      return new Y.Text();
    }

    const yText = this.doc.getText(filePath);
    if (yText.length === 0) {
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        // Only insert if Y.Text is still empty
        if (yText.length === 0) {
          this.doc.transact(() => {
            yText.insert(0, content);
          }, "initial_disk_load");
        }
      } catch {
        // File might be newly created or not exist yet
      }
    }
    return yText;
  }

  /**
   * External Mutation Safety: updates Y.Text when workspace file is modified externally
   * (e.g. via REST file save, snapshot restore, starter templates).
   *
   * `doc.getText(filePath)` materializes `filePath` as a key in `doc.share` as
   * a side effect, even for a path this room never tracked. The /move and
   * /delete routes call this with `newContent: ""` for every affected path to
   * clear any stale content — including paths the room was never actually
   * editing. Without the guard below, that "nothing to clear" call would
   * itself create a dangling empty Y.Text, which flushToDisk()'s "no dirty
   * files" fallback would then write back to disk, resurrecting the just
   * deleted/renamed-away file. A path that isn't already tracked and has
   * nothing (empty content) to apply needs no Y.Doc access at all.
   */
  public async handleExternalFileMutation(
    filePath: string,
    newContent: string,
  ): Promise<void> {
    if (newContent === "" && !this.doc.share.has(filePath)) {
      return;
    }

    const yText = this.doc.getText(filePath);
    const currentContent = yText.toString();

    if (currentContent !== newContent) {
      this.doc.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, newContent);
      }, "external_mutation");
    }

    this.dirtyFiles.delete(filePath);
  }

  /**
   * Adds an authenticated collaborator to the room and sends initial state vectors.
   */
  public async addClient(
    ws: WebSocket,
    clientState: CollaboratorClientState,
  ): Promise<void> {
    if (this.idleDisposeTimer) {
      clearTimeout(this.idleDisposeTimer);
      this.idleDisposeTimer = null;
    }

    this.clients.set(ws, clientState);

    // NOTE: per-client presence arrives via each client's own awareness updates
    // (MESSAGE_AWARENESS), keyed by that client's real Yjs clientID. The server
    // is not a user in the room, so it must not write its own local awareness state.

    // 1. Send Sync Step 1 (Server state vector)
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    ws.send(encoding.toUint8Array(syncEncoder));

    // 2. Send current room Awareness states
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(awarenessStates.keys()),
        ),
      );
      ws.send(encoding.toUint8Array(awarenessEncoder));
    }

    // 3. M54: snapshot of any active/lingering run statuses so a client that
    // joins mid-run sees it immediately without waiting for a fresh event.
    if (this.runStatus.size > 0) {
      for (const entry of this.runStatus.values()) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_CUSTOM);
        encoding.writeVarString(
          enc,
          JSON.stringify({ type: "run_status", ...entry }),
        );
        try {
          ws.send(encoding.toUint8Array(enc));
        } catch {}
      }
    }

    // 4. M56: if this project's workspace was recently replaced wholesale
    // (full restore / replace-import) the old room was disposed and every
    // collaborator was force-disconnected. A non-actor reconnecting within
    // the TTL window gets a one-off notice explaining why their session
    // dropped and their content changed.
    const destructive = collaborationManager.getRecentDestructiveMutation(
      this.projectId,
    );
    if (destructive && destructive.actor.userId !== clientState.userId) {
      this.sendDestructiveMutationNotice(destructive);
    }
  }

  /**
   * Processes incoming binary message from a connected client.
   */
  public handleMessage(ws: WebSocket, message: Uint8Array): void {
    const clientState = this.clients.get(ws);
    if (!clientState) return;

    try {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          const syncType = decoding.peekVarUint(decoder);

          // Viewer Role Protection: Reject edit updates from read-only viewers
          if (
            clientState.role === "viewer" &&
            syncType === syncProtocol.messageYjsUpdate
          ) {
            console.warn(
              `[CollabRoom:${this.projectId}] Blocked edit attempt from viewer ${clientState.username}`,
            );
            return;
          }

          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);

          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }
          break;
        }

        case MESSAGE_AWARENESS: {
          const rawUpdate = decoding.readVarUint8Array(decoder);
          // M55: rebuild the update so the identity encoded in every state is
          // this connection's authenticated session, only this connection's
          // own awareness clientIDs are written (a peer's entry can't be
          // hijacked or griefed), and the ephemeral fields are bounded. The
          // clientID attribution needed for precise disconnect cleanup
          // happens inside this same pass.
          const sanitized = this.sanitizeIncomingAwarenessUpdate(
            rawUpdate,
            ws,
            clientState,
          );
          if (sanitized) {
            awarenessProtocol.applyAwarenessUpdate(
              this.awareness,
              sanitized,
              ws,
            );
          }
          break;
        }

        case MESSAGE_CUSTOM: {
          // Custom JSON commands (e.g. file_open notification)
          const jsonStr = decoding.readVarString(decoder);
          try {
            const parsed = JSON.parse(jsonStr);
            if (
              parsed.type === "file_open" &&
              typeof parsed.path === "string"
            ) {
              const openedPath = parsed.path;
              clientState.activeFile = openedPath;
              // M52: the client no longer seeds its empty Y.Text from the
              // Monaco model on first bind (that raced this server-side
              // disk load and duplicated the file's content to "XX"). It
              // now waits for this explicit readiness signal before
              // constructing the y-monaco binding, so the server's
              // disk-loaded content is authoritative. Kept as a floating
              // promise chain — handleMessage stays synchronous and never
              // throws. ensureFileLoaded never rejects (a path-escape
              // resolves to a detached empty Y.Text), so always signalling
              // after it settles successfully is correct: an empty file is
              // legitimate and the client must not hang waiting.
              this.ensureFileLoaded(openedPath)
                .then(() => {
                  if (this.disposed) return;
                  if (ws.readyState !== 1) return;
                  if (!this.clients.has(ws)) return;
                  const encoder = encoding.createEncoder();
                  encoding.writeVarUint(encoder, MESSAGE_CUSTOM);
                  encoding.writeVarString(
                    encoder,
                    JSON.stringify({
                      type: "file_ready",
                      path: openedPath,
                    }),
                  );
                  try {
                    ws.send(encoding.toUint8Array(encoder));
                  } catch {}
                })
                .catch(() => {});
            }
          } catch {}
          break;
        }
      }
    } catch (err) {
      console.error(
        `[CollabRoom:${this.projectId}] Error handling message:`,
        err,
      );
    }
  }

  /**
   * Handles client disconnection.
   */
  public removeClient(ws: WebSocket): void {
    // M41: dispose() force-closes every client with ws.close(1001, ...),
    // but the 'close' event fires asynchronously — after dispose() has
    // already cleared this.clients, destroyed doc/awareness, and removed
    // this room from the manager's map. The ws/index.ts connection handler
    // closes over this SAME room instance and unconditionally calls
    // removeClient() on that event, with no way to know the room is already
    // gone. Without this guard, that call would find clients.size === 0
    // (dispose() already cleared it) and re-arm a fresh scheduleIdleDisposal()
    // timer on an already-destroyed room — see dispose()'s and
    // scheduleIdleDisposal()'s own guards for the rest of this defense.
    if (this.disposed) return;

    const clientState = this.clients.get(ws);
    this.clients.delete(ws);

    // A disconnected socket has nothing left to recover into — drop it from
    // backpressure tracking immediately rather than waiting for the next
    // recheck pass to notice readyState !== 1.
    this.slowClients.delete(ws);

    // Remove exactly the awareness states this connection actually published.
    // If it never sent an awareness update, there is nothing to remove.
    const ownedIds = clientState?.awarenessClientIds;
    if (ownedIds && ownedIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(ownedIds),
        null,
      );
      // Drop the attribution so a repeated removeClient() is a no-op.
      ownedIds.clear();
    }

    // If room is now empty, schedule a grace period before disposing
    if (this.clients.size === 0) {
      this.scheduleIdleDisposal();
    }
  }

  // --- M55: server-authoritative awareness identity ----------------------

  /**
   * Rebuilds a raw client MESSAGE_AWARENESS update into a trusted one:
   *
   *  - **Identity is forced** to `clientState` (the authenticated WS
   *    session). Whatever `user.id` / `user.name` / `user.role` the client
   *    encoded is discarded — a modified browser can never advertise another
   *    user. Only a syntactically-safe `user.color` is carried through.
   *  - **clientID ownership is enforced.** A connection may only write
   *    awareness entries for clientIDs it already owns or can newly claim
   *    (nobody else holds them, under a per-connection cap). An entry for a
   *    peer's clientID — the vector for overwriting/greifing someone else's
   *    presence with a high clock — is dropped. This is also where the
   *    attribution used for precise disconnect cleanup is recorded.
   *  - **Ephemeral fields are bounded**: status/activity enums, a
   *    workspace-relative bounded `activeFile`, finite in-range cursor /
   *    selection coordinates, finite `lastActive`. Unknown top-level fields
   *    are dropped entirely, so a rogue field can never smuggle content.
   *
   * Returns the re-encoded update, or `null` when nothing survives (the
   * caller then skips applyAwarenessUpdate). Never throws.
   */
  private sanitizeIncomingAwarenessUpdate(
    rawUpdate: Uint8Array,
    ws: WebSocket,
    clientState: CollaboratorClientState,
  ): Uint8Array | null {
    let decoder: decoding.Decoder;
    let count: number;
    try {
      decoder = decoding.createDecoder(rawUpdate);
      count = decoding.readVarUint(decoder);
    } catch {
      return null;
    }
    if (!Number.isInteger(count) || count < 0) return null;
    if (count > AWARENESS_MAX_ENTRIES_PER_FRAME) return null;

    const kept: Array<{ clientId: number; clock: number; state: unknown }> = [];

    for (let i = 0; i < count; i++) {
      let clientId: number;
      let clock: number;
      let rawState: string;
      try {
        clientId = decoding.readVarUint(decoder);
        clock = decoding.readVarUint(decoder);
        rawState = decoding.readVarString(decoder);
      } catch {
        // Truncated frame — keep whatever fully-decoded entries we have.
        break;
      }

      // The room's own doc.clientID is an internal Yjs detail; never a client.
      if (clientId === this.doc.clientID) continue;
      // A peer's awareness entry is off-limits to this connection.
      if (this.awarenessClientIdOwnedByOther(clientId, ws)) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawState);
      } catch {
        continue;
      }

      const owned = clientState.awarenessClientIds;

      if (parsed === null) {
        // A client may retire only a clientID it actually owns.
        if (owned?.has(clientId)) {
          kept.push({ clientId, clock, state: null });
        }
        continue;
      }
      if (typeof parsed !== "object") continue;

      // Claim the clientID for this connection (bounded).
      if (!owned) {
        clientState.awarenessClientIds = new Set<number>([clientId]);
      } else if (!owned.has(clientId)) {
        if (owned.size >= AWARENESS_MAX_CLIENT_IDS_PER_CONNECTION) continue;
        owned.add(clientId);
      }

      kept.push({
        clientId,
        clock,
        state: this.buildAuthoritativeAwarenessState(
          parsed as Record<string, unknown>,
          clientState,
        ),
      });
    }

    if (kept.length === 0) return null;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, kept.length);
    for (const entry of kept) {
      encoding.writeVarUint(encoder, entry.clientId);
      encoding.writeVarUint(encoder, entry.clock);
      encoding.writeVarString(encoder, JSON.stringify(entry.state));
    }
    return encoding.toUint8Array(encoder);
  }

  /**
   * True when `clientId` is already attributed to a DIFFERENT live
   * connection in this room — that peer's presence must not be writable by
   * `ws` (identity spoof / high-clock overwrite grief).
   */
  private awarenessClientIdOwnedByOther(
    clientId: number,
    ws: WebSocket,
  ): boolean {
    for (const [otherWs, otherState] of this.clients.entries()) {
      if (otherWs !== ws && otherState.awarenessClientIds?.has(clientId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Builds the trusted awareness state for one entry: server-authoritative
   * identity + an allowlist of bounded ephemeral fields. `incoming` is the
   * untrusted client-decoded object.
   */
  private buildAuthoritativeAwarenessState(
    incoming: Record<string, unknown>,
    clientState: CollaboratorClientState,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    // Identity — ALWAYS the authenticated session, never the client's claim.
    const user: Record<string, unknown> = {
      id: clientState.userId,
      name: clientState.username,
      role: clientState.role,
    };
    const incomingUser = incoming.user;
    if (incomingUser && typeof incomingUser === "object") {
      const color = (incomingUser as Record<string, unknown>).color;
      if (typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color)) {
        user.color = color;
      }
    }
    out.user = user;

    if (
      typeof incoming.status === "string" &&
      AWARENESS_STATUS_VALUES.has(incoming.status)
    ) {
      out.status = incoming.status;
    }

    const activity = incoming.activity;
    if (
      activity &&
      typeof activity === "object" &&
      typeof (activity as Record<string, unknown>).type === "string" &&
      AWARENESS_ACTIVITY_VALUES.has(
        (activity as Record<string, unknown>).type as string,
      )
    ) {
      const a = activity as Record<string, unknown>;
      const cleaned: Record<string, unknown> = { type: a.type };
      if (a.detail === null) {
        cleaned.detail = null;
      } else if (
        typeof a.detail === "string" &&
        a.detail.length <= AWARENESS_MAX_DETAIL_LEN
      ) {
        cleaned.detail = a.detail;
      }
      if (typeof a.timestamp === "number" && Number.isFinite(a.timestamp)) {
        cleaned.timestamp = a.timestamp;
      }
      out.activity = cleaned;
    }

    const activeFile = this.sanitizeAwarenessFilePath(incoming.activeFile);
    if (activeFile !== undefined) out.activeFile = activeFile;

    const cursor = incoming.cursor;
    if (cursor === null) {
      out.cursor = null;
    } else if (cursor && typeof cursor === "object") {
      const c = cursor as Record<string, unknown>;
      if (this.isAwarenessCoord(c.line) && this.isAwarenessCoord(c.column)) {
        out.cursor = { line: c.line, column: c.column };
      }
    }

    const selection = incoming.selection;
    if (selection === null) {
      out.selection = null;
    } else if (selection && typeof selection === "object") {
      const s = selection as Record<string, unknown>;
      if (
        this.isAwarenessCoord(s.startLine) &&
        this.isAwarenessCoord(s.startColumn) &&
        this.isAwarenessCoord(s.endLine) &&
        this.isAwarenessCoord(s.endColumn)
      ) {
        out.selection = {
          startLine: s.startLine,
          startColumn: s.startColumn,
          endLine: s.endLine,
          endColumn: s.endColumn,
        };
      }
    }

    if (
      typeof incoming.lastActive === "number" &&
      Number.isFinite(incoming.lastActive)
    ) {
      out.lastActive = incoming.lastActive;
    }

    // M56: the single bounded "my active file has unsaved local edits" bit.
    // A client may only report its OWN dirty state for its OWN active file.
    // Any `dirtyPaths`-style list or other extra key is structurally dropped
    // here because `out` is rebuilt from scratch and never spreads `incoming`.
    if (typeof incoming.activeFileDirty === "boolean") {
      out.activeFileDirty = incoming.activeFileDirty;
    }

    return out;
  }

  private isAwarenessCoord(n: unknown): n is number {
    return (
      typeof n === "number" &&
      Number.isFinite(n) &&
      n >= 0 &&
      n <= AWARENESS_MAX_COORD
    );
  }

  /**
   * `activeFile` is broadcast to every collaborator, so it must look like a
   * bounded workspace-relative path — never absolute, never traversal, never
   * a control-char / NUL carrier. This is metadata only: NO filesystem
   * access happens here (that stays in ensureFileLoaded, with its own
   * realpath guard). Returns a string to keep, `null` for an explicit
   * clear, or `undefined` to drop the field.
   */
  private sanitizeAwarenessFilePath(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    if (value.length === 0 || value.length > AWARENESS_MAX_PATH_LEN) {
      return undefined;
    }
    // Reject C0 control characters (incl. NUL) and DEL.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return undefined;
    }
    const norm = value.replace(/\\/g, "/");
    if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return undefined;
    if (norm.split("/").some((seg) => seg === "..")) return undefined;
    return value;
  }

  /**
   * Disconnects a specific user immediately upon role revocation.
   */
  public disconnectUser(userId: number): void {
    for (const [ws, state] of this.clients.entries()) {
      if (state.userId === userId) {
        try {
          ws.close(4403, "Collaboration access revoked");
        } catch {}
        this.removeClient(ws);
      }
    }
  }

  /**
   * Applies a role change to a currently-connected user's live session.
   * `clientState.role` is otherwise only captured once, at connect time —
   * without this, a downgraded editor keeps write access (bypassing the
   * viewer read-only enforcement in handleMessage) until they reconnect.
   */
  public updateUserRole(
    userId: number,
    role: "owner" | "editor" | "viewer",
  ): void {
    for (const state of this.clients.values()) {
      if (state.userId === userId) {
        state.role = role;
      }
    }
  }

  /**
   * Marks a file as dirty and triggers debounced persistence to workspace filesystem.
   */
  public markFileDirty(filePath: string): void {
    if (!this.isPersistablePath(filePath)) return;
    this.dirtyFiles.add(filePath);
    this.scheduleDebouncedPersistence();
  }

  /**
   * Yjs shared-type keys are client-controlled: a client can bring any key
   * into existence just by editing it, and flushToDisk() joins that key onto
   * the project directory. Now that those keys reach dirtyFiles, validate
   * them through the same lexical guard the REST file routes use, so a
   * crafted key (e.g. "../../../etc/passwd") can never be queued for a write
   * outside the workspace.
   *
   * This is the cheap, synchronous half of the check only (it must stay
   * synchronous: the sole caller runs inside a synchronous Yjs
   * "afterTransaction" handler). The realpath/symlink half is enforced in
   * flushToDisk(), immediately before the write.
   */
  private isPersistablePath(filePath: string): boolean {
    try {
      safeResolve(projectDir(this.cfg, this.projectId), filePath);
      return true;
    } catch {
      console.warn(
        `[CollabRoom:${this.projectId}] Ignoring unsafe collaborative file key: ${filePath}`,
      );
      return false;
    }
  }

  private scheduleDebouncedPersistence(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Schedule 2s debounce
    this.debounceTimer = setTimeout(() => {
      this.flushToDisk();
    }, 2000);

    // Schedule max 10s delay if not already active
    if (!this.maxFlushTimer) {
      this.maxFlushTimer = setTimeout(() => {
        this.flushToDisk();
      }, 10000);
    }
  }

  /**
   * Materializes dirty Y.Text contents to the workspace filesystem.
   */
  public async flushToDisk(): Promise<void> {
    // M41: a disposed room's doc/awareness are already destroyed, and any
    // content this.doc.getText(...) still returns is a frozen snapshot from
    // the moment of destruction — necessarily pre-disposal, since dispose()
    // is what made it stale in the first place (import/restore/delete all
    // replace on-disk content as part of the same operation that disposes
    // the room). Writing that snapshot back would silently clobber whatever
    // legitimately fresh content was written since. This is the final,
    // authoritative guard: even if some other path reaches flushToDisk() on
    // a disposed room in the future, it must still refuse to write.
    if (this.disposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxFlushTimer) {
      clearTimeout(this.maxFlushTimer);
      this.maxFlushTimer = null;
    }

    const baseDir = projectDir(this.cfg, this.projectId);
    const filesToFlush = Array.from(this.dirtyFiles);

    // If dirtyFiles is empty, flush all active non-empty text keys in doc.
    // The length check is load-bearing, not cosmetic: an empty Y.Text can be
    // a dangling key materialized as a side effect (e.g. a rejected/never-
    // tracked path touched by handleExternalFileMutation's own doc.getText()
    // call) rather than real content — writing those back to disk would
    // resurrect a deleted or renamed-away file as an empty ghost file.
    if (filesToFlush.length === 0) {
      for (const [key, type] of (
        this.doc.share as Map<string, any>
      ).entries()) {
        if (type instanceof Y.Text && type.length > 0) {
          filesToFlush.push(key);
        }
      }
    }

    for (const filePath of filesToFlush) {
      // Realpath boundary enforcement, mirroring the REST file routes
      // (safeResolve + assertInsideWorkspace). markFileDirty()'s lexical
      // check cannot see symlinks, and a user with terminal/docker-exec
      // access to their own sandbox can plant one inside their own
      // bind-mounted workspace pointing at a sibling project or anywhere on
      // the host. Since this loop is the only place collaborative content
      // reaches the filesystem — and it also flushes doc keys that never
      // passed through markFileDirty() at all (the "dirtyFiles is empty"
      // fallback above) — it is the single choke point that must resolve
      // symlinks before writing with the server's privileges.
      let fullPath: string;
      try {
        fullPath = safeResolve(baseDir, filePath);
        await assertInsideWorkspace(baseDir, fullPath);
      } catch (err) {
        // Unlike a transient write failure, this can never succeed later, so
        // drop it permanently instead of leaving it dirty: an un-writable
        // path retained here would block idle disposal forever via the
        // scheduleIdleDisposal() retry/backoff loop.
        this.dirtyFiles.delete(filePath);
        console.warn(
          `[CollabRoom:${this.projectId}] Refusing to persist ${filePath}: path escapes the workspace`,
          err,
        );
        continue;
      }

      try {
        const yText = this.doc.getText(filePath);
        const content = yText.toString();
        await fs.writeFile(fullPath, content, "utf-8");
        // Only mark clean once the write actually landed. Clearing
        // unconditionally would falsely mark a failed write as persisted,
        // and nothing would ever retry it.
        this.dirtyFiles.delete(filePath);
      } catch (err) {
        console.error(
          `[CollabRoom:${this.projectId}] Failed to persist ${filePath}:`,
          err,
        );
      }
    }

    this.lastFlushTime = Date.now();
  }

  /**
   * M56: persist the room's latest in-memory collaborative state to disk
   * immediately before a DESTRUCTIVE workspace replacement (full restore /
   * replace-import) disposes it. This is the fix for the confirmed silent
   * data-loss window: today those paths call `dispose()` (which destroys the
   * Y.Doc) with dirty edits still only in memory inside the debounce window.
   *
   * Contract:
   *  - Best-effort and TIMEOUT-BOUNDED (`timeoutMs`, default 5s) — a wedged
   *    disk write must never let a restore/import hang indefinitely.
   *  - Idempotent under concurrency: a second caller awaits the same
   *    in-flight flush, never a second overlapping one.
   *  - `flushed: true`  => every dirty file was written; destruction is safe.
   *  - `flushed: false` => some content could NOT be persisted within the
   *    bound (`remainingDirty` lists it). The caller MUST NOT silently
   *    proceed with the destructive operation — that would recreate exactly
   *    the data-loss class this method exists to eliminate.
   *
   * Called ONLY from destructive workspace-replacement paths, BEFORE
   * `dispose()`, while the room is still alive (so `flushToDisk()`'s
   * `disposed` guard does not short-circuit it). It does NOT relax that
   * guard and it is NOT wired into `dispose()` itself — idle/reconnect/
   * rollback disposal keep their existing semantics untouched.
   */
  public flushBeforeDestructiveDispose(opts?: {
    timeoutMs?: number;
  }): Promise<{ flushed: boolean; remainingDirty: string[] }> {
    if (this.disposed) {
      return Promise.resolve({ flushed: false, remainingDirty: [] });
    }
    if (this.flushBeforeDisposePromise) return this.flushBeforeDisposePromise;

    const timeoutMs = opts?.timeoutMs ?? FLUSH_BEFORE_DISPOSE_TIMEOUT_MS;
    this.flushBeforeDisposePromise = (async () => {
      try {
        await withTimeout(
          this.flushToDisk(),
          timeoutMs,
          `room ${this.projectId} flushBeforeDestructiveDispose`,
        );
      } catch (err) {
        // Timeout or an unexpected plumbing throw. flushToDisk() already
        // handles per-file write errors and leaves those files dirty, so
        // `remainingDirty` below is the authoritative signal either way.
        console.error(
          `[CollabRoom:${this.projectId}] flushBeforeDestructiveDispose did not complete cleanly:`,
          err,
        );
      }
      const remainingDirty = Array.from(this.dirtyFiles);
      return { flushed: remainingDirty.length === 0, remainingDirty };
    })();

    return this.flushBeforeDisposePromise.finally(() => {
      this.flushBeforeDisposePromise = null;
    });
  }

  /**
   * M56: deliver a bounded, metadata-only external-mutation notice to every
   * room member (except the actor) whose CURRENT active file is one of the
   * mutated paths. At most one frame per collaborator per call; rapid
   * repeats for the same recipient+path are de-duplicated. The frame is
   * built entirely here from server-authoritative inputs.
   */
  public sendExternalMutationNotice(input: {
    paths: string[];
    mutationType: MutationType;
    actor: { userId: number; username: string };
    matchCounts?: Record<string, number>;
  }): void {
    if (this.disposed) return;
    const pathSet = new Set(input.paths.map((p) => this.normalizeRelPath(p)));
    const now = Date.now();
    this.pruneExternalMutationDedup(now);

    for (const [ws, cs] of this.clients.entries()) {
      if (cs.userId === input.actor.userId) continue;
      if (ws.readyState !== 1 /* OPEN */) continue;
      const active = cs.activeFile
        ? this.normalizeRelPath(cs.activeFile)
        : null;
      if (!active || !pathSet.has(active)) continue;

      const dedupKey = `${cs.userId}:${active}`;
      const last = this.externalMutationDedup.get(dedupKey);
      if (
        last !== undefined &&
        now - last < EXTERNAL_MUTATION_NOTICE_DEDUP_MS
      ) {
        continue;
      }
      this.externalMutationDedup.set(dedupKey, now);

      const notice: ExternalMutationNotice = {
        type: "external_mutation_notice",
        path: active,
        mutationType: input.mutationType,
        actor: input.actor,
        timestamp: now,
      };
      const mc = input.matchCounts?.[active];
      if (typeof mc === "number" && Number.isFinite(mc)) notice.matchCount = mc;

      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_CUSTOM);
      encoding.writeVarString(enc, JSON.stringify(notice));
      try {
        ws.send(encoding.toUint8Array(enc));
      } catch {}
    }
  }

  /** M56: send a whole-workspace destructive-mutation notice to one joiner. */
  public sendDestructiveMutationNotice(rec: DestructiveMutationRecord): void {
    if (this.disposed) return;
    const notice: ExternalMutationNotice = {
      type: "external_mutation_notice",
      path: null,
      mutationType: rec.mutationType,
      actor: rec.actor,
      timestamp: rec.timestamp,
    };
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_CUSTOM);
    encoding.writeVarString(enc, JSON.stringify(notice));
    for (const [ws, cs] of this.clients.entries()) {
      if (cs.userId === rec.actor.userId) continue;
      if (ws.readyState !== 1) continue;
      try {
        ws.send(encoding.toUint8Array(enc));
      } catch {}
    }
  }

  private readonly externalMutationDedup = new Map<string, number>();

  private pruneExternalMutationDedup(now: number): void {
    for (const [k, ts] of this.externalMutationDedup) {
      if (now - ts > 5 * EXTERNAL_MUTATION_NOTICE_DEDUP_MS) {
        this.externalMutationDedup.delete(k);
      }
    }
    if (
      this.externalMutationDedup.size >
      EXTERNAL_MUTATION_NOTICE_DEDUP_MAX_ENTRIES
    ) {
      this.externalMutationDedup.clear();
    }
  }

  private normalizeRelPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  /**
   * M56: safe, route-facing snapshot of which collaborators have any of
   * `paths` open, whether they are actively editing, and their reported
   * unsaved (`activeFileDirty`) state. Returns plain data only — never a
   * WebSocket, Y.Doc, or Y.Text.
   */
  public getCollaboratorFileState(
    paths: string[],
    excludeUserId?: number,
  ): CollaboratorFileState[] {
    const wanted = new Set(paths.map((p) => this.normalizeRelPath(p)));
    const states = this.awareness.getStates();
    const seen = new Set<string>();
    const out: CollaboratorFileState[] = [];

    for (const cs of this.clients.values()) {
      if (excludeUserId !== undefined && cs.userId === excludeUserId) continue;
      if (!cs.activeFile) continue;
      const active = this.normalizeRelPath(cs.activeFile);
      if (!wanted.has(active)) continue;
      const dedup = `${cs.userId}:${active}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      let editing = false;
      let dirty: boolean | "unknown" = "unknown";
      for (const cid of cs.awarenessClientIds ?? []) {
        const st = states.get(cid) as Record<string, unknown> | undefined;
        if (!st) continue;
        const activity = st.activity as Record<string, unknown> | undefined;
        if (activity && activity.type === "editing") editing = true;
        if (typeof st.activeFileDirty === "boolean") {
          // Any owned awareness entry reporting dirty wins.
          if (st.activeFileDirty === true) dirty = true;
          else if (dirty !== true) dirty = false;
        }
      }

      out.push({
        userId: cs.userId,
        username: cs.username,
        role: cs.role,
        path: active,
        open: true,
        editing,
        dirty,
      });
    }
    return out;
  }

  private static readonly IDLE_DISPOSE_BASE_MS = 10000;
  private static readonly IDLE_DISPOSE_RETRY_CAP_MS = 5 * 60 * 1000;

  private scheduleIdleDisposal(
    delayMs: number = CollaborationRoom.IDLE_DISPOSE_BASE_MS,
  ): void {
    // M41: once disposed, a room must never arm another idle-dispose timer
    // (invariant A) — belt-and-suspenders alongside removeClient()'s own
    // disposed guard, in case some future caller invokes this directly.
    if (this.disposed) return;

    if (this.idleDisposeTimer) clearTimeout(this.idleDisposeTimer);

    // Idle grace timer before freeing room from memory. On retry (a prior
    // flush left files dirty) the delay doubles, capped at
    // IDLE_DISPOSE_RETRY_CAP_MS, so a permanently failing write (disk full,
    // permissions lost, workspace removed without the project being deleted)
    // degrades to an infrequent retry instead of hammering the filesystem
    // and logs forever at a fixed 10s cadence. Content is never dropped —
    // only the retry cadence backs off.
    this.idleDisposeTimer = setTimeout(async () => {
      // M41: the room may have been disposed by an explicit operation
      // (import/restore/delete) during the delay window between this timer
      // being armed and firing. flushToDisk() already refuses to write once
      // disposed, but checking here too avoids the pointless work and the
      // (harmless but confusing) double-dispose() call below.
      if (this.disposed) return;
      if (this.clients.size === 0) {
        await this.flushToDisk();
        // A client can reconnect (addClient) while the await above is in
        // flight — flushToDisk() does real I/O and does not hold any lock
        // against new joins. Re-check here, not just at the top of this
        // callback: disposing unconditionally on the stale "empty" read
        // would destroy the room (and force-close the just-reconnected
        // socket with 1001) out from under a client who is already back.
        if (this.clients.size > 0) {
          return;
        }
        if (this.dirtyFiles.size === 0) {
          this.dispose();
        } else {
          // Disposing here would destroy the Y.Doc holding the only remaining
          // copy of content that failed to persist. Retry after a
          // (back-off-capped) grace period instead.
          const nextDelay = Math.min(
            delayMs * 2,
            CollaborationRoom.IDLE_DISPOSE_RETRY_CAP_MS,
          );
          console.error(
            `[CollabRoom:${this.projectId}] idle disposal deferred: ${this.dirtyFiles.size} file(s) failed to flush, retrying in ${nextDelay}ms`,
          );
          this.scheduleIdleDisposal(nextDelay);
        }
      }
    }, delayMs);
  }

  /**
   * Closes room, flushes files, and frees all memory.
   */
  public dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxFlushTimer) clearTimeout(this.maxFlushTimer);
    if (this.idleDisposeTimer) clearTimeout(this.idleDisposeTimer);
    if (this.yjsCoalesceTimer) clearTimeout(this.yjsCoalesceTimer);
    if (this.awarenessCoalesceTimer) clearTimeout(this.awarenessCoalesceTimer);
    if (this.slowClientRecheckTimer) clearInterval(this.slowClientRecheckTimer);
    // M54: run-status registry teardown.
    for (const t of this.runStatusLingerTimers.values()) clearTimeout(t);
    this.runStatusLingerTimers.clear();
    if (this.runStatusSweepTimer) {
      clearInterval(this.runStatusSweepTimer);
      this.runStatusSweepTimer = null;
    }
    this.runStatus.clear();
    this.yjsCoalesceTimer = null;
    this.awarenessCoalesceTimer = null;
    this.slowClientRecheckTimer = null;
    this.pendingYjsUpdates = [];
    this.pendingYjsOrigins = new Set();
    this.pendingAwarenessClientIds = new Set();
    this.pendingAwarenessOrigins = new Set();
    this.slowClients.clear();

    for (const [ws] of this.clients.entries()) {
      try {
        ws.close(1001, "Room disposed");
      } catch {}
    }
    this.clients.clear();
    this.awareness.destroy();
    this.doc.destroy();
    this.onDisposeCallback(this.projectId);
  }
}

/**
 * Singleton manager for project collaboration rooms.
 */
export class CollaborationManager {
  private static instance: CollaborationManager;
  private readonly rooms: Map<string, CollaborationRoom> = new Map();
  private cfg!: AppConfig;
  private db!: Db;

  private constructor() {}

  public static getInstance(): CollaborationManager {
    if (!CollaborationManager.instance) {
      CollaborationManager.instance = new CollaborationManager();
    }
    return CollaborationManager.instance;
  }

  public init(cfg: AppConfig, db: Db): void {
    this.cfg = cfg;
    this.db = db;
  }

  public getOrCreateRoom(projectId: string): CollaborationRoom {
    let room = this.rooms.get(projectId);
    if (!room) {
      room = new CollaborationRoom(
        projectId,
        this.cfg,
        this.db,
        (pid) => this.rooms.delete(pid),
        {
          yjsCoalesceMs: this.cfg.collabYjsCoalesceMs,
          awarenessCoalesceMs: this.cfg.collabAwarenessCoalesceMs,
          highWatermarkBytes: this.cfg.collabHighWatermarkBytes,
          lowWatermarkBytes: this.cfg.collabLowWatermarkBytes,
        },
      );
      this.rooms.set(projectId, room);
    }
    return room;
  }

  public getRoom(projectId: string): CollaborationRoom | undefined {
    return this.rooms.get(projectId);
  }

  /**
   * M54: publish a run-status transition into a project's collaboration room.
   * The sole caller is the authenticated execution WebSocket lifecycle
   * (ws/execution.ts). If no room exists for the project, this is a no-op —
   * there are no collaborators to notify. `input` is fully built from
   * server-authenticated state; nothing here originates from a client message.
   */
  public notifyRunStatus(projectId: string, input: RunStatusEntry): void {
    this.rooms.get(projectId)?.handleRunStatus(input);
  }

  public async notifyExternalFileMutation(
    projectId: string,
    filePath: string,
    newContent: string,
  ): Promise<void> {
    const room = this.rooms.get(projectId);
    if (room) {
      await room.handleExternalFileMutation(filePath, newContent);
    }
  }

  /**
   * M56: persist a live room's latest collaborative state before a
   * destructive workspace replacement disposes it. No room => nothing to
   * lose => `flushed: true`. See
   * {@link CollaborationRoom.flushBeforeDestructiveDispose}.
   */
  public flushRoomBeforeDestruction(
    projectId: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ flushed: boolean; remainingDirty: string[] }> {
    const room = this.rooms.get(projectId);
    if (!room) return Promise.resolve({ flushed: true, remainingDirty: [] });
    return room.flushBeforeDestructiveDispose(opts);
  }

  /**
   * M56: safe collaborator/file state for a destructive-operation preflight
   * (Git checkout, Replace All, restore/import). Empty array when no room.
   */
  public getCollaboratorFileState(
    projectId: string,
    paths: string[],
    excludeUserId?: number,
  ): CollaboratorFileState[] {
    return (
      this.rooms
        .get(projectId)
        ?.getCollaboratorFileState(paths, excludeUserId) ?? []
    );
  }

  /**
   * M56: deliver bounded metadata-only external-mutation notices to affected
   * non-initiating collaborators. For a live room this fans out immediately;
   * for the whole-workspace destructive types the room is (about to be)
   * gone, so the notice is recorded and replayed to reconnecting members —
   * use {@link registerDestructiveMutation} for those.
   */
  public emitExternalMutationNotice(
    projectId: string,
    input: {
      paths: string[];
      mutationType: MutationType;
      actorUserId: number;
      actorUsername: string;
      matchCounts?: Record<string, number>;
    },
  ): void {
    if (!isMutationType(input.mutationType)) return;
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.sendExternalMutationNotice({
      paths: input.paths,
      mutationType: input.mutationType,
      actor: { userId: input.actorUserId, username: input.actorUsername },
      matchCounts: input.matchCounts,
    });
  }

  // M56: bounded, TTL'd record of the most recent whole-workspace
  // replacement per project. Replayed to non-actor collaborators when they
  // reconnect after being force-disconnected by the dispose. Never persisted.
  private readonly recentDestructiveMutations = new Map<
    string,
    DestructiveMutationRecord
  >();

  public registerDestructiveMutation(
    projectId: string,
    mutationType: MutationType,
    actorUserId: number | undefined,
    actorUsername: string | undefined,
  ): void {
    if (!isMutationType(mutationType)) return;
    if (typeof actorUserId !== "number" || !actorUsername) return;
    this.pruneDestructiveMutations();
    this.recentDestructiveMutations.set(projectId, {
      mutationType,
      actor: { userId: actorUserId, username: actorUsername },
      timestamp: Date.now(),
    });
  }

  public getRecentDestructiveMutation(
    projectId: string,
  ): DestructiveMutationRecord | undefined {
    const rec = this.recentDestructiveMutations.get(projectId);
    if (!rec) return undefined;
    if (Date.now() - rec.timestamp > DESTRUCTIVE_MUTATION_TTL_MS) {
      this.recentDestructiveMutations.delete(projectId);
      return undefined;
    }
    return rec;
  }

  private pruneDestructiveMutations(): void {
    const now = Date.now();
    for (const [k, rec] of this.recentDestructiveMutations) {
      if (now - rec.timestamp > DESTRUCTIVE_MUTATION_TTL_MS) {
        this.recentDestructiveMutations.delete(k);
      }
    }
    if (
      this.recentDestructiveMutations.size > DESTRUCTIVE_MUTATION_MAX_ENTRIES
    ) {
      // Evict oldest.
      const oldest = [...this.recentDestructiveMutations.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) this.recentDestructiveMutations.delete(oldest[0]);
    }
  }

  public revokeUser(projectId: string, userId: number): void {
    const room = this.rooms.get(projectId);
    if (room) {
      room.disconnectUser(userId);
    }
  }

  public updateUserRole(
    projectId: string,
    userId: number,
    role: "owner" | "editor" | "viewer",
  ): void {
    const room = this.rooms.get(projectId);
    if (room) {
      room.updateUserRole(userId, role);
    }
  }

  public getActiveRoomCount(): number {
    return this.rooms.size;
  }

  /** Observability-only: total physical broadcast sends across every
   *  currently-active room, summed fresh each call (rooms are disposed and
   *  removed from `this.rooms` independently, so this never double-counts
   *  or leaks a disposed room's count). */
  public getTotalBroadcastSendCount(): number {
    let total = 0;
    for (const room of this.rooms.values()) {
      total += room.getBroadcastSendCount();
    }
    return total;
  }

  /**
   * Default per-room flush bound. A room whose disk write hangs ( wedged
   * NFS/fuse, dead handle) must never be able to wedge the manager: after
   * this budget the room's slot rejects, allSettled contains it, and the
   * pass completes so subsequent passes can run.
   */
  private static readonly PER_ROOM_FLUSH_TIMEOUT_MS = 5000;

  /**
   * Flushes every active room's dirty Y.Text content to the workspace
   * filesystem. Called by the graceful-shutdown sequence (see index.ts) and
   * available to tests/ops tooling.
   *
   * Guarantees:
   *  - Rooms are flushed CONCURRENTLY via Promise.allSettled: one room's
   *    failure (disk full, permission loss, poisoned path) is contained,
   *    logged with its projectId, and can never abort or starve another
   *    room's persistence.
   *  - Each individual room flush is bounded by `perRoomTimeoutMs`
   *    (default {@link CollaborationManager.PER_ROOM_FLUSH_TIMEOUT_MS}), so a
   *    hung write degrades into a contained rejection instead of wedging this
   *    pass — or any future pass — indefinitely.
   *  - The returned promise settles only when every room's flush attempt has
   *    finished — successful, failed, or timed out.
   *
   * Note: overlapping invocations each run their own pass rather than sharing
   * one. Full-file rewrites of identical content are idempotent in practice,
   * whereas promise-caching dedupe would let one hung room block every future
   * caller forever — the worse failure mode by far.
   */
  public flushAllRooms(
    options: { perRoomTimeoutMs?: number } = {},
  ): Promise<void> {
    const perRoomTimeoutMs =
      options.perRoomTimeoutMs ??
      CollaborationManager.PER_ROOM_FLUSH_TIMEOUT_MS;
    return this.runFlushAllRooms(perRoomTimeoutMs);
  }

  private async runFlushAllRooms(perRoomTimeoutMs: number): Promise<void> {
    const rooms = Array.from(this.rooms.values());
    if (rooms.length === 0) return;

    const results = await Promise.allSettled(
      rooms.map((room) =>
        withTimeout(
          (async () => {
            try {
              await room.flushToDisk();
            } catch (err) {
              // flushToDisk() already contains per-file error handling; this
              // catch exists so an unexpected throw in the room-level plumbing
              // is attributed and contained rather than aborting siblings.
              console.error(
                `[CollabManager] room ${room.projectId} failed to flush:`,
                err,
              );
              throw err;
            }
          })(),
          perRoomTimeoutMs,
          `room ${room.projectId} flush`,
        ),
      ),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.error(
        `[CollabManager] flushAllRooms finished with ${failed}/${rooms.length} room(s) failed — unpersisted content remains dirty in those rooms`,
      );
    }
  }
}

export const collaborationManager = CollaborationManager.getInstance();
