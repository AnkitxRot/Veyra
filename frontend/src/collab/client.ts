import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MonacoBinding } from "y-monaco";
import { monaco } from "../monacoSetup";
import { User } from "../types";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Reserved: y-protocols auth message type (received but not handled).
const _MESSAGE_AUTH = 2;
const MESSAGE_CUSTOM = 3;

export type CollabConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resynchronizing"
  | "disconnected"
  | "forbidden";

export type AvailabilityStatus = "online" | "idle" | "dnd";

export type ActivityType =
  "viewing" | "editing" | "running" | "terminal" | "searching" | "reviewing";

export interface ActivityState {
  type: ActivityType;
  detail?: string | null;
  timestamp: number;
}

export interface SelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CollaboratorPresence {
  clientId: number;
  userId: number;
  name: string;
  role: "owner" | "editor" | "viewer";
  color: string;
  status: AvailabilityStatus;
  activity: ActivityState;
  activeFile?: string | null;
  cursor?: { line: number; column: number } | null;
  selection?: SelectionRange | null;
  lastActive: number;
}

// M52: how long a deferred y-monaco bind waits for the server's
// `file_ready` signal before force-completing anyway. Covers an older
// server that never sends the signal, or a lost message — the completion
// is still seed-free, so it stays duplication-proof either way.
const DEFERRED_BIND_FALLBACK_MS = 2000;

const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const BLUR_IDLE_TIMEOUT_MS = 60 * 1000; // 1 minute
const EDITING_HYSTERESIS_MS = 5 * 1000; // 5 seconds
const SELECTION_DEBOUNCE_MS = 50; // 50 milliseconds

export class CollaborationClient {
  public readonly projectId: string;
  public doc!: Y.Doc;
  public awareness!: awarenessProtocol.Awareness;
  public status: CollabConnectionStatus = "disconnected";

  private ws: WebSocket | null = null;
  private currentBinding: MonacoBinding | null = null;
  private boundModel: monaco.editor.ITextModel | null = null;
  private boundEditor: monaco.editor.IStandaloneCodeEditor | null = null;
  private activeFilePath: string | null = null;

  // M52: per-path readiness. A path enters this set when the server sends
  // `{type:"file_ready"}` for it — meaning the room has finished loading
  // that file from disk into its Y.Text, so the server content is now
  // authoritative and it is safe to construct the y-monaco binding.
  private readyFiles = new Set<string>();

  // M52: a y-monaco bind that is waiting for `file_ready` (or the fallback
  // timer). Only ever holds the single most-recent deferred bind; a newer
  // bindMonacoModel call for a different file supersedes it.
  private pendingBind: {
    filePath: string;
    model: monaco.editor.ITextModel;
    editor: monaco.editor.IStandaloneCodeEditor;
    // model value captured when the defer was recorded — used to detect
    // whether the user made local edits during the defer window.
    originalValue: string;
    // true when this defer originated from resetLocalCollabState: the
    // stale model content must be discarded, never dirty-re-applied.
    fromReset: boolean;
    timer: any;
  } | null = null;
  private readonly listeners: Map<string, Set<(...args: any[]) => void>> =
    new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private isDisposed = false;
  private user: User;

  // Activity & Availability state machine
  private availability: AvailabilityStatus = "online";
  private isManualDnd = false;
  private currentActivity: ActivityState = {
    type: "viewing",
    detail: null,
    timestamp: Date.now(),
  };

  // Timers for state transitions
  private idleTimer: any = null;
  private blurTimer: any = null;
  private editHysteresisTimer: any = null;
  private selectionTimer: any = null;
  private cursorTimer: number | null = null;

  // Bound window listener references for clean removal on disposal
  private handleUserInteractionBound = () => this.handleUserInteraction();
  private handleWindowBlurBound = () => this.handleWindowBlur();
  private handleWindowFocusBound = () => this.handleWindowFocus();

  constructor(projectId: string, user: User) {
    this.projectId = projectId;
    this.user = user;
    this.initDocAndAwareness();
    this.initActivityListeners();
    this.connect();
  }

  // M40: factored out of the constructor so a fresh Y.Doc/Awareness lineage
  // can also be created after an explicit server-initiated room disposal
  // (see resetLocalCollabState) — never just by clearing the existing
  // Y.Text in place, which would keep the same CRDT lineage and merge
  // rather than replace when synced against the server's own fresh doc.
  private initDocAndAwareness(): void {
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Configure user awareness with M48 rich presence fields
    this.awareness.setLocalStateField("user", {
      id: this.user.id,
      name: this.user.username,
      color: getUserColor(this.user.id),
      role: this.user.role === "admin" ? "owner" : "editor",
    });
    this.awareness.setLocalStateField("status", this.availability);
    this.awareness.setLocalStateField("activity", this.currentActivity);
    this.awareness.setLocalStateField("lastActive", Date.now());

    // Notify local listeners when awareness changes
    this.awareness.on("change", () => {
      this.emit("awareness_change", this.getOnlineCollaborators());
    });

    // 1. Transmit local document updates to server
    this.doc.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        this.send(encoding.toUint8Array(encoder));
      }
    });

    // 2. Transmit local awareness updates to server
    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: any,
      ) => {
        if (origin !== this) {
          const changedClients = added.concat(updated).concat(removed);
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
              this.awareness,
              changedClients,
            ),
          );
          this.send(encoding.toUint8Array(encoder));
        }
      },
    );
  }

  // --- Local Activity & Availability State Machine ---

  private initActivityListeners(): void {
    if (typeof window === "undefined") return;

    window.addEventListener("mousemove", this.handleUserInteractionBound, {
      passive: true,
    });
    window.addEventListener("keydown", this.handleUserInteractionBound, {
      passive: true,
    });
    window.addEventListener("click", this.handleUserInteractionBound, {
      passive: true,
    });
    window.addEventListener("scroll", this.handleUserInteractionBound, {
      passive: true,
    });
    window.addEventListener("blur", this.handleWindowBlurBound);
    window.addEventListener("focus", this.handleWindowFocusBound);

    this.resetIdleTimer();
  }

  private removeActivityListeners(): void {
    if (typeof window === "undefined") return;

    window.removeEventListener("mousemove", this.handleUserInteractionBound);
    window.removeEventListener("keydown", this.handleUserInteractionBound);
    window.removeEventListener("click", this.handleUserInteractionBound);
    window.removeEventListener("scroll", this.handleUserInteractionBound);
    window.removeEventListener("blur", this.handleWindowBlurBound);
    window.removeEventListener("focus", this.handleWindowFocusBound);
  }

  private handleUserInteraction(): void {
    if (this.isDisposed) return;
    this.resetIdleTimer();

    if (!this.isManualDnd && this.availability === "idle") {
      this.setAvailability("online");
    }
  }

  private handleWindowBlur(): void {
    if (this.isDisposed || this.isManualDnd) return;
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = setTimeout(() => {
      if (!this.isDisposed && !this.isManualDnd) {
        this.setAvailability("idle");
      }
    }, BLUR_IDLE_TIMEOUT_MS);
  }

  private handleWindowFocus(): void {
    if (this.isDisposed) return;
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    if (!this.isManualDnd && this.availability === "idle") {
      this.setAvailability("online");
    }
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.isDisposed && !this.isManualDnd) {
        this.setAvailability("idle");
      }
    }, IDLE_TIMEOUT_MS);
  }

  public setAvailability(status: AvailabilityStatus): void {
    if (this.isDisposed) return;
    this.availability = status;
    this.awareness.setLocalStateField("status", status);
    this.awareness.setLocalStateField("lastActive", Date.now());
  }

  public setDnd(enabled: boolean): void {
    this.isManualDnd = enabled;
    this.setAvailability(enabled ? "dnd" : "online");
  }

  public getDnd(): boolean {
    return this.isManualDnd;
  }

  public setActivity(type: ActivityType, detail?: string | null): void {
    if (this.isDisposed) return;
    if (this.editHysteresisTimer) {
      clearTimeout(this.editHysteresisTimer);
      this.editHysteresisTimer = null;
    }

    this.currentActivity = {
      type,
      detail:
        detail ??
        (type === "viewing" || type === "editing" ? this.activeFilePath : null),
      timestamp: Date.now(),
    };
    this.awareness.setLocalStateField("activity", this.currentActivity);
    this.awareness.setLocalStateField("lastActive", Date.now());
  }

  public recordEdit(): void {
    if (this.isDisposed) return;
    this.handleUserInteraction();

    if (
      this.currentActivity.type !== "editing" ||
      this.currentActivity.detail !== this.activeFilePath
    ) {
      this.setActivity("editing", this.activeFilePath);
    } else {
      this.awareness.setLocalStateField("lastActive", Date.now());
    }

    if (this.editHysteresisTimer) clearTimeout(this.editHysteresisTimer);
    this.editHysteresisTimer = setTimeout(() => {
      if (!this.isDisposed && this.currentActivity.type === "editing") {
        this.setActivity("viewing", this.activeFilePath);
      }
    }, EDITING_HYSTERESIS_MS);
  }

  public restoreActivity(): void {
    if (this.isDisposed) return;
    this.setActivity("viewing", this.activeFilePath);
  }

  public updateSelection(selection: SelectionRange | null): void {
    if (this.isDisposed) return;
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      if (!this.isDisposed) {
        this.awareness.setLocalStateField("selection", selection);
      }
    }, SELECTION_DEBOUNCE_MS);
  }

  // M40: called when the server has explicitly torn down this project's
  // collaboration room (import/replace, workspace or snapshot restore,
  // project delete) while this client was actively connected — signaled by
  // a 1001 close code received in the "connected" state (see ws.onclose;
  // idle-timeout disposal never fires while a client is connected, so this
  // signal is unambiguous). The old Y.Doc/Awareness lineage is discarded
  // entirely (never merged, never used to seed the new one) so the next
  // connect() starts from a genuinely blank state and the server's fresh,
  // disk-backed content becomes authoritative once synced in. Any unsaved
  // local edits in the old lineage are intentionally lost, matching the
  // same-source-wins policy already established for project switches (M28)
  // and external mutations (M37-M39).
  private resetLocalCollabState(): void {
    const staleModel = this.boundModel;
    const staleEditor = this.boundEditor;
    const staleFilePath = this.activeFilePath;

    // Detach the y-monaco binding from the doomed doc/Y.Text BEFORE
    // destroying them — a live binding must never be left observing (or
    // writing into) a destroyed Y.Doc.
    this.unbindCurrentModel();
    this.clearPendingBind();

    try {
      this.awareness.destroy();
    } catch {}
    try {
      this.doc.destroy();
    } catch {}

    // M52: the fresh lineage's Y.Texts are empty again, and the server will
    // re-load every file from disk and re-signal `file_ready`. Any stale
    // readiness from the discarded lineage must not carry over, or the
    // rebind below would bind immediately to an empty Y.Text and briefly
    // show a blank editor as authoritative.
    this.readyFiles.clear();

    this.initDocAndAwareness();

    // Rebind the same Monaco model/editor to the fresh, empty Y.Text so the
    // file stays live once reconnected. Seeding no longer exists anywhere
    // (M52), so this goes through the identical no-seed path as a normal
    // open: the new Y.Text is empty and not ready, so the bind defers and
    // waits for the server's fresh `file_ready`. The stale model content is
    // discarded, never merged (the M40 guarantee) — and never dirty-re-
    // applied either, because attachBinding is told this bind originated
    // from a reset (fromReset=true), so the M52 dirty-at-bind policy is
    // suppressed for it.
    if (
      staleModel &&
      staleEditor &&
      staleFilePath &&
      !staleModel.isDisposed()
    ) {
      this.attachBinding(staleFilePath, staleModel, staleEditor, true);
    }
  }

  public connect(): void {
    if (this.isDisposed) return;
    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/collab?projectId=${encodeURIComponent(this.projectId)}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus("connected");

        // 1. Send Sync Step 1 (Client state vector)
        const syncEncoder = encoding.createEncoder();
        encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(syncEncoder, this.doc);
        this.send(encoding.toUint8Array(syncEncoder));

        // 2. Broadcast local awareness
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID,
          ]),
        );
        this.send(encoding.toUint8Array(awarenessEncoder));

        // 3. Notify active file if any
        if (this.activeFilePath) {
          this.notifyFileOpen(this.activeFilePath);
        }
      };

      this.ws.onmessage = (event) => {
        const u8 = new Uint8Array(event.data);
        this.handleMessage(u8);
      };

      this.ws.onclose = (event) => {
        if (event.code === 4403 || event.code === 4003) {
          this.setStatus("forbidden");
          return;
        }

        // M40 — CLASS A vs CLASS B reconnects: a close code of 1001
        // received while this client was actively "connected" can only
        // originate from an explicit, intentional CollaborationRoom
        // .dispose() call on the server (import/replace, workspace or
        // snapshot restore, project delete). Idle-timeout disposal never
        // fires while any client is connected (scheduleIdleDisposal only
        // arms when the room's client set is empty), so this signal is
        // unambiguous — it never fires for an ordinary network blip, which
        // instead surfaces as some other close code (or none at all) and
        // must keep using the existing offline delta reconciliation
        // (Class B), preserving local edits exactly as before.
        const wasExplicitDisposal =
          event.code === 1001 && this.status === "connected";

        this.setStatus("disconnected");

        if (wasExplicitDisposal && !this.isDisposed) {
          this.resetLocalCollabState();
        }

        if (!this.isDisposed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.setStatus("disconnected");
      };
    } catch {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  private handleMessage(message: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
          if (encoding.length(encoder) > 1) {
            this.send(encoding.toUint8Array(encoder));
          }
          break;
        }

        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            this,
          );
          break;
        }

        case MESSAGE_CUSTOM: {
          // M52: the server's readiness signal. Until now the client never
          // handled MESSAGE_CUSTOM at all (it only ever sends them).
          const jsonStr = decoding.readVarString(decoder);
          try {
            const parsed = JSON.parse(jsonStr);
            if (
              parsed &&
              parsed.type === "file_ready" &&
              typeof parsed.path === "string"
            ) {
              this.handleFileReady(parsed.path);
            }
          } catch {}
          break;
        }
      }
    } catch (err) {
      console.error("[CollabClient] Error handling message:", err);
    }
  }

  public notifyFileOpen(filePath: string): void {
    this.activeFilePath = filePath;
    this.awareness.setLocalStateField("activeFile", filePath);
    this.setActivity("viewing", filePath);

    // Send custom message to server
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_CUSTOM);
    encoding.writeVarString(
      encoder,
      JSON.stringify({ type: "file_open", path: filePath }),
    );
    this.send(encoding.toUint8Array(encoder));
  }

  /**
   * Binds Monaco Model to collaborative Y.Text
   */
  public bindMonacoModel(
    filePath: string,
    model: monaco.editor.ITextModel,
    editor: monaco.editor.IStandaloneCodeEditor,
    _isReadOnly: boolean = false,
  ): void {
    // A disposed client's doc/awareness/ws are already torn down. A stale
    // React prop reference could still reach this call in the brief window
    // between a project switch's cleanup and the new client replacing it in
    // state; without this guard it would seed the destroyed Y.Doc from
    // whatever model content happened to be passed in and build a binding
    // that can never sync anywhere.
    if (this.isDisposed) return;

    // Callers (Editor.tsx's model-management effect) re-run on every
    // keystroke because `openFiles` gets a new array/object reference per
    // edit. Without this guard, every keystroke would tear down and rebuild
    // the y-monaco binding and re-send a file_open message to the server.
    if (
      this.boundModel === model &&
      this.activeFilePath === filePath &&
      this.currentBinding
    ) {
      return;
    }

    // M52: a deferred bind is already in flight for this same model/path —
    // a per-keystroke re-call must not restart the defer (which would
    // re-capture originalValue and lose the dirty-window detection).
    if (
      this.pendingBind &&
      this.pendingBind.filePath === filePath &&
      this.pendingBind.model === model
    ) {
      return;
    }

    this.attachBinding(filePath, model, editor, false);
  }

  // M52: shared by the normal bindMonacoModel() call and
  // resetLocalCollabState's internal rebind after an explicit-disposal
  // reconnect. Seeding the shared Y.Text from the local Monaco model no
  // longer happens anywhere — it raced the server's own disk load of the
  // same file (both "is the Y.Text empty?" guards passed inside the race
  // window) and duplicated the file's content to "XX" on disk. Instead the
  // binding is constructed immediately only when the server content is
  // already authoritative (Y.Text non-empty, or the server has sent
  // `file_ready` for this path); otherwise it is deferred until
  // `file_ready` arrives (or the fallback timer fires). `fromReset`
  // distinguishes the reset rebind, whose stale model content must be
  // discarded rather than dirty-re-applied when the deferred bind completes.
  private attachBinding(
    filePath: string,
    model: monaco.editor.ITextModel,
    editor: monaco.editor.IStandaloneCodeEditor,
    fromReset: boolean,
  ): void {
    this.unbindCurrentModel();
    this.clearPendingBind();

    this.activeFilePath = filePath;
    this.notifyFileOpen(filePath);

    const yText = this.doc.getText(filePath);

    if (yText.length > 0 || this.readyFiles.has(filePath)) {
      // Server content is authoritative and already present — bind now.
      // This first bind is synchronous with the model's disk-content
      // creation, so it is always clean: no dirty re-apply.
      this.completeBind(filePath, model, editor, false, "");
      return;
    }

    // Defer: wait for the server's `file_ready` (or the fallback timer).
    this.pendingBind = {
      filePath,
      model,
      editor,
      originalValue: model.getValue(),
      fromReset,
      timer: setTimeout(
        () => this.completeDeferredBind(filePath),
        DEFERRED_BIND_FALLBACK_MS,
      ),
    };
  }

  // M52: force-complete a deferred bind — from the incoming `file_ready`
  // custom message or from the fallback timer.
  private completeDeferredBind(filePath: string): void {
    if (this.isDisposed) return;
    if (!this.pendingBind || this.pendingBind.filePath !== filePath) return;
    const { model, editor, originalValue, fromReset, timer } = this.pendingBind;
    clearTimeout(timer);
    this.pendingBind = null;
    if (model.isDisposed()) return;
    // Dirty-at-bind check runs only when this was NOT a reset rebind.
    this.completeBind(filePath, model, editor, !fromReset, originalValue);
  }

  private handleFileReady(path: string): void {
    if (this.isDisposed) return;
    this.readyFiles.add(path);
    if (this.pendingBind && this.pendingBind.filePath === path) {
      this.completeDeferredBind(path);
    }
  }

  private clearPendingBind(): void {
    if (this.pendingBind) {
      clearTimeout(this.pendingBind.timer);
      this.pendingBind = null;
    }
  }

  // M52: constructs the y-monaco binding (the MonacoBinding ctor overwrites
  // the model FROM the Y.Text) and wires decoration-safe re-rendering.
  // When `isDeferred`, applies the Phase-7 dirty-at-bind policy: if the
  // user edited the model during the defer window (its value diverged from
  // `originalValue` captured when the defer was recorded), the local buffer
  // wins and is re-applied once via model.setValue — y-monaco then
  // propagates it as a single full-replace edit into the Y.Text, so the
  // authoritative base content is represented once and the user edit is
  // preserved. When not deferred (or the deferred bind came from a reset),
  // the authoritative Y.Text content wins and nothing extra is done.
  private completeBind(
    filePath: string,
    model: monaco.editor.ITextModel,
    editor: monaco.editor.IStandaloneCodeEditor,
    isDeferred: boolean,
    originalValue: string,
  ): void {
    if (this.isDisposed) return;

    const yText = this.doc.getText(filePath);
    // Capture BEFORE constructing the binding — the ctor overwrites the
    // model from the Y.Text.
    const localValue = model.getValue();

    try {
      const binding = new MonacoBinding(
        yText,
        model,
        new Set([editor]),
        this.awareness,
      );

      // Defer decoration re-rendering to next animation frame and guard against
      // re-entrant deltaDecorations calls triggered by Monaco cursor selection events.
      const origRerender = (binding as any)._rerenderDecorations;
      if (typeof origRerender === "function") {
        let isRerendering = false;
        let pendingRaf: number | null = null;
        const safeRerender = () => {
          if (isRerendering) return;
          if (pendingRaf !== null) return;
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = null;
            if (
              !this.isDisposed &&
              this.currentBinding === binding &&
              !isRerendering
            ) {
              isRerendering = true;
              try {
                origRerender();
              } catch {
              } finally {
                isRerendering = false;
              }
            }
          });
        };

        (binding as any)._rerenderDecorations = safeRerender;
        if (this.awareness) {
          this.awareness.off("change", origRerender);
          this.awareness.on("change", safeRerender);
        }
      }

      this.currentBinding = binding;
      this.boundModel = model;
      this.boundEditor = editor;

      // M52 Phase-7 dirty-at-bind policy (deferred binds only): local
      // buffer wins if the user edited during the defer window.
      if (
        isDeferred &&
        localValue !== originalValue &&
        localValue !== model.getValue()
      ) {
        model.setValue(localValue);
      }
    } catch (err) {
      console.error("[CollabClient] Failed to bind Monaco editor:", err);
    }
  }

  public unbindCurrentModel(): void {
    this.boundModel = null;
    this.boundEditor = null;
    if (this.currentBinding) {
      try {
        this.currentBinding.destroy();
      } catch {}
      this.currentBinding = null;
    }
  }

  public getOnlineCollaborators(): CollaboratorPresence[] {
    const states = this.awareness.getStates();
    const collaborators: CollaboratorPresence[] = [];

    for (const [clientId, state] of states.entries()) {
      if (state && state.user && typeof state.user === "object") {
        const rawActivity = state.activity;
        const activity: ActivityState =
          rawActivity && typeof rawActivity.type === "string"
            ? {
                type: rawActivity.type as ActivityType,
                detail:
                  typeof rawActivity.detail === "string"
                    ? rawActivity.detail
                    : null,
                timestamp:
                  typeof rawActivity.timestamp === "number"
                    ? rawActivity.timestamp
                    : Date.now(),
              }
            : {
                type: "viewing",
                detail: state.activeFile || null,
                timestamp: Date.now(),
              };

        const rawSelection = state.selection;
        const selection: SelectionRange | null =
          rawSelection &&
          typeof rawSelection.startLine === "number" &&
          typeof rawSelection.startColumn === "number" &&
          typeof rawSelection.endLine === "number" &&
          typeof rawSelection.endColumn === "number"
            ? {
                startLine: rawSelection.startLine,
                startColumn: rawSelection.startColumn,
                endLine: rawSelection.endLine,
                endColumn: rawSelection.endColumn,
              }
            : null;

        collaborators.push({
          clientId,
          userId: Number(state.user.id) || 0,
          name:
            typeof state.user.name === "string" ? state.user.name : "Anonymous",
          role:
            state.user.role === "owner" || state.user.role === "viewer"
              ? state.user.role
              : "editor",
          color:
            typeof state.user.color === "string"
              ? state.user.color
              : getUserColor(state.user.id || 0),
          status:
            state.status === "idle" || state.status === "dnd"
              ? state.status
              : "online",
          activity,
          activeFile:
            typeof state.activeFile === "string" ? state.activeFile : null,
          cursor:
            state.cursor &&
            typeof state.cursor.line === "number" &&
            typeof state.cursor.column === "number"
              ? { line: state.cursor.line, column: state.cursor.column }
              : null,
          selection,
          lastActive:
            typeof state.lastActive === "number"
              ? state.lastActive
              : Date.now(),
        });
      }
    }

    return collaborators;
  }

  public updateCursorPosition(line: number, column: number): void {
    if (this.cursorTimer !== null) {
      cancelAnimationFrame(this.cursorTimer);
    }
    this.cursorTimer = requestAnimationFrame(() => {
      this.cursorTimer = null;
      if (!this.isDisposed) {
        this.awareness.setLocalStateField("cursor", { line, column });
        this.awareness.setLocalStateField("lastActive", Date.now());
      }
    });
  }

  private send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
      } catch {}
    }
  }

  private setStatus(s: CollabConnectionStatus): void {
    this.status = s;
    this.emit("connection_change", s);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  public on(event: string, handler: (...args: any[]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(...args);
        } catch {}
      }
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.blurTimer) clearTimeout(this.blurTimer);
    if (this.editHysteresisTimer) clearTimeout(this.editHysteresisTimer);
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    if (this.cursorTimer !== null) {
      cancelAnimationFrame(this.cursorTimer);
      this.cursorTimer = null;
    }
    this.removeActivityListeners();
    this.clearPendingBind();
    this.unbindCurrentModel();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.awareness.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }
}

const USER_COLORS = [
  "#89b4fa", // Blue
  "#a6e3a1", // Green
  "#fab387", // Peach
  "#f38ba8", // Red
  "#cba6f7", // Mauve
  "#f9e2af", // Yellow
  "#94e2d5", // Teal
  "#f5c2e7", // Pink
];

export function getUserColor(userId: number): string {
  return USER_COLORS[Math.abs(userId) % USER_COLORS.length];
}
