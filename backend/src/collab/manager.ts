import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { projectDir } from '../projects/service.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Reserved: y-protocols auth message type (received but not handled).
const _MESSAGE_AUTH = 2;
const MESSAGE_CUSTOM = 3;

export interface CollaboratorClientState {
  userId: number;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  activeFile?: string | null;
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
    onDispose: (projectId: string) => void
  ) {
    this.projectId = projectId;
    this.cfg = cfg;
    this.db = db;
    this.onDisposeCallback = onDispose;

    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Track document updates for debounced disk persistence
    this.doc.on('update', (update: Uint8Array, origin: any) => {
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

      if (origin !== 'external_mutation') {
        this.scheduleDebouncedPersistence();
      }
    });

    // Track awareness changes and broadcast to room
    this.awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      const message = encoding.toUint8Array(encoder);

      for (const [client] of this.clients.entries()) {
        if (client !== origin && client.readyState === 1) {
          try {
            client.send(message);
          } catch {}
        }
      }
    });
  }

  /**
   * Initializes a file's collaborative Y.Text from the workspace filesystem if not already loaded.
   */
  public async ensureFileLoaded(filePath: string): Promise<Y.Text> {
    const yText = this.doc.getText(filePath);
    if (yText.length === 0) {
      const fullPath = join(projectDir(this.cfg, this.projectId), filePath);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        // Only insert if Y.Text is still empty
        if (yText.length === 0) {
          this.doc.transact(() => {
            yText.insert(0, content);
          }, 'initial_disk_load');
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
  public async handleExternalFileMutation(filePath: string, newContent: string): Promise<void> {
    const yText = this.doc.getText(filePath);
    const currentContent = yText.toString();

    if (currentContent !== newContent) {
      this.doc.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, newContent);
      }, 'external_mutation');
    }

    this.dirtyFiles.delete(filePath);
  }

  /**
   * Adds an authenticated collaborator to the room and sends initial state vectors.
   */
  public async addClient(
    ws: WebSocket,
    clientState: CollaboratorClientState
  ): Promise<void> {
    if (this.idleDisposeTimer) {
      clearTimeout(this.idleDisposeTimer);
      this.idleDisposeTimer = null;
    }

    this.clients.set(ws, clientState);

    // Set initial awareness state for this client
    this.awareness.setLocalStateField('user', {
      id: clientState.userId,
      name: clientState.username,
      role: clientState.role,
      color: getUserColor(clientState.userId),
    });

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
          Array.from(awarenessStates.keys())
        )
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
          if (clientState.role === 'viewer' && syncType === syncProtocol.messageYjsUpdate) {
            console.warn(`[CollabRoom:${this.projectId}] Blocked edit attempt from viewer ${clientState.username}`);
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
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            ws
          );
          break;
        }

        case MESSAGE_CUSTOM: {
          // Custom JSON commands (e.g. file_open notification)
          const jsonStr = decoding.readVarString(decoder);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === 'file_open' && typeof parsed.path === 'string') {
              this.ensureFileLoaded(parsed.path);
              clientState.activeFile = parsed.path;
            }
          } catch {}
          break;
        }
      }
    } catch (err) {
      console.error(`[CollabRoom:${this.projectId}] Error handling message:`, err);
    }
  }

  /**
   * Handles client disconnection.
   */
  public removeClient(ws: WebSocket): void {
    const clientState = this.clients.get(ws);
    this.clients.delete(ws);

    // Remove client from awareness
    if (clientState) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [this.doc.clientID],
        null
      );
    }

    // If room is now empty, schedule a grace period before disposing
    if (this.clients.size === 0) {
      this.scheduleIdleDisposal();
    }
  }

  /**
   * Disconnects a specific user immediately upon role revocation.
   */
  public disconnectUser(userId: number): void {
    for (const [ws, state] of this.clients.entries()) {
      if (state.userId === userId) {
        try {
          ws.close(4403, 'Collaboration access revoked');
        } catch {}
        this.removeClient(ws);
      }
    }
  }

  /**
   * Marks a file as dirty and triggers debounced persistence to workspace filesystem.
   */
  public markFileDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
    this.scheduleDebouncedPersistence();
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
      for (const [key, type] of (this.doc.share as Map<string, any>).entries()) {
        if (type instanceof Y.Text) {
          filesToFlush.push(key);
        }
      }
    }

    for (const filePath of filesToFlush) {
      try {
        const yText = this.doc.getText(filePath);
        const content = yText.toString();
        const fullPath = join(baseDir, filePath);
        await fs.writeFile(fullPath, content, 'utf-8');
      } catch (err) {
        console.error(`[CollabRoom:${this.projectId}] Failed to persist ${filePath}:`, err);
      }
    }

    this.dirtyFiles.clear();
    this.lastFlushTime = Date.now();
  }

  private scheduleIdleDisposal(): void {
    if (this.idleDisposeTimer) clearTimeout(this.idleDisposeTimer);

    // 10s idle grace timer before freeing room from memory
    this.idleDisposeTimer = setTimeout(async () => {
      if (this.clients.size === 0) {
        await this.flushToDisk();
        this.dispose();
      }
    }, 10000);
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
        ws.close(1001, 'Room disposed');
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
        (pid) => this.rooms.delete(pid)
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
    newContent: string
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

  public getActiveRoomCount(): number {
    return this.rooms.size;
  }

  public async flushAllRooms(): Promise<void> {
    for (const room of this.rooms.values()) {
      await room.flushToDisk();
    }
  }
}

export const collaborationManager = CollaborationManager.getInstance();

const USER_COLORS = [
  '#89b4fa', // Blue
  '#a6e3a1', // Green
  '#fab387', // Peach
  '#f38ba8', // Red
  '#cba6f7', // Mauve
  '#f9e2af', // Yellow
  '#94e2d5', // Teal
  '#f5c2e7', // Pink
];

function getUserColor(userId: number): string {
  return USER_COLORS[Math.abs(userId) % USER_COLORS.length];
}
