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
import { buildAuthoritativeAwarenessState } from "./presence.js";
import { getDisplayName } from "../profile/store.js";
import { effectiveDisplayName } from "../profile/identity.js";
import {
  parseAttentionInput,
  buildAttentionEvent,
  fallbackUserColor,
  RateLimiter,
  AttentionRequestRegistry,
  ATTENTION_RATE_WINDOW_MS,
  ATTENTION_MAX_EVENTS_PER_WINDOW,
  type AttentionAuthor,
  type AttentionEvent,
  type AttentionClearedReason,
} from "./attention.js";
import {
  collaborationHistorian,
  type CollaborationHistorian,
} from "./historian.js";
import { touchLastSeen } from "./lastSeen.js";

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

// M65: Shared Run Output. A bounded, ephemeral, in-memory replay tail of a
// run's stdout/stderr, delivered to owner/editor collaborators (NEVER viewers,
// NEVER a client) alongside the M54 run-status broadcast. Nothing is persisted;
// the buffer IS the reconnect story. Chunks accumulated within
// RUN_OUTPUT_FLUSH_MS are coalesced into one broadcast batch to bound frame
// rate. When the buffer would exceed RUN_OUTPUT_MAX_BYTES the OLDEST chunks are
// dropped (tail semantics — newest output is the most relevant) and `truncated`
// latches true. The buffer is bound to its M54 run-status entry: output for an
// execution with no live status entry is rejected, and it is torn down with the
// status entry (linger clear / stale sweep / dispose).
export const RUN_OUTPUT_MAX_BYTES = 256 * 1024;
const RUN_OUTPUT_FLUSH_MS = 60;

// M55: server-authoritative awareness identity + bounded ephemeral metadata.
// The collaboration `user` identity was previously client-asserted and
// rebroadcast verbatim, so a modified client could advertise another user's
// id/name/role. Every inbound MESSAGE_AWARENESS update is now rebuilt
// server-side: identity is forced to the authenticated WS session, only the
// connection's own awareness clientIDs may be written, and the remaining
// ephemeral fields are enum/-bounds-checked. Nothing here is persisted.
// The awareness FIELD ALLOWLIST (which ephemeral fields survive, and their
// bounds) lives in ./presence.ts — M57 extracted it so G1/G2 (workingFolder,
// intent) extend one place and the enums stop drifting across files. The
// FRAME-DECODE limits below stay here: they belong to sanitizeIncomingAwareness
// Update()'s per-connection clientID accounting, not to the field allowlist.
const AWARENESS_MAX_ENTRIES_PER_FRAME = 64;
const AWARENESS_MAX_CLIENT_IDS_PER_CONNECTION = 8;

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
 * Outcome of an external file mutation (REST save, snapshot restore, template,
 * Replace-All, Git checkout, AI apply-patch) against a live collaboration room.
 *
 * - `applied: true,  conflict: false` — the room now reflects `newContent`
 *   (or already did / the file is not tracked).
 * - `applied: false, conflict: true`  — the room holds unpersisted collaborator
 *   edits that `newContent` would have destroyed. The live Y.Text was left
 *   untouched and the file stays dirty so the room re-persists the
 *   authoritative live content over the caller's (now stale) disk write. The
 *   caller MUST surface this rather than report success.
 */
export interface ExternalMutationResult {
  applied: boolean;
  conflict: boolean;
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

/** M65: one stdout/stderr fragment in a run's shared output buffer. */
export interface RunOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

interface RunOutputEntry {
  /** Retained ring, oldest first. Bounded to RUN_OUTPUT_MAX_BYTES. */
  chunks: RunOutputChunk[];
  /** UTF-8 byte length of everything in `chunks`. */
  bytes: number;
  /** Latches once any chunk has been dropped / head-truncated. */
  truncated: boolean;
  /** Monotonic per-execution batch counter (last emitted). */
  seq: number;
  /** Chunks arrived since the last flush, awaiting the coalesced broadcast. */
  pending: RunOutputChunk[];
  flushTimer: NodeJS.Timeout | null;
}

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

  // M65: ephemeral shared run-output buffers, keyed by executionId. Populated
  // only via CollaborationManager.notifyRunOutput (the authenticated execution
  // socket's onStdout/onStderr). Never persisted. Teardown rides the M54
  // run-status lifecycle — see deleteRunOutput() call sites.
  private readonly runOutput = new Map<string, RunOutputEntry>();

  // M58: transient ATTENTION layer (Point / Callout / targeted "Come look").
  // Points and callouts are pure relay (no server state — client TTL + a hard
  // server ceiling baked into `expiresAt`). Targeted requests are held in a
  // bounded in-memory registry with one expiry timer each, snapshotted ONLY to
  // the intended recipient on join, and cleared on dismiss / expiry / author
  // disconnect / target disconnect / dispose. Never persisted, never touches
  // Y.Doc or awareness.
  private readonly attentionRateLimiters = new WeakMap<WebSocket, RateLimiter>();
  private readonly attentionRegistry = new AttentionRequestRegistry();
  private readonly attentionExpiryTimers = new Map<string, NodeJS.Timeout>();

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

  // M60: idempotent per-file Y.Text observers for best-effort line-range
  // enrichment, and a per-transaction stash they write into for the M60
  // afterTransaction hook to drain. The stash is a WeakMap keyed by the
  // transaction object — populated and drained within one synchronous
  // cleanupTransactions pass (yjs 13.6.32: type observers fire before
  // `afterTransaction`), never retained.
  /** M60: set only while a `messageYjsSyncStep2` bulk apply is in flight (a
   *  client re-seeding the room from its own lineage) — the M60
   *  afterTransaction hook skips attribution for the duration. */
  private m60SuppressAttribution = false;
  // M62-3: per-room resolved EFFECTIVE display name, keyed by userId. Read on
  // every server-authoritative awareness rebuild so that hot path never
  // touches the DB. Populated once per user in addClient(), refreshed in
  // place on a targeted profile_event, pruned when a user's last client
  // leaves. A cache miss falls back to the username at the call site.
  private readonly displayNameByUser = new Map<number, string>();

  private readonly rangeObservedFiles = new Set<string>();
  private readonly rangeStash = new WeakMap<
    Y.Transaction,
    Map<
      string,
      {
        startLine: number;
        endLine: number;
        contiguous: boolean;
        linesAdded: number;
        linesRemoved: number;
      }
    >
  >();

  constructor(
    projectId: string,
    cfg: AppConfig,
    db: Db,
    onDispose: (projectId: string) => void,
    options: CollaborationRoomOptions = {},
    private readonly historian: CollaborationHistorian = collaborationHistorian,
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

    // M60: a SECOND, isolated afterTransaction subscriber for change
    // attribution. Deliberately separate from the dirty-tracking listener
    // above so its early-returns (which M60 must NOT short-circuit on —
    // external mutations still contaminate an open burst) never interfere,
    // and so the battle-tested dirty logic is untouched. `afterTransaction`
    // is authoritative for author + file-level change existence; the Y.Text
    // observer's stash is best-effort range enrichment only. See spec §3.
    this.doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (this.disposed) return;
      // M60: a bulk sync-step-2 re-seed is not a user edit.
      if (this.m60SuppressAttribution) {
        this.rangeStash.delete(tr);
        return;
      }
      const origin = tr.origin;
      const stash = this.rangeStash.get(tr);
      const shares = this.doc.share as Map<string, unknown>;

      const fileOf = (changedType: unknown): string | null => {
        for (const [key, type] of shares.entries()) {
          if (type === changedType) return key;
        }
        return null;
      };

      // External / disk-load transactions: no attribution, but they DO
      // contaminate any open burst for the touched file (a bystander's write
      // changed the file under an author — exact range can no longer be
      // claimed).
      if (origin === "external_mutation" || origin === "initial_disk_load") {
        for (const changedType of tr.changed.keys()) {
          const fp = fileOf(changedType);
          if (fp) this.historian.contaminateFile(this.projectId, fp);
        }
        this.rangeStash.delete(tr);
        return;
      }

      const isWs =
        !!origin &&
        typeof origin === "object" &&
        this.clients.has(origin as WebSocket);
      if (!isWs || tr.changed.size === 0) {
        this.rangeStash.delete(tr);
        return;
      }
      const cs = this.clients.get(origin as WebSocket);
      if (!cs) {
        this.rangeStash.delete(tr);
        return;
      }

      const now = Date.now();
      for (const changedType of tr.changed.keys()) {
        const filePath = fileOf(changedType);
        if (!filePath || !this.isPersistablePath(filePath)) continue;
        const r = stash?.get(filePath) ?? null;
        this.historian.recordEdit({
          projectId: this.projectId,
          authorUserId: cs.userId,
          username: cs.username,
          filePath,
          at: now,
          range: r
            ? {
                startLine: r.startLine,
                endLine: r.endLine,
                contiguous: r.contiguous,
              }
            : null,
          linesAdded: r?.linesAdded ?? 0,
          linesRemoved: r?.linesRemoved ?? 0,
        });
      }
      this.rangeStash.delete(tr);
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
      // M65: the shared output buffer is bound to this status entry.
      this.deleteRunOutput(input.executionId);
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
          this.deleteRunOutput(id); // M65
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

  // --- M65: shared run output -------------------------------------------

  /**
   * Records one stdout/stderr fragment for a run and schedules a coalesced
   * broadcast to the room's owner/editor clients. The only caller is
   * CollaborationManager.notifyRunOutput, driven by the authenticated
   * execution WebSocket (ws/execution.ts onStdout/onStderr). Rejected unless
   * the run has a live M54 status entry, so a buffer can never outlive — or
   * predate — its run.
   */
  public handleRunOutput(
    executionId: string,
    stream: "stdout" | "stderr",
    data: string,
  ): void {
    if (this.disposed) return;
    if (typeof data !== "string" || data.length === 0) return;
    if (!this.runStatus.has(executionId)) return;

    let entry = this.runOutput.get(executionId);
    if (!entry) {
      entry = {
        chunks: [],
        bytes: 0,
        truncated: false,
        seq: 0,
        pending: [],
        flushTimer: null,
      };
      this.runOutput.set(executionId, entry);
    }

    const chunk: RunOutputChunk = { stream, data };
    entry.chunks.push(chunk);
    entry.bytes += Buffer.byteLength(data, "utf8");
    entry.pending.push(chunk);
    this.trimRunOutput(entry);

    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => {
        const e = this.runOutput.get(executionId);
        if (e) e.flushTimer = null;
        this.flushRunOutput(executionId);
      }, RUN_OUTPUT_FLUSH_MS);
      entry.flushTimer.unref?.();
    }
  }

  /** Enforce RUN_OUTPUT_MAX_BYTES: drop whole chunks from the front; if a lone
   *  chunk is itself over the cap, keep only its tail. Latches `truncated`. */
  private trimRunOutput(entry: RunOutputEntry): void {
    while (entry.bytes > RUN_OUTPUT_MAX_BYTES && entry.chunks.length > 1) {
      const dropped = entry.chunks.shift()!;
      entry.bytes -= Buffer.byteLength(dropped.data, "utf8");
      entry.truncated = true;
    }
    if (entry.bytes > RUN_OUTPUT_MAX_BYTES && entry.chunks.length === 1) {
      const only = entry.chunks[0];
      const buf = Buffer.from(only.data, "utf8");
      const tail = buf
        .subarray(buf.length - RUN_OUTPUT_MAX_BYTES)
        .toString("utf8");
      entry.chunks[0] = { stream: only.stream, data: tail };
      entry.bytes = Buffer.byteLength(tail, "utf8");
      entry.truncated = true;
    }
  }

  private flushRunOutput(executionId: string): void {
    if (this.disposed) return;
    const entry = this.runOutput.get(executionId);
    if (!entry || entry.pending.length === 0) return;
    entry.seq += 1;
    const chunks = entry.pending;
    entry.pending = [];
    this.broadcastRunOutput({
      type: "run_output",
      executionId,
      seq: entry.seq,
      truncated: entry.truncated,
      chunks,
    });
  }

  /**
   * Fan out one run-output frame to the room's OWNER/EDITOR clients only —
   * the M65 access boundary. Viewers get M54 run status but never the output
   * stream itself. Server-authored; there is no inbound `run_output`.
   */
  private broadcastRunOutput(obj: unknown): void {
    const frame = this.encodeCustom(obj);
    for (const [client, state] of this.clients.entries()) {
      if (state.role !== "owner" && state.role !== "editor") continue;
      if (client.readyState !== 1 /* OPEN */) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  private deleteRunOutput(executionId: string): void {
    const entry = this.runOutput.get(executionId);
    if (!entry) return;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    this.runOutput.delete(executionId);
  }

  /**
   * M65: replay the buffered output of every live run to a freshly joined
   * owner/editor as `snapshot: true` frames. Mirrors the M54 run-status
   * snapshot in addClient(). Nothing is sent to a viewer.
   */
  private sendRunOutputSnapshot(ws: WebSocket): void {
    for (const [executionId, entry] of this.runOutput.entries()) {
      if (entry.chunks.length === 0) continue;
      const frame = this.encodeCustom({
        type: "run_output",
        executionId,
        seq: entry.seq,
        snapshot: true,
        truncated: entry.truncated,
        chunks: entry.chunks,
      });
      try {
        ws.send(frame);
      } catch {}
    }
  }

  /** Test-support: a read-only view of a run's buffer (mirrors
   *  getBroadcastSendCount / hasAttentionRequest). */
  public getRunOutputSnapshotForTest(executionId: string): {
    chunks: RunOutputChunk[];
    bytes: number;
    truncated: boolean;
    seq: number;
  } | null {
    const e = this.runOutput.get(executionId);
    if (!e) return null;
    return {
      chunks: e.chunks.map((c) => ({ ...c })),
      bytes: e.bytes,
      truncated: e.truncated,
      seq: e.seq,
    };
  }

  // --- M58: transient attention layer ------------------------------------

  private attentionRateLimiterFor(ws: WebSocket): RateLimiter {
    let rl = this.attentionRateLimiters.get(ws);
    if (!rl) {
      rl = new RateLimiter(
        ATTENTION_RATE_WINDOW_MS,
        ATTENTION_MAX_EVENTS_PER_WINDOW,
      );
      this.attentionRateLimiters.set(ws, rl);
    }
    return rl;
  }

  /**
   * The attention author is ALWAYS the authenticated WS session — never
   * anything the client asserted. Colour is taken from this connection's own
   * published awareness (`user.color`), falling back to a deterministic
   * palette colour so a point/callout carries identity even before the author
   * has broadcast presence.
   */
  private authorFor(clientState: CollaboratorClientState): AttentionAuthor {
    let color = fallbackUserColor(clientState.userId);
    const ids = clientState.awarenessClientIds;
    if (ids) {
      for (const cid of ids) {
        const st = this.awareness.getStates().get(cid) as
          | { user?: { color?: unknown } }
          | undefined;
        const c = st?.user?.color;
        if (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c)) {
          color = c;
          break;
        }
      }
    }
    return {
      userId: clientState.userId,
      username: clientState.username,
      color,
    };
  }

  private encodeCustom(obj: unknown): Uint8Array {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_CUSTOM);
    encoding.writeVarString(enc, JSON.stringify(obj));
    return encoding.toUint8Array(enc);
  }

  private broadcastAttention(obj: unknown, exceptWs?: WebSocket): void {
    const frame = this.encodeCustom(obj);
    for (const [client] of this.clients.entries()) {
      if (client === exceptWs) continue;
      if (client.readyState !== 1) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  /**
   * M60: fan out one closed-burst / callout history event to every client in
   * the room as a receive-only `MESSAGE_CUSTOM` `collab_change`. No exclusions
   * — the author seeing their own change land in the timeline is correct.
   * Mirrors `broadcastRunStatus`. Sole caller is the historian's broadcaster.
   */
  public broadcastCollabChange(ev: Record<string, unknown>): void {
    if (this.disposed) return;
    const frame = this.encodeCustom({ type: "collab_change", ...ev });
    for (const [client] of this.clients.entries()) {
      if (client.readyState !== 1 /* OPEN */) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  /**
   * M61-A: fan out one comment-lifecycle invalidation ping to every client in
   * the room as a receive-only `MESSAGE_CUSTOM` `comment_event`. Carries NO
   * authoritative comment data — it is a scoped cache-invalidation trigger;
   * the client refetches `GET /comments?file=` over REST. Mirrors
   * `broadcastCollabChange`. `comment_event` / `comment_mention` /
   * `profile_event` are OUTBOUND-only (server-authored) — `handleMessage`'s
   * `MESSAGE_CUSTOM` branch never accepts them from a client.
   */
  public broadcastCommentEvent(ev: Record<string, unknown>): void {
    if (this.disposed) return;
    const frame = this.encodeCustom({ type: "comment_event", ...ev });
    for (const [client] of this.clients.entries()) {
      if (client.readyState !== 1 /* OPEN */) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  /**
   * M61-A: deliver a `comment_mention` ping to every live socket belonging to
   * `userId` in this room (mirrors `sendAttentionTo`). Presentation only —
   * persistence is the `comment_mentions` row; an offline target re-surfaces
   * via the M60 "while you were away" path.
   */
  public sendCommentMentionTo(userId: number, ev: Record<string, unknown>): void {
    if (this.disposed) return;
    const frame = this.encodeCustom({ type: "comment_mention", ...ev });
    for (const [client, s] of this.clients.entries()) {
      if (s.userId !== userId) continue;
      if (client.readyState !== 1) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  /**
   * M61-C: fan out a `profile_event` invalidation ping — `{type, userId}` only,
   * no profile data. Every live client in the room refetches that user's
   * identity from access-controlled REST / collaboration state. Receive-only:
   * a client-sent `profile_event` is not in `handleMessage`'s MESSAGE_CUSTOM
   * allowlist and is ignored. Prefer `refreshProfileIdentity` as the entry
   * point — it self-gates on room membership and refreshes the cache first.
   */
  public broadcastProfileEvent(ev: Record<string, unknown>): void {
    if (this.disposed) return;
    const frame = this.encodeCustom({ type: "profile_event", ...ev });
    for (const [client] of this.clients.entries()) {
      if (client.readyState !== 1 /* OPEN */) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  /**
   * M62-3: a member edited their profile. If this room holds a live
   * authenticated client for `userId`, re-resolve that user's cached
   * effective display name from the current persisted profile, then fan out
   * ONE room `profile_event`. No-op (no event, no cache touch) when the user
   * has no client here — that is what keeps a profile update from reaching
   * unrelated rooms.
   */
  public refreshProfileIdentity(userId: number): void {
    if (this.disposed) return;
    const cs = this.findClientStateForUser(userId);
    if (!cs) return;
    this.cacheEffectiveDisplayName(userId, cs.username);
    this.broadcastProfileEvent({ userId });
  }

  /** Resolve `userId`'s effective display name from the persisted profile and
   *  store it in the per-room awareness cache. One narrow column read; never
   *  called from the awareness frame path. */
  private cacheEffectiveDisplayName(userId: number, username: string): void {
    let raw: string | null = null;
    try {
      raw = getDisplayName(this.db, userId);
    } catch {
      raw = null; // fall back to username below; never block a join on this
    }
    this.displayNameByUser.set(userId, effectiveDisplayName(raw, username));
  }

  /** The client state of any one live connection for `userId` in this room. */
  private findClientStateForUser(
    userId: number,
  ): CollaboratorClientState | undefined {
    for (const s of this.clients.values()) {
      if (s.userId === userId) return s;
    }
    return undefined;
  }

  /** Does any live connection in this room belong to `userId`? */
  private hasClientForUser(userId: number): boolean {
    return this.findClientStateForUser(userId) !== undefined;
  }

  /** M60: back-compat alias — post-`clients.delete` this reads as "another
   *  socket for this user remains". Single implementation lives in
   *  {@link hasClientForUser}. */
  private hasOtherSocketForUser(userId: number): boolean {
    return this.hasClientForUser(userId);
  }

  private sendAttentionTo(userId: number, obj: unknown): void {
    const frame = this.encodeCustom(obj);
    for (const [client, s] of this.clients.entries()) {
      if (s.userId !== userId) continue;
      if (client.readyState !== 1) continue;
      try {
        client.send(frame);
      } catch {}
    }
  }

  private isAttentionRoomMember(userId: number, exceptWs?: WebSocket): boolean {
    for (const [client, s] of this.clients.entries()) {
      if (client === exceptWs) continue;
      if (s.userId === userId) return true;
    }
    return false;
  }

  private scheduleAttentionExpiry(event: AttentionEvent): void {
    const delay = Math.max(0, event.expiresAt - Date.now());
    const timer = setTimeout(() => {
      this.attentionExpiryTimers.delete(event.id);
      this.clearAttentionRequest(event.id, "expired");
    }, delay);
    timer.unref?.();
    this.attentionExpiryTimers.set(event.id, timer);
  }

  /**
   * Removes one targeted request from the registry, clears its expiry timer,
   * and notifies both the target and the author with an `attention_cleared`.
   * A no-op if the id is unknown (already expired / dismissed).
   */
  private clearAttentionRequest(
    id: string,
    reason: AttentionClearedReason,
  ): void {
    const timer = this.attentionExpiryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.attentionExpiryTimers.delete(id);
    }
    const event = this.attentionRegistry.delete(id);
    if (!event || event.targetUserId === undefined) return;
    const msg = { type: "attention_cleared", id, reason };
    this.sendAttentionTo(event.targetUserId, msg);
    this.sendAttentionTo(event.author.userId, msg);
  }

  /**
   * Entry point for every inbound `attention_*` custom message. Called from
   * within the existing `case MESSAGE_CUSTOM` try/catch, so it must never
   * throw. Fails closed on rate limit, parse failure, unauthorized target.
   */
  private handleAttentionMessage(
    ws: WebSocket,
    clientState: CollaboratorClientState,
    parsed: Record<string, unknown>,
  ): void {
    if (this.disposed) return;

    if (parsed.type === "attention_dismiss") {
      const id = typeof parsed.id === "string" ? parsed.id : null;
      if (!id) return;
      const event = this.attentionRegistry.get(id);
      // Authorization: the entry must exist AND target the dismisser's user.
      // A client-supplied `reason`/`acted` is never proof of anything.
      if (!event || event.targetUserId !== clientState.userId) return;
      this.clearAttentionRequest(
        id,
        parsed.acted === true ? "acted" : "dismissed",
      );
      return;
    }

    if (!this.attentionRateLimiterFor(ws).tryConsume(Date.now())) return;

    const input = parseAttentionInput(parsed);
    if (!input) return;

    const now = Date.now();
    const author = this.authorFor(clientState);

    if (input.kind === "point" || input.kind === "callout") {
      const event = buildAttentionEvent(input, author, now);
      this.broadcastAttention(event, ws);
      // M60: a callout additionally leaves a safe, metadata-only history row.
      // The M58 callout itself stays ephemeral — this does not make it
      // persistent chat (that is M61). Points are NOT recorded (too transient).
      if (input.kind === "callout") {
        this.historian.recordCallout({
          projectId: this.projectId,
          authorUserId: clientState.userId,
          username: clientState.username,
          filePath: event.file,
          startLine: event.range?.startLine ?? null,
          endLine: event.range?.endLine ?? null,
          messagePreview: (event.message ?? "").slice(0, 120),
          targeted: false,
          at: now,
        });
      }
      return;
    }

    // input.kind === "request"
    if (
      input.targetUserId === clientState.userId ||
      !this.isAttentionRoomMember(input.targetUserId)
    ) {
      return; // self-target or non-member — silent
    }

    const event = buildAttentionEvent(input, author, now);
    const res = this.attentionRegistry.tryAdd(event);
    if (!res.ok) {
      // Lightweight, transient sender-side indication. Not a persistent error.
      this.sendAttentionTo(author.userId, {
        type: "attention_rate_limited",
        scope: "outstanding_requests",
      });
      return;
    }
    if (res.evicted) {
      const t = this.attentionExpiryTimers.get(res.evicted.id);
      if (t) {
        clearTimeout(t);
        this.attentionExpiryTimers.delete(res.evicted.id);
      }
      if (res.evicted.targetUserId !== undefined) {
        const msg = {
          type: "attention_cleared",
          id: res.evicted.id,
          reason: "expired" as const,
        };
        this.sendAttentionTo(res.evicted.targetUserId, msg);
        this.sendAttentionTo(res.evicted.author.userId, msg);
      }
    }
    this.scheduleAttentionExpiry(event);
    this.sendAttentionTo(input.targetUserId, event);
    this.sendAttentionTo(author.userId, event); // author echo → "✓ Sent"
  }

  /** Test-support: observability accessor (mirrors getBroadcastSendCount). */
  public hasAttentionRequest(id: string): boolean {
    return this.attentionRegistry.get(id) !== undefined;
  }

  /**
   * M60: best-effort line-range enrichment. Computes the affected span of one
   * Y.Text change from its Quill-style delta and stashes it against the
   * transaction for the M60 afterTransaction hook to drain. Never authoritative
   * — if this misses or is ambiguous, the change is still recorded file-level.
   * Skips external/disk-load transactions (those are handled by contamination).
   */
  private stashRange(filePath: string, evt: Y.YTextEvent): void {
    const tr = evt.transaction;
    if (
      tr.origin === "external_mutation" ||
      tr.origin === "initial_disk_load"
    ) {
      return;
    }
    let offset = 0;
    let changeStart = -1;
    let changeEnd = -1;
    let clusters = 0;
    let inCluster = false;
    let added = 0;
    let removed = 0;
    const deletedRuns: number[] = [];
    // yjs's YTextEvent.changes.deleted carries the removed items when available.
    try {
      for (const item of evt.changes.deleted) {
        const c = (item as { content?: { getContent?: () => unknown[] } })
          .content;
        const parts = c?.getContent?.() ?? [];
        for (const p of parts) {
          if (typeof p === "string") {
            deletedRuns.push((p.match(/\n/g) || []).length);
          }
        }
      }
    } catch {
      /* best-effort */
    }
    removed = deletedRuns.reduce((a, b) => a + b, 0);

    for (const op of evt.delta as Array<{
      retain?: number;
      insert?: unknown;
      delete?: number;
    }>) {
      if (typeof op.retain === "number") {
        inCluster = false;
        offset += op.retain;
      } else {
        if (!inCluster) {
          clusters += 1;
          inCluster = true;
          if (changeStart < 0) changeStart = offset;
        }
        if (typeof op.insert === "string") {
          added += (op.insert.match(/\n/g) || []).length;
          offset += op.insert.length;
          changeEnd = offset;
        }
        if (typeof op.delete === "number") {
          changeEnd = Math.max(changeEnd, offset + op.delete);
        }
      }
    }

    const text = evt.target.toString();
    const lineAt = (o: number): number =>
      text.slice(0, Math.max(0, Math.min(o, text.length))).split("\n").length;

    const entry = {
      startLine: changeStart < 0 ? 1 : lineAt(changeStart),
      endLine: changeEnd < 0 ? 1 : lineAt(changeEnd),
      contiguous: clusters <= 1,
      linesAdded: added,
      linesRemoved: removed,
    };

    let m = this.rangeStash.get(tr);
    if (!m) {
      m = new Map();
      this.rangeStash.set(tr, m);
    }
    const prev = m.get(filePath);
    m.set(
      filePath,
      prev
        ? {
            startLine: Math.min(prev.startLine, entry.startLine),
            endLine: Math.max(prev.endLine, entry.endLine),
            contiguous: prev.contiguous && entry.contiguous,
            linesAdded: prev.linesAdded + entry.linesAdded,
            linesRemoved: prev.linesRemoved + entry.linesRemoved,
          }
        : entry,
    );
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

    // M60: attach ONE best-effort range observer per file (idempotent). Only
    // reached after the workspace-boundary guard above and on the real
    // doc.getText() handle — never on the detached Y.Text returned for a
    // rejected path. doc.destroy() in dispose() removes every observer; the
    // room is discarded straight after, so no explicit teardown is needed.
    if (!this.rangeObservedFiles.has(filePath)) {
      yText.observe((evt) => this.stashRange(filePath, evt));
      this.rangeObservedFiles.add(filePath);
    }

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
   * External Mutation Safety: updates Y.Text when a workspace file is modified
   * externally (REST file save, snapshot restore, starter templates, Replace
   * All, Git checkout, AI apply-patch).
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
   *
   * CONFLICT GATE (data-loss fix): when the live Y.Text differs from
   * `newContent` AND the file carries collaborator edits that are not yet
   * persisted to disk (`dirtyFiles`), a blind full-buffer replace here would
   * silently destroy unrecoverable in-flight work. In that case this refuses
   * the replace, leaves the Y.Text untouched, keeps the file dirty so the
   * next flush re-persists the authoritative live content over the caller's
   * (now stale) disk write, and returns `{ applied: false, conflict: true }`
   * for the caller to surface.
   *
   * The whole method body is synchronous — the read, the dirty check and the
   * Y.Doc transaction all run in one event-loop turn, so a concurrent inbound
   * client edit (a separate turn) can never interleave between them.
   *
   * `newContent === ""` is exempt from the gate: that is the move/delete
   * signal (the file is going away, not being replaced) and keeps its
   * existing semantics — see test 16 and the M37 ghost-file guards.
   */
  public async handleExternalFileMutation(
    filePath: string,
    newContent: string,
  ): Promise<ExternalMutationResult> {
    if (newContent === "" && !this.doc.share.has(filePath)) {
      return { applied: true, conflict: false };
    }

    const yText = this.doc.getText(filePath);
    const currentContent = yText.toString();

    if (currentContent === newContent) {
      this.dirtyFiles.delete(filePath);
      return { applied: true, conflict: false };
    }

    if (newContent !== "" && this.dirtyFiles.has(filePath)) {
      // Ensure the authoritative live content is re-persisted: the caller
      // already wrote `newContent` to disk before notifying us.
      this.scheduleDebouncedPersistence();
      return { applied: false, conflict: true };
    }

    this.doc.transact(() => {
      yText.delete(0, yText.length);
      yText.insert(0, newContent);
    }, "external_mutation");

    this.dirtyFiles.delete(filePath);
    return { applied: true, conflict: false };
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

    // M62-3: resolve this user's effective display name once, from the
    // current persisted profile, and cache it for the awareness hot path.
    // Idempotent — a second tab for the same user just re-resolves the same
    // value. A reconnect re-runs this, so the cache always reflects the
    // profile as of the latest (re)connect or profile_event.
    this.cacheEffectiveDisplayName(clientState.userId, clientState.username);

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

    // 3b. M65: replay buffered shared run output to a joining owner/editor so a
    // mid-run collaborator sees what has printed so far. Viewers get status
    // only (see broadcastRunOutput / the M65 access boundary).
    if (
      this.runOutput.size > 0 &&
      (clientState.role === "owner" || clientState.role === "editor")
    ) {
      this.sendRunOutputSnapshot(ws);
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

    // 5. M58: replay ONLY currently-valid targeted requests aimed at THIS
    // user. A reconnecting bystander gets nothing; an expired request is not
    // in the registry so is never replayed; a request for another user is
    // never sent here.
    const attnNow = Date.now();
    for (const event of this.attentionRegistry.byTarget(clientState.userId)) {
      if (event.expiresAt <= attnNow) continue;
      try {
        ws.send(this.encodeCustom(event));
      } catch {}
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
          // M60: only an incremental `messageYjsUpdate` is a real user edit to
          // attribute. `messageYjsSyncStep2` is a client re-seeding the room
          // from its own Y.Doc lineage on connect/reconnect — after a server
          // restart the room's disk-seeded doc has different structs, so that
          // bulk apply would otherwise be misattributed as a fresh edit burst
          // per file. Suppress attribution for the duration of this apply.
          this.m60SuppressAttribution =
            syncType !== syncProtocol.messageYjsUpdate;
          try {
            syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
          } finally {
            this.m60SuppressAttribution = false;
          }

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
            } else if (
              parsed &&
              typeof parsed.type === "string" &&
              parsed.type.startsWith("attention_")
            ) {
              // M58: transient attention events. Server-authoritative author,
              // bounded, targeted where applicable — see handleAttentionMessage.
              this.handleAttentionMessage(
                ws,
                clientState,
                parsed as Record<string, unknown>,
              );
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

    // M58: an author leaving withdraws their outstanding requests (the target
    // is told `author_gone`); a target leaving drops requests aimed at them
    // (never persisted, never replayed — silent). Runs AFTER clients.delete so
    // the leaver is not counted as a member, and BEFORE scheduleIdleDisposal.
    if (clientState) {
      for (const e of this.attentionRegistry.deleteByAuthor(
        clientState.userId,
      )) {
        const t = this.attentionExpiryTimers.get(e.id);
        if (t) {
          clearTimeout(t);
          this.attentionExpiryTimers.delete(e.id);
        }
        if (e.targetUserId !== undefined) {
          this.sendAttentionTo(e.targetUserId, {
            type: "attention_cleared",
            id: e.id,
            reason: "author_gone",
          });
        }
      }
      for (const e of this.attentionRegistry.deleteByTarget(
        clientState.userId,
      )) {
        const t = this.attentionExpiryTimers.get(e.id);
        if (t) {
          clearTimeout(t);
          this.attentionExpiryTimers.delete(e.id);
        }
      }

      // M60: on a genuine disconnect (no other live socket for this user —
      // a multi-tab user closing one tab is not "gone"): close this author's
      // open bursts and stamp the last-seen boundary. A reconnect opens a
      // fresh burst; history is never duplicated (attribution is by userId).
      if (!this.hasOtherSocketForUser(clientState.userId)) {
        this.historian.closeAuthorBursts(
          this.projectId,
          clientState.userId,
          "disconnect",
        );
        try {
          touchLastSeen(this.db, this.projectId, clientState.userId);
        } catch {
          /* best-effort */
        }
        // M62-3: last client for this user gone — drop the per-room display
        // cache entry so it cannot go stale. A reconnect repopulates it from
        // the current profile in addClient().
        this.displayNameByUser.delete(clientState.userId);
      }
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
        state: buildAuthoritativeAwarenessState(parsed as Record<string, unknown>, {
          userId: clientState.userId,
          username: clientState.username,
          role: clientState.role,
          // M62-3: cached effective display name — no DB read here. Miss
          // (should not happen: addClient always populates) => username.
          displayName:
            this.displayNameByUser.get(clientState.userId) ??
            clientState.username,
        }),
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

  // buildAuthoritativeAwarenessState / sanitizeAwarenessFilePath / isAwarenessCoord
  // moved to ./presence.ts (M57). sanitizeIncomingAwarenessUpdate above still
  // owns the frame decode + clientID ownership/claim — the security boundary.


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

    // M60: a flush-to-disk is a burst-close boundary — history and disk should
    // agree on which files changed. Synchronous, in-memory only.
    this.historian.closeProjectBursts(this.projectId, "flush");

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
    // M60: close every open burst BEFORE `disposed` is set and the Y.Doc is
    // destroyed — synchronous, in-memory; the historian's own flush loop
    // persists them. Runs first so the "collab_change" broadcast (via the
    // historian's broadcaster) still finds live clients.
    this.historian.closeProjectBursts(this.projectId, "dispose");
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
    // M65: shared run-output teardown.
    for (const e of this.runOutput.values()) {
      if (e.flushTimer) clearTimeout(e.flushTimer);
    }
    this.runOutput.clear();
    this.displayNameByUser.clear();
    // M58: attention teardown.
    for (const t of this.attentionExpiryTimers.values()) clearTimeout(t);
    this.attentionExpiryTimers.clear();
    this.attentionRegistry.clear();
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

  /**
   * M65: publish one run-output fragment into a project's collaboration room.
   * The sole caller is the authenticated execution WebSocket lifecycle
   * (ws/execution.ts). No-op when no room is live. Owner/editor-only delivery
   * and the 256 KB bound are enforced in CollaborationRoom.
   */
  public notifyRunOutput(
    projectId: string,
    executionId: string,
    stream: "stdout" | "stderr",
    data: string,
  ): void {
    this.rooms.get(projectId)?.handleRunOutput(executionId, stream, data);
  }

  /**
   * M60: fan out a closed-burst / callout history event to a project's live
   * room. Wired as the `CollaborationHistorian` broadcaster in index.ts. A
   * no-op when no room is live (nobody to notify). Server-built payload only.
   */
  public broadcastCollabChange(
    projectId: string,
    ev: Record<string, unknown>,
  ): void {
    this.rooms.get(projectId)?.broadcastCollabChange(ev);
  }

  /**
   * M61-A: fan out a comment-lifecycle invalidation ping to a project's live
   * room. No-op when no room is live. Server-built payload only.
   */
  public broadcastCommentEvent(
    projectId: string,
    ev: Record<string, unknown>,
  ): void {
    this.rooms.get(projectId)?.broadcastCommentEvent(ev);
  }

  /** M61-A: deliver a `comment_mention` ping to one user in a project room. */
  public sendCommentMentionTo(
    projectId: string,
    userId: number,
    ev: Record<string, unknown>,
  ): void {
    this.rooms.get(projectId)?.sendCommentMentionTo(userId, ev);
  }

  /** M61-C: fan out a `profile_event` invalidation ping to a project room. */
  public broadcastProfileEvent(
    projectId: string,
    ev: Record<string, unknown>,
  ): void {
    this.rooms.get(projectId)?.broadcastProfileEvent(ev);
  }

  /**
   * M62-2/-3: a user edited their own profile identity. Targeted — only the
   * rooms that actually hold a live authenticated client for `userId` are
   * touched. Each such room re-resolves that user's cached effective display
   * name from the persisted profile, then fans out ONE existing
   * `{type:"profile_event", userId}` frame (no profile data in the packet).
   * Rooms without that user get nothing; zero matching rooms is a silent
   * no-op. Targeting lives here in the collaboration layer, never on the
   * client. No new wire message, no transport change.
   */
  public broadcastProfileEventForUser(userId: number): void {
    for (const room of this.rooms.values()) {
      room.refreshProfileIdentity(userId);
    }
  }

  /**
   * Push an external file mutation into a project's live room. Returns the
   * per-file {@link ExternalMutationResult}; when there is no room, the
   * mutation is trivially "applied" (nothing to converge, nothing to lose).
   * A `conflict: true` result means the room preserved unpersisted
   * collaborator edits and the caller MUST NOT report the write as applied.
   */
  public async notifyExternalFileMutation(
    projectId: string,
    filePath: string,
    newContent: string,
  ): Promise<ExternalMutationResult> {
    const room = this.rooms.get(projectId);
    if (room) {
      return room.handleExternalFileMutation(filePath, newContent);
    }
    return { applied: true, conflict: false };
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
