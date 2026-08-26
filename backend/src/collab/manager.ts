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

  /** Set at the start of dispose(). awareness.destroy() below internally
   *  calls setLocalState(null), which fires this room's own
   *  awareness "update" listener — without this guard that would re-arm
   *  awarenessCoalesceTimer via queueAwarenessUpdate() *after* dispose()'s
   *  timer-clearing block already ran, leaking one timer per disposal. */
  private disposed = false;

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
          const update = decoding.readVarUint8Array(decoder);
          // Capture the real awareness clientID(s) carried by THIS update so the
          // connection's presence can be cleaned up precisely on disconnect.
          const seen: number[] = [];
          const capture = (
            { added, updated }: { added: number[]; updated: number[] },
            origin: any,
          ) => {
            if (origin === ws) seen.push(...added, ...updated);
          };
          this.awareness.on("update", capture);
          try {
            awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
          } finally {
            this.awareness.off("update", capture);
          }
          this.attributeAwarenessClients(ws, clientState, seen);
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
              this.ensureFileLoaded(parsed.path);
              clientState.activeFile = parsed.path;
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

  /**
   * Records awareness clientIDs as belonging to a specific connection.
   * IDs already attributed to another live connection (or to the room's own doc)
   * are ignored, so a client can never cause removal of someone else's presence.
   */
  private attributeAwarenessClients(
    ws: WebSocket,
    clientState: CollaboratorClientState,
    clientIds: number[],
  ): void {
    for (const clientId of clientIds) {
      if (clientId === this.doc.clientID) continue;

      let ownedElsewhere = false;
      for (const [otherWs, otherState] of this.clients.entries()) {
        if (otherWs !== ws && otherState.awarenessClientIds?.has(clientId)) {
          ownedElsewhere = true;
          break;
        }
      }
      if (ownedElsewhere) continue;

      if (!clientState.awarenessClientIds) {
        clientState.awarenessClientIds = new Set<number>();
      }
      clientState.awarenessClientIds.add(clientId);
    }
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
