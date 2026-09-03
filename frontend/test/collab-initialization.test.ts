import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// M52 — Yjs/Monaco initial-load seed-race regression matrix.
//
// The client used to seed the shared Y.Text from the local Monaco model on
// bind ("initial_model_sync") whenever both looked empty. That raced the
// server loading the SAME file from disk into the room's Y.Text: both
// independent inserts survived the CRDT merge and the file's content
// doubled ("X" -> "XX") on disk. The fix removes seeding entirely and
// defers constructing the y-monaco binding until the server sends
// `{type:"file_ready"}` for the path (or a 2s fallback timer fires).
//
// Harness mirrors collab.explicitDisposalReset.test.ts: only monacoSetup
// and y-monaco are mocked; yjs / y-protocols / lib0 run for real. The fake
// MonacoBinding reproduces the one real behavior the bug hinges on — on
// construct the Monaco model is overwritten FROM the Y.Text, then kept
// synced to it via `ytext.observe`.
vi.mock("../src/monacoSetup", () => ({
  monaco: { editor: { EndOfLineSequence: { LF: 0, CRLF: 1 } } },
}));

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
      // Real y-monaco seeds the model via model.setValue(), which — like real
      // Monaco on Windows for \n-only content — resets the model EOL to CRLF.
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
const MESSAGE_CUSTOM = 3;

function fileReadyMessage(path: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CUSTOM);
  encoding.writeVarString(
    encoder,
    JSON.stringify({ type: "file_ready", path }),
  );
  return encoding.toUint8Array(encoder);
}

class FakeModel {
  private value: string;
  private disposedFlag = false;
  // "\r\n" = CRLF, "\n" = LF. Starts LF; setValue() drops it to the platform
  // default (CRLF), exactly as real Monaco does for \n-only content on Windows.
  private eol = "\n";
  constructor(initial: string) {
    this.value = initial;
  }
  getValue(): string {
    return this.value;
  }
  setValue(v: string): void {
    this.value = v;
    this.eol = "\r\n";
  }
  getEOL(): string {
    return this.eol;
  }
  setEOL(seq: number): void {
    this.eol = seq === 0 ? "\n" : "\r\n";
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

// Decodes a client Sync Step 1 and replies with Sync Step 2 built from
// `serverDoc` — the exact exchange backend/src/collab/manager.ts performs.
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

// The MESSAGE_SYNC frame the client sends as Sync Step 1 on connect.
function firstSyncFrame(ws: FakeWebSocket): Uint8Array {
  for (const m of ws.sent) {
    const d = decoding.createDecoder(m);
    if (decoding.readVarUint(d) === MESSAGE_SYNC) return m;
  }
  throw new Error("no sync frame sent");
}

const USER = { id: 1, username: "alice", role: "editor" } as any;

describe("CollaborationClient — M52 initial-load seed-race matrix", () => {
  beforeEach(() => {
    bindingCtorCalls.length = 0;
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 1. PRE-FIX-FAILING — a clean open racing the room's own disk load must
  // not duplicate the file's content.
  it("clean open during room load does not duplicate content", () => {
    const client = new CollaborationClient("proj-1", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const model = new FakeModel("X");
    client.bindMonacoModel("main.py", model as any, {} as any);

    // Server loaded the same disk content ("X") independently.
    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "X");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));

    // Then the server signals the file is ready -> deferred bind completes.
    ws.simulateMessage(fileReadyMessage("main.py"));

    expect(client.doc.getText("main.py").toString()).toBe("X");
    expect(model.getValue()).toBe("X");
    client.dispose();
  });

  // 2. Bind to an already-initialized room: Y.Text non-empty at bind time
  // -> binds immediately, no file_ready needed.
  it("binds immediately when the room Y.Text is already populated", () => {
    const client = new CollaborationClient("proj-2", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "already here");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));

    const model = new FakeModel("already here");
    client.bindMonacoModel("main.py", model as any, {} as any);

    expect(bindingCtorCalls.length).toBe(1);
    expect(client.doc.getText("main.py").toString()).toBe("already here");
    expect(model.getValue()).toBe("already here");
    client.dispose();
  });

  // 3. Race: file_ready arrives BEFORE the server's sync step 2.
  it("file_ready before sync step2 still yields content exactly once", () => {
    const client = new CollaborationClient("proj-3", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const model = new FakeModel("X");
    client.bindMonacoModel("main.py", model as any, {} as any);

    ws.simulateMessage(fileReadyMessage("main.py"));

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "X");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));

    expect(client.doc.getText("main.py").toString()).toBe("X");
    expect(model.getValue()).toBe("X");
    client.dispose();
  });

  // 4. Empty new file: nothing anywhere -> binds, stays empty.
  it("empty new file binds with no phantom content", () => {
    const client = new CollaborationClient("proj-4", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("new.py", model as any, {} as any);

    const serverDoc = new Y.Doc();
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));
    ws.simulateMessage(fileReadyMessage("new.py"));

    expect(bindingCtorCalls.length).toBe(1);
    expect(client.doc.getText("new.py").toString()).toBe("");
    expect(model.getValue()).toBe("");
    client.dispose();
  });

  // 5. First local edit after a clean deferred bind is represented once.
  it("first local edit after a clean deferred bind appears exactly once", () => {
    const client = new CollaborationClient("proj-5", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const model = new FakeModel("B");
    client.bindMonacoModel("main.py", model as any, {} as any);

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "B");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));
    ws.simulateMessage(fileReadyMessage("main.py"));

    // A local Monaco edit flows through y-monaco into the Y.Text.
    client.doc.transact(() => {
      client.doc.getText("main.py").insert(1, "y");
    }, "local-edit");

    expect(client.doc.getText("main.py").toString()).toBe("By");
    client.dispose();
  });

  // 6. Fallback timer: no file_ready ever -> bind still completes after 2s.
  it("fallback timer completes a deferred bind with content exactly once", () => {
    vi.useFakeTimers();
    try {
      const client = new CollaborationClient("proj-6", USER);
      const ws = FakeWebSocket.latest();
      ws.simulateOpen();

      const model = new FakeModel("X");
      client.bindMonacoModel("main.py", model as any, {} as any);

      const serverDoc = new Y.Doc();
      serverDoc.getText("main.py").insert(0, "X");
      ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));

      expect(bindingCtorCalls.length).toBe(0); // still deferred

      vi.advanceTimersByTime(2000);

      expect(bindingCtorCalls.length).toBe(1);
      expect(client.doc.getText("main.py").toString()).toBe("X");
      expect(model.getValue()).toBe("X");
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // 7. Phase-7 dirty window: user edits during the defer window; local
  // buffer wins, base content represented once.
  it("a dirty edit during the defer window survives and is not duplicated", () => {
    const client = new CollaborationClient("proj-7", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const model = new FakeModel("X");
    client.bindMonacoModel("main.py", model as any, {} as any);

    // User types "y" during the defer window (real Monaco edit).
    model.setValue("Xy");

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "X");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));
    ws.simulateMessage(fileReadyMessage("main.py"));

    // The user's dirty buffer wins, applied once.
    expect(model.getValue()).toBe("Xy");
    // The authoritative base is represented once — never "XX" / "XXy".
    expect(client.doc.getText("main.py").toString()).not.toContain("XX");
    client.dispose();
  });

  // 8. Multi-file: switching bound files defers/completes each independently
  // and never seeds one file's Y.Text from another's model.
  it("per-file deferred binds never cross-seed content", () => {
    const client = new CollaborationClient("proj-8", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const modelA = new FakeModel("AAA");
    client.bindMonacoModel("a.py", modelA as any, {} as any);
    const modelB = new FakeModel("BBB");
    client.bindMonacoModel("b.py", modelB as any, {} as any);

    const serverDoc = new Y.Doc();
    serverDoc.getText("a.py").insert(0, "AAA");
    serverDoc.getText("b.py").insert(0, "BBB");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));

    ws.simulateMessage(fileReadyMessage("a.py"));
    ws.simulateMessage(fileReadyMessage("b.py"));

    // b.py is the active bind and completes now.
    expect(client.doc.getText("b.py").toString()).toBe("BBB");
    expect(modelB.getValue()).toBe("BBB");

    // Switching back to a.py binds immediately (readyFiles has it) with no
    // cross-contamination from b.py.
    client.bindMonacoModel("a.py", modelA as any, {} as any);
    expect(client.doc.getText("a.py").toString()).toBe("AAA");
    expect(modelA.getValue()).toBe("AAA");
    expect(client.doc.getText("b.py").toString()).toBe("BBB");
    client.dispose();
  });

  // 9. Ordinary reconnect (1006): lineage kept; a second file_ready does not
  // re-seed or duplicate.
  it("a second file_ready after an ordinary reconnect does not duplicate", () => {
    const client = new CollaborationClient("proj-9", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("X");
    client.bindMonacoModel("main.py", model as any, {} as any);
    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "X");
    ws1.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws1)));
    ws1.simulateMessage(fileReadyMessage("main.py"));

    const docBefore = client.doc;
    ws1.simulateClose(1006);
    expect(client.doc).toBe(docBefore);
    clearTimeout((client as any).reconnectTimer);

    client.connect();
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws2)));
    ws2.simulateMessage(fileReadyMessage("main.py"));

    expect(client.doc.getText("main.py").toString()).toBe("X");
    expect(model.getValue()).toBe("X");
    client.dispose();
  });

  // 10. Explicit disposal (1001 while connected) + reconnect: fresh lineage,
  // server "NEW" content wins, no "OLD"/"NEW" merge.
  it("explicit disposal then reconnect adopts fresh server content with no merge", () => {
    const client = new CollaborationClient("proj-10", USER);
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    const model = new FakeModel("");
    client.bindMonacoModel("main.py", model as any, {} as any);
    ws1.simulateMessage(fileReadyMessage("main.py"));

    client.doc.transact(() => {
      client.doc.getText("main.py").insert(0, "OLD");
    }, "local-edit");

    const docBefore = client.doc;
    expect(client.status).toBe("connected");
    ws1.simulateClose(1001);
    expect(client.doc).not.toBe(docBefore);
    expect(client.doc.getText("main.py").toString()).toBe("");

    client.connect();
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();
    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "NEW");
    ws2.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws2)));
    ws2.simulateMessage(fileReadyMessage("main.py"));

    const final = client.doc.getText("main.py").toString();
    expect(final).toBe("NEW");
    expect(final).not.toContain("OLD");
    expect(model.getValue()).toBe("NEW");
    client.dispose();
  });

  // 11. M59 P0 — the model EOL is re-pinned to LF AFTER the y-monaco bind.
  // The MonacoBinding ctor seeds the model via setValue(), which (like real
  // Monaco on Windows for \n-only content) leaves the model EOL at CRLF —
  // undoing the LF pin Editor.tsx applies at create time. A CRLF-EOL client
  // then translates its Monaco edits into wrong Y.Text offsets and concurrent
  // edits diverge byte-for-byte across clients (reproduced live). completeBind
  // must set the EOL back to LF as its last step.
  it("re-pins the model EOL to LF after the y-monaco bind seeds it", () => {
    const client = new CollaborationClient("proj-11", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "line one\nline two\n");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));

    const model = new FakeModel("line one\nline two\n");
    expect(model.getEOL()).toBe("\n"); // pinned by Editor.tsx at create time
    client.bindMonacoModel("main.py", model as any, {} as any);

    // Y.Text was already populated -> binds immediately; the fake binding's
    // setValue() seed has just dropped the model to CRLF.
    expect(bindingCtorCalls.length).toBe(1);
    expect(model.getEOL()).toBe("\n"); // completeBind re-pinned it back to LF
    client.dispose();
  });

  it("re-pins EOL to LF on a deferred bind too (after file_ready)", () => {
    const client = new CollaborationClient("proj-11b", USER);
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    const model = new FakeModel("X");
    client.bindMonacoModel("main.py", model as any, {} as any);

    const serverDoc = new Y.Doc();
    serverDoc.getText("main.py").insert(0, "X");
    ws.simulateMessage(serverReplyToSyncStep1(serverDoc, firstSyncFrame(ws)));
    ws.simulateMessage(fileReadyMessage("main.py"));

    expect(bindingCtorCalls.length).toBe(1);
    expect(model.getEOL()).toBe("\n");
    client.dispose();
  });
});
