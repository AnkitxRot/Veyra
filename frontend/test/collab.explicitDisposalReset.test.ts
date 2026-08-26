import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// M40 — Reset collaboration state after explicit server disposal.
//
// CollaborationClient never touches monaco directly (only the
// ITextModel/IStandaloneCodeEditor types passed in), so monacoSetup is
// stubbed like the other collab-adjacent tests. y-monaco's MonacoBinding is
// replaced with a small fake that mirrors the ONE real behavior this bug
// hinges on (confirmed by reading node_modules/y-monaco/src/y-monaco.js):
// on bind, the Monaco model is overwritten FROM the Y.Text — never the
// other way around — and stays synced to it via `ytext.observe`.
vi.mock("../src/monacoSetup", () => ({ monaco: {} }));

const bindingCtorCalls: Array<{ ytext: Y.Text; model: FakeModel }> = [];
vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    ytext: Y.Text;
    model: FakeModel;
    private handler: () => void;
    constructor(ytext: Y.Text, model: FakeModel) {
      this.ytext = ytext;
      this.model = model;
      bindingCtorCalls.push({ ytext, model });
      model.setValue(ytext.toString());
      this.handler = () => model.setValue(ytext.toString());
      ytext.observe(this.handler);
    }
    destroy() {
      try {
        this.ytext.unobserve(this.handler);
      } catch {}
    }
  },
}));

import { CollaborationClient } from "../src/collab/client";

const MESSAGE_SYNC = 0;

class FakeModel {
  private value: string;
  private disposedFlag = false;
  constructor(initial: string) {
    this.value = initial;
  }
  getValue(): string {
    return this.value;
  }
  setValue(v: string): void {
    this.value = v;
  }
  isDisposed(): boolean {
    return this.disposedFlag;
  }
  dispose(): void {
    this.disposedFlag = true;
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
  }

  send(data: ArrayBufferLike): void {
    this.sent.push(new Uint8Array(data as ArrayBuffer));
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: Uint8Array): void {
    const copy = new Uint8Array(data);
    this.onmessage?.({ data: copy.buffer } as any);
  }

  simulateClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as any);
  }

  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

// Decodes a client-sent Sync Step 1 message and replies with Sync Step 2
// built from `serverDoc` — the exact protocol exchange the real backend
// (backend/src/collab/manager.ts) performs, reused here unmocked (only
// y-monaco and monacoSetup are mocked; yjs/y-protocols/lib0 run for real).
function serverReplyToSyncStep1(
  serverDoc: Y.Doc,
  syncStep1Message: Uint8Array,
): Uint8Array {
  const decoder = decoding.createDecoder(syncStep1Message);
  decoding.readVarUint(decoder); // consume MESSAGE_SYNC envelope tag
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, serverDoc, "fake-server");
  return encoding.toUint8Array(encoder);
}

const USER = { id: 1, username: "alice", role: "editor" } as any;

describe("CollaborationClient — M40 explicit-disposal state reset", () => {
  beforeEach(() => {
    bindingCtorCalls.length = 0;
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Test 1 + 4 + 10 (EXPLICIT DISPOSAL / DIRTY MONACO / RECONNECT IDENTITY)
  it("discards a dirty stale Y.Doc lineage on a 1001-while-connected close and adopts a genuinely new lineage synced to fresh server content", () => {
    const client = new CollaborationClient("project-a", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("main.py", model as any, {} as any);

    // Simulate the user having unsaved ("dirty") edits at the moment the
    // server disposes the room — a real Monaco edit would flow through
    // MonacoBinding's onDidChangeContent handler into the same doc.transact
    // call this reproduces directly.
    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "OLD CONTENT (unsaved edit)");
    }, "test-local-edit");
    expect(model.getValue()).toBe("OLD CONTENT (unsaved edit)");

    const docBeforeReset = client.doc;
    const clientIdBeforeReset = client.doc.clientID;

    // Server explicitly disposed the room (import/restore/delete) while
    // this client was connected: close code 1001, status was "connected".
    expect(client.status).toBe("connected");
    ws1.simulateClose(1001);

    // RECONNECT IDENTITY (test 10): a genuinely new Y.Doc lineage, not the
    // same object with content merely cleared in place.
    expect(client.doc).not.toBe(docBeforeReset);
    expect(client.doc.clientID).not.toBe(clientIdBeforeReset);
    expect(client.doc.getText("main.py").toString()).toBe("");

    // MonacoBinding was rebound (fake constructor called again) but WITHOUT
    // the seed heuristic: the model must not have re-inserted its own
    // stale content into the new, empty Y.Text.
    expect(model.getValue()).toBe("");

    // Reconnect (this is exactly what scheduleReconnect()'s deferred timer
    // would eventually call).
    client.connect();
    const ws2 = FakeWebSocket.latest();
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    const syncStep1 = ws2.sent[0];
    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "NEW CONTENT FROM SERVER");
    const step2Reply = serverReplyToSyncStep1(serverDoc, syncStep1);
    ws2.simulateMessage(step2Reply);

    // STALE_MERGE|ELIMINATED — fresh content only, no concatenation with
    // the discarded old content in either order.
    const finalText = client.doc.getText("main.py").toString();
    expect(finalText).toBe("NEW CONTENT FROM SERVER");
    expect(finalText).not.toContain("OLD CONTENT");

    // Monaco reflects exactly the fresh content once sync completes.
    expect(model.getValue()).toBe("NEW CONTENT FROM SERVER");
  });

  // Test 2 (PREVENT YJS MERGE) — same root-cause shape as the standalone
  // M40 Yjs-only reproduction script, driven through the real client.
  it("does not merge/concatenate an independently-seeded stale client lineage with an independently-seeded fresh server lineage", () => {
    const client = new CollaborationClient("project-merge", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("app.js", model as any, {} as any);
    client.doc.transact(() => {
      client.doc.getText("app.js").insert(0, 'print("before import")\n');
    }, "test-local-edit");

    ws1.simulateClose(1001);
    client.connect();
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();

    const serverDoc = new Y.Doc();
    serverDoc
      .getText("app.js")
      .insert(0, 'print("AFTER IMPORT FROM IMPORT")\n');
    const reply = serverReplyToSyncStep1(serverDoc, ws2.sent[0]);
    ws2.simulateMessage(reply);

    const finalText = client.doc.getText("app.js").toString();
    expect(finalText).toBe('print("AFTER IMPORT FROM IMPORT")\n');
    expect(finalText).not.toContain("before import");
  });

  // Test 3 (DISK PRESERVATION, frontend-observable proxy) — after an
  // explicit-disposal reconnect, the client must never transmit anything
  // derived from the discarded lineage. Persistence of exactly what the
  // server receives is already covered by the backend's own m4-collab
  // tests; this test's scope is the frontend not re-poisoning the server.
  it("never re-transmits discarded content to the server after an explicit-disposal reconnect", () => {
    const client = new CollaborationClient("project-disk", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("data.txt", model as any, {} as any);
    client.doc.transact(() => {
      client.doc.getText("data.txt").insert(0, "STALE PRE-IMPORT DATA");
    }, "test-local-edit");

    ws1.simulateClose(1001);
    client.connect();
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();

    const serverDoc = new Y.Doc();
    serverDoc.getText("data.txt").insert(0, "IMPORTED DATA");
    const reply = serverReplyToSyncStep1(serverDoc, ws2.sent[0]);
    ws2.simulateMessage(reply);

    // Replay every message the client sent after reconnecting into a fresh
    // copy of the server's post-import doc: if the client ever transmitted
    // anything carrying the stale lineage, this would corrupt it.
    const replayDoc = new Y.Doc();
    replayDoc.getText("data.txt").insert(0, "IMPORTED DATA");
    for (const msg of ws2.sent) {
      const decoder = decoding.createDecoder(msg);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        syncProtocol.readSyncMessage(decoder, encoder, replayDoc, "replay");
      }
    }
    expect(replayDoc.getText("data.txt").toString()).toBe("IMPORTED DATA");
  });

  // Test 5 (MULTIPLE OPEN FILES) — the client owns one Y.Doc per project;
  // resetting it must discard every file's lineage, not just the actively
  // bound one.
  it("discards stale state for every file's Y.Text, not just the actively bound one", () => {
    const client = new CollaborationClient("project-multi", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const modelA = new FakeModel("");
    client.bindMonacoModel("a.py", modelA as any, {} as any);
    client.doc.transact(() => {
      client.doc.getText("a.py").insert(0, "STALE A (bound)");
    }, "test-local-edit");

    // b.py was previously open (its Y.Text already has content in this
    // same shared doc) but is not the currently active/bound tab.
    client.doc.transact(() => {
      client.doc.getText("b.py").insert(0, "STALE B (not bound)");
    }, "test-local-edit");

    ws1.simulateClose(1001);

    expect(client.doc.getText("a.py").toString()).toBe("");
    expect(client.doc.getText("b.py").toString()).toBe("");
  });

  // IMPORT + RESTORE COVERAGE — the fix keys entirely off the close-code
  // signal (1001 while previously "connected"), not off which backend
  // operation caused it. backend/src/projects/archive.ts's importProjectZip
  // and backend/src/backup/workspaceRestore.ts's restoreWorkspaceBackup
  // both call collaborationManager.getRoom(id)?.dispose() the same way
  // (confirmed by reading both files), which sends the identical 1001
  // close. This test stands in for the restore path using the same signal
  // to confirm no import-specific assumption crept into the client fix.
  it("resets local state identically regardless of which server-side operation triggered the disposal (import vs. workspace/snapshot restore)", () => {
    const client = new CollaborationClient("project-restore", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("config.json", model as any, {} as any);
    client.doc.transact(() => {
      client.doc.getText("config.json").insert(0, '{ "stale": true }');
    }, "test-local-edit");

    const docBeforeReset = client.doc;
    // restoreWorkspaceBackup's QUIESCE + RECONNECT steps both call
    // room.dispose(), which — like every other dispose() call in this
    // codebase (import, delete, snapshot restore) — closes every client
    // with the same code: 1001.
    ws1.simulateClose(1001);

    expect(client.doc).not.toBe(docBeforeReset);
    expect(client.doc.getText("config.json").toString()).toBe("");

    client.connect();
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();

    const restoredServerDoc = new Y.Doc();
    restoredServerDoc.getText("config.json").insert(0, '{ "restored": true }');
    const reply = serverReplyToSyncStep1(restoredServerDoc, ws2.sent[0]);
    ws2.simulateMessage(reply);

    expect(client.doc.getText("config.json").toString()).toBe(
      '{ "restored": true }',
    );
  });

  // Test 6 (ORDINARY NETWORK RECONNECT) — the most important non-regression:
  // a close that was NOT an explicit server disposal must preserve local
  // state exactly, so existing offline delta reconciliation keeps working.
  it("preserves the same Y.Doc lineage and local edits across an ordinary (non-1001) disconnect", () => {
    const client = new CollaborationClient("project-blip", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("main.py", model as any, {} as any);
    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "unsaved offline edit");
    }, "test-local-edit");

    const docBefore = client.doc;
    expect(client.status).toBe("connected");

    // Abnormal closure (network blip), not an explicit server disposal.
    ws1.simulateClose(1006);

    expect(client.status).toBe("disconnected");
    expect(client.doc).toBe(docBefore);
    expect(client.doc.getText("main.py").toString()).toBe(
      "unsaved offline edit",
    );
    expect(model.getValue()).toBe("unsaved offline edit");
    // A reconnect was still scheduled (existing behavior).
    expect((client as any).reconnectTimer).not.toBeNull();

    clearTimeout((client as any).reconnectTimer);
  });

  // Test 9 (NON-EXPLICIT CLOSE variant) — a 1001 close received before the
  // client ever reached "connected" must not be treated as an explicit
  // disposal (no prior legitimate session to invalidate).
  it("does not reset local state for a 1001 close that arrives before the client ever connected", () => {
    const client = new CollaborationClient("project-early", USER);
    const ws1 = FakeWebSocket.latest();
    // Never call ws1.simulateOpen() — status stays "connecting".
    expect(client.status).toBe("connecting");

    const docBefore = client.doc;
    ws1.simulateClose(1001);

    expect(client.doc).toBe(docBefore);
    clearTimeout((client as any).reconnectTimer);
  });

  // Test 7 (PROJECT SWITCH / dispose() regression check) — dispose() must
  // still fully tear down the (possibly freshly-reset) doc/awareness.
  it("dispose() still fully tears down doc/awareness after a prior explicit-disposal reset", () => {
    const client = new CollaborationClient("project-switch", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateClose(1001); // triggers a reset, giving client a 2nd-gen doc

    const doc = client.doc;
    const awareness = client.awareness;
    client.dispose();

    expect(doc.isDestroyed).toBe(true);
    expect(() => awareness.getStates()).not.toThrow();
    expect((client as any).isDisposed).toBe(true);
  });
});
