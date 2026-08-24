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

/** Rejects if the wrapped promise has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

  constructor(
    projectId: string,
    cfg: AppConfig,
    db: Db,
    onDispose: (projectId: string) => void,
  ) {
    this.projectId = projectId;
    this.cfg = cfg;
    this.db = db;
    this.onDisposeCallback = onDispose;

    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Track document updates for debounced disk persistence
    this.doc.on("update", (update: Uint8Array, origin: any) => {
      // Broadcast update to all other connected clients
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      for (const [client, _state] of this.clients.entries()) {
        if (client !== origin && client.readyState === 1 /* OPEN */) {
          try {
            client.send(message);
          } catch {}
        }
      }

      if (origin !== "external_mutation") {
        this.scheduleDebouncedPersistence();
      }
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

    // Track awareness changes and broadcast to room
    this.awareness.on(
      "update",
      ({ added, updated, removed }: any, origin: any) => {
        const changedClients = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            changedClients,
          ),
        );
        const message = encoding.toUint8Array(encoder);

        for (const [client] of this.clients.entries()) {
          if (client !== origin && client.readyState === 1) {
            try {
              client.send(message);
            } catch {}
          }
        }
      },
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
   */
  public async handleExternalFileMutation(
    filePath: string,
    newContent: string,
  ): Promise<void> {
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
    const clientState = this.clients.get(ws);
    this.clients.delete(ws);

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

    // If dirtyFiles is empty, flush all active non-empty text keys in doc
    if (filesToFlush.length === 0) {
      for (const [key, type] of (
        this.doc.share as Map<string, any>
      ).entries()) {
        if (type instanceof Y.Text) {
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
    if (this.idleDisposeTimer) clearTimeout(this.idleDisposeTimer);

    // Idle grace timer before freeing room from memory. On retry (a prior
    // flush left files dirty) the delay doubles, capped at
    // IDLE_DISPOSE_RETRY_CAP_MS, so a permanently failing write (disk full,
    // permissions lost, workspace removed without the project being deleted)
    // degrades to an infrequent retry instead of hammering the filesystem
    // and logs forever at a fixed 10s cadence. Content is never dropped —
    // only the retry cadence backs off.
    this.idleDisposeTimer = setTimeout(async () => {
      if (this.clients.size === 0) {
        await this.flushToDisk();
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxFlushTimer) clearTimeout(this.maxFlushTimer);
    if (this.idleDisposeTimer) clearTimeout(this.idleDisposeTimer);

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
      room = new CollaborationRoom(projectId, this.cfg, this.db, (pid) =>
        this.rooms.delete(pid),
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
  public flushAllRooms(options: { perRoomTimeoutMs?: number } = {}): Promise<void> {
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
