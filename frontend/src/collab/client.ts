import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MonacoBinding } from "y-monaco";
import { monaco } from "../monacoSetup";
import { User, RunStatusEntry } from "../types";
import {
  getUserColor,
  readPresenceState,
  deriveWorkingFolder,
  type CollaboratorPresence,
  type AvailabilityStatus,
  type ActivityType,
  type ActivityState,
  type SelectionRange,
} from "./presence";
import { AttentionStore, type AttentionRange } from "./attention";

// M57: the presence model now lives in ./presence.ts. Re-exported here so the
// many existing `import { CollaboratorPresence } from "../../collab/client"`
// call sites keep working.
export {
  getUserColor,
  readPresenceState,
  deriveWorkingFolder,
  formatRelativeTime,
  collaboratorsInFile,
  collaboratorsInFolder,
  groupCollaboratorsByFolder,
} from "./presence";
export type {
  CollaboratorPresence,
  AvailabilityStatus,
  ActivityType,
  ActivityState,
  SelectionRange,
  CollaboratorIntent,
} from "./presence";

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

/** M56: bounded metadata-only notice that an external mutation touched a file. */
export type MutationType =
  | "replace"
  | "git_checkout"
  | "workspace_restore"
  | "workspace_import"
  | "snapshot_restore"
  | "upload";

export interface ExternalMutationNotice {
  type: "external_mutation_notice";
  path: string | null;
  mutationType: MutationType;
  actor: { userId: number; username: string };
  timestamp: number;
  matchCount?: number;
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
const NAVIGATION_HYSTERESIS_MS = 2500; // M57: "navigating" reverts to "viewing"

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

  // M56: the client's own "active file has unsaved local edits" bit, mirrored
  // into awareness. Tracked here so redundant setLocalStateField calls (one
  // per keystroke) are suppressed. Cleared on file switch / save / reset.
  private localActiveFileDirty = false;

  // M57: the client's own last-emitted intent text, so a repeat setIntent()
  // with unchanged text is a no-op. Cleared on reset.
  private localIntentText = "";

  // M52: per-path readiness. A path enters this set when the server sends
  // `{type:"file_ready"}` for it — meaning the room has finished loading
  // that file from disk into its Y.Text, so the server content is now
  // authoritative and it is safe to construct the y-monaco binding.
  private readyFiles = new Set<string>();

  // M54: collaborative run awareness. RECEIVE-ONLY — populated exclusively
  // from the server's `run_status` broadcasts (which the server derives from
  // the real, authenticated execution lifecycle). Keyed by server executionId.
  private runStatuses = new Map<string, RunStatusEntry>();

  // M58: transient attention events (Point / Callout / targeted "Come look").
  // RECEIVE-authoritative — the server stamps id/author/createdAt/expiresAt;
  // this store only renders and locally expires point/callout events. Lives at
  // the transport level (not per Y.Doc lineage) and is cleared on explicit
  // disposal reset and on dispose().
  public readonly attentionStore = new AttentionStore();

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

  // M60: epoch ms of the most recent transition to "disconnected", so the
  // next successful reconnect can emit `reconnected_after_gap` with how long
  // the client was offline (only the TRIGGER for While-You-Were-Away — the
  // authoritative content boundary is the server's collab_last_seen).
  private disconnectedAt: number | null = null;

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
  private navHysteresisTimer: any = null;
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
    this.attentionStore.onChange(() =>
      this.emit("attention_change", this.attentionStore.list()),
    );
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

    // Configure user awareness with M48 rich presence fields.
    // M55: the server no longer trusts the identity a client encodes here —
    // every inbound awareness update is rebuilt server-side so `user.id` /
    // `user.name` / `user.role` are forced to the authenticated session
    // before rebroadcast (only `user.color` and the ephemeral fields survive
    // as sent). This local state is still set for the client's own instant
    // self-render; peers only ever see the server-stamped identity.
    this.awareness.setLocalStateField("user", {
      id: this.user.id,
      name: this.user.username,
      color: getUserColor(this.user.id),
      role: this.user.role === "admin" ? "owner" : "editor",
    });
    this.awareness.setLocalStateField("status", this.availability);
    this.awareness.setLocalStateField("activity", this.currentActivity);
    this.awareness.setLocalStateField("lastActive", Date.now());
    // M57: a fresh lineage carries no workingFolder/intent — exactly like
    // `activeFile`, which is also not seeded here. The rebind after an
    // explicit-disposal reset re-sends `activeFile` via notifyFileOpen(),
    // which re-derives workingFolder; intent is re-emitted by the next
    // setIntent() (its tracker is reset alongside).
    this.awareness.setLocalStateField("workingFolder", null);
    this.awareness.setLocalStateField("intent", null);

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

    if (!this.isManualDnd && (this.availability === "idle" || this.availability === "away")) {
      this.setAvailability("online");
    }
  }

  private handleWindowBlur(): void {
    if (this.isDisposed || this.isManualDnd) return;
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = setTimeout(() => {
      if (!this.isDisposed && !this.isManualDnd) {
        // M57: window-blur → "away" (distinct from "idle" = no interaction
        // while the window is still focused).
        this.setAvailability("away");
      }
    }, BLUR_IDLE_TIMEOUT_MS);
  }

  private handleWindowFocus(): void {
    if (this.isDisposed) return;
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    if (!this.isManualDnd && (this.availability === "idle" || this.availability === "away")) {
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

    if (this.navHysteresisTimer) {
      clearTimeout(this.navHysteresisTimer);
      this.navHysteresisTimer = null;
    }

    this.currentActivity = {
      type,
      detail:
        detail ??
        (type === "viewing" || type === "editing" || type === "navigating"
          ? this.activeFilePath
          : null),
      timestamp: Date.now(),
    };
    this.awareness.setLocalStateField("activity", this.currentActivity);
    this.awareness.setLocalStateField("lastActive", Date.now());
  }

  // M57: observable navigation (file-tree click / tab switch without an edit)
  // → a short-lived "navigating" activity that reverts to "viewing". Never
  // overrides an in-flight "editing" state.
  public recordNavigation(): void {
    if (this.isDisposed) return;
    this.handleUserInteraction();
    if (this.currentActivity.type === "editing") return;
    this.setActivity("navigating", this.activeFilePath);
    if (this.navHysteresisTimer) clearTimeout(this.navHysteresisTimer);
    this.navHysteresisTimer = setTimeout(() => {
      if (!this.isDisposed && this.currentActivity.type === "navigating") {
        this.setActivity("viewing", this.activeFilePath);
      }
    }, NAVIGATION_HYSTERESIS_MS);
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

  /**
   * M57: set THIS client's user-declared intent — a single human-authored
   * line. Cleaned + bounded (≤120, control chars stripped, whitespace
   * collapsed) to mirror the server sanitizer. Empty ⇒ clears the field. A
   * no-op when the cleaned text is unchanged so a keystroke-driven caller is
   * cheap. Never auto-generated.
   */
  public setIntent(text: string | null): void {
    if (this.isDisposed) return;
    let cleaned = "";
    for (const ch of text ?? "") {
      const code = ch.charCodeAt(0);
      cleaned += code < 0x20 || code === 0x7f ? " " : ch;
    }
    cleaned = cleaned.replace(/\s+/g, " ").trim().slice(0, 120);
    if (cleaned === this.localIntentText) return;
    this.localIntentText = cleaned;
    this.awareness.setLocalStateField(
      "intent",
      cleaned ? { text: cleaned, updatedAt: Date.now() } : null,
    );
    this.awareness.setLocalStateField("lastActive", Date.now());
  }

  /**
   * M56: report whether THIS client's active file has unsaved local buffer
   * edits. Driven by the active editor tab's dirty flag. A no-op when the
   * value is unchanged so a per-keystroke caller is cheap.
   */
  public setActiveFileDirty(dirty: boolean): void {
    if (this.isDisposed) return;
    if (this.localActiveFileDirty === dirty) return;
    this.localActiveFileDirty = dirty;
    this.awareness.setLocalStateField("activeFileDirty", dirty);
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

  // --- M58: transient attention senders ---------------------------------
  //
  // Each builds a MESSAGE_CUSTOM JSON frame exactly like notifyFileOpen. The
  // server stamps the authoritative id/author/createdAt/expiresAt and (for
  // point/callout) broadcasts to peers only — the author does not render their
  // own point/callout. A request is echoed back to the author by the server so
  // the tray can show "✓ Sent".

  private sendAttentionFrame(obj: Record<string, unknown>): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_CUSTOM);
    encoding.writeVarString(encoder, JSON.stringify(obj));
    this.send(encoding.toUint8Array(encoder));
  }

  public sendAttentionPoint(file: string, range: AttentionRange): void {
    if (this.isDisposed) return;
    this.sendAttentionFrame({ type: "attention_point", file, range });
  }

  public sendAttentionCallout(
    file: string,
    range: AttentionRange,
    message: string,
  ): void {
    if (this.isDisposed) return;
    this.sendAttentionFrame({
      type: "attention_callout",
      file,
      range,
      message,
    });
  }

  public sendAttentionRequest(
    targetUserId: number,
    file: string,
    range: AttentionRange,
    message: string,
  ): void {
    if (this.isDisposed) return;
    this.sendAttentionFrame({
      type: "attention_request",
      targetUserId,
      file,
      range,
      message,
    });
  }

  public dismissAttentionRequest(id: string, acted?: boolean): void {
    if (this.isDisposed) return;
    this.sendAttentionFrame({ type: "attention_dismiss", id, acted });
    // Optimistic local removal — the server confirms with attention_cleared.
    this.attentionStore.dismissLocal(id);
  }

  public getAttention() {
    return this.attentionStore.list();
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
    // M58: an explicit server disposal discards every transient attention
    // event — "stale attention does not resurrect". The server's fresh
    // addClient snapshot re-sends any still-valid request targeted at this user.
    this.attentionStore.clear();
    // M56: the fresh awareness lineage has no dirty bit; reset the tracker so
    // the next setActiveFileDirty() re-emits it.
    this.localActiveFileDirty = false;
    // M57: same for the intent tracker — the fresh lineage has no intent, so
    // the next setIntent() must re-emit even if the text is unchanged.
    this.localIntentText = "";
    if (this.navHysteresisTimer) {
      clearTimeout(this.navHysteresisTimer);
      this.navHysteresisTimer = null;
    }
    // M54: the disposed room's run-status registry is gone; the fresh room's
    // addClient snapshot will re-populate any genuinely-active runs.
    if (this.runStatuses.size > 0) {
      this.runStatuses.clear();
      this.emit("run_status_change", this.getRunStatuses());
    }

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
        // M60: surface a real reconnect-after-gap so IDE.tsx can decide
        // whether to fetch While-You-Were-Away.
        if (this.disconnectedAt !== null) {
          const offlineMs = Date.now() - this.disconnectedAt;
          this.disconnectedAt = null;
          this.emit("reconnected_after_gap", { offlineMs });
        }
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

        // M60: record the start of an offline window (first close only — a
        // reconnect that fails again must not reset the clock).
        if (this.disconnectedAt === null && !this.isDisposed) {
          this.disconnectedAt = Date.now();
        }

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
          // M52: the server's readiness signal. M54: the server's run-status
          // broadcasts. Both are RECEIVE-only — the client never authors a
          // run_status message, so a peer cannot fabricate a run.
          const jsonStr = decoding.readVarString(decoder);
          try {
            const parsed = JSON.parse(jsonStr);
            if (
              parsed &&
              parsed.type === "file_ready" &&
              typeof parsed.path === "string"
            ) {
              this.handleFileReady(parsed.path);
            } else if (
              parsed &&
              parsed.type === "run_status" &&
              typeof parsed.executionId === "string"
            ) {
              this.handleRunStatusMessage(parsed);
            } else if (
              parsed &&
              parsed.type === "external_mutation_notice" &&
              (typeof parsed.path === "string" || parsed.path === null) &&
              typeof parsed.mutationType === "string" &&
              parsed.actor &&
              typeof parsed.actor.username === "string"
            ) {
              // M56: RECEIVE-only, exactly like file_ready / run_status —
              // the client never authors this, so a peer cannot fabricate it.
              this.emit(
                "external_mutation_notice",
                parsed as ExternalMutationNotice,
              );
            } else if (
              parsed &&
              (parsed.type === "attention_event" ||
                parsed.type === "attention_cleared")
            ) {
              // M58: RECEIVE-only. The store shape-guards and locally expires.
              this.attentionStore.apply(parsed);
            } else if (parsed && parsed.type === "attention_rate_limited") {
              // Transient sender-side "too many pending requests" indication.
              this.emit("attention_rate_limited", parsed);
            } else if (
              parsed &&
              parsed.type === "collab_change" &&
              typeof parsed.id === "string" &&
              parsed.actor &&
              typeof parsed.actor.userId === "number" &&
              typeof parsed.filePath === "string" &&
              (parsed.kind === "edit_burst" || parsed.kind === "callout")
            ) {
              // M60: RECEIVE-ONLY collaboration-history event. The client has
              // no code path that authors this frame — only the server's
              // CollaborationHistorian broadcaster emits it, so a modified
              // peer cannot forge history (same guarantee as run_status).
              this.emit("collab_change", parsed);
            } else if (
              parsed &&
              parsed.type === "comment_event" &&
              typeof parsed.threadId === "string" &&
              typeof parsed.filePath === "string" &&
              typeof parsed.kind === "string"
            ) {
              // M61-A: RECEIVE-ONLY comment cache-invalidation ping. Carries no
              // bodies — the client refetches the affected file over REST. The
              // client never authors this frame.
              this.emit("comment_event", parsed);
            } else if (
              parsed &&
              parsed.type === "comment_mention" &&
              typeof parsed.threadId === "string" &&
              typeof parsed.commentId === "string" &&
              typeof parsed.filePath === "string" &&
              parsed.author &&
              typeof parsed.author.username === "string"
            ) {
              // M61-A: RECEIVE-ONLY targeted mention ping (presentation only —
              // persistence is the comment_mentions row).
              this.emit("comment_mention", parsed);
            } else if (
              parsed &&
              parsed.type === "profile_event" &&
              typeof parsed.userId === "number"
            ) {
              // M61-C: RECEIVE-ONLY profile-bundle invalidation ping.
              this.emit("profile_event", parsed);
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
    // M57: working folder is derived from the focused editor file only —
    // dirname(activeFile). Never from Explorer browsing.
    this.awareness.setLocalStateField(
      "workingFolder",
      deriveWorkingFolder(filePath),
    );
    // M56: switching files clears the dirty bit; the new file's dirty state
    // is pushed separately by the editor once the tab is active.
    this.localActiveFileDirty = false;
    this.awareness.setLocalStateField("activeFileDirty", false);
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

  // M54: apply one server run-status broadcast. "cleared" removes the entry;
  // any other state upserts it. All fields are already server-authoritative;
  // this only shape-guards against a corrupt frame.
  private handleRunStatusMessage(msg: any): void {
    if (this.isDisposed) return;
    const id: string = msg.executionId;
    if (msg.state === "cleared") {
      this.runStatuses.delete(id);
    } else if (
      (msg.state === "running" ||
        msg.state === "success" ||
        msg.state === "failed" ||
        msg.state === "stopped") &&
      typeof msg.userId === "number" &&
      typeof msg.startedAt === "number"
    ) {
      this.runStatuses.set(id, {
        executionId: id,
        userId: msg.userId,
        username: typeof msg.username === "string" ? msg.username : "",
        state: msg.state,
        file: typeof msg.file === "string" ? msg.file : null,
        language: typeof msg.language === "string" ? msg.language : null,
        startedAt: msg.startedAt,
        endedAt: typeof msg.endedAt === "number" ? msg.endedAt : null,
        exitCode: typeof msg.exitCode === "number" ? msg.exitCode : null,
      });
    } else {
      return;
    }
    this.emit("run_status_change", this.getRunStatuses());
  }

  public getRunStatuses(): RunStatusEntry[] {
    return Array.from(this.runStatuses.values());
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

      // M59 P0 re-pin: the MonacoBinding ctor (and any Phase-7 setValue above)
      // seed the model via model.setValue(), which drops the LF pin Editor.tsx
      // applies at create time back to the platform default — CRLF on Windows.
      // The backend and the shared Y.Text are \n-only, so a CRLF-EOL client
      // translates its Monaco edits to Y.Text offsets that assume 2-byte line
      // breaks the document does not have, landing every remote edit at the
      // wrong position (verified live: two same-OS browsers ended up CRLF vs
      // LF for the same file and concurrent edits diverged byte-for-byte).
      // Re-pin LF here — after every (re)bind — so the invariant actually holds.
      const LF = monaco.editor?.EndOfLineSequence?.LF;
      if (LF !== undefined) model.setEOL(LF);
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
    const out: CollaboratorPresence[] = [];
    for (const [clientId, state] of this.awareness.getStates().entries()) {
      const p = readPresenceState(clientId, state);
      if (p) out.push(p);
    }
    return out;
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
    if (this.navHysteresisTimer) clearTimeout(this.navHysteresisTimer);
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    if (this.cursorTimer !== null) {
      cancelAnimationFrame(this.cursorTimer);
      this.cursorTimer = null;
    }
    this.removeActivityListeners();
    this.clearPendingBind();
    this.runStatuses.clear();
    this.attentionStore.dispose();
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

// getUserColor + USER_COLORS moved to ./presence.ts (M57), re-exported above.
