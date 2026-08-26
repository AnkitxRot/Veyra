import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
  DEFAULT_YJS_COALESCE_MS,
} from "../src/collab/manager.js";
import {
  createProject,
  deleteProject,
  addProjectCollaborator,
  removeProjectCollaborator,
  listProjectCollaborators,
  requireProjectAccess,
  projectDir,
} from "../src/projects/service.js";
import { createSnapshot, restoreSnapshot } from "../src/projects/snapshots.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_CUSTOM = 3;

function makeMockWs() {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
  } as any;
}

/**
 * Builds a real MESSAGE_AWARENESS frame the way an actual client would:
 * a throwaway Y.Doc + Awareness instance represents "the client's own Yjs
 * runtime". setLocalStateField produces a genuine update keyed by that
 * doc's own (randomly assigned) clientID, which we then wrap in the same
 * envelope the production code expects.
 */
function buildAwarenessFrame(
  clientAwareness: awarenessProtocol.Awareness,
  field: Record<string, unknown>,
) {
  clientAwareness.setLocalStateField("user", field);
  const update = awarenessProtocol.encodeAwarenessUpdate(clientAwareness, [
    clientAwareness.clientID,
  ]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/**
 * Builds a real MESSAGE_SYNC/messageYjsUpdate frame the way an actual client
 * would broadcast a local edit: a throwaway client Y.Doc produces a genuine
 * Yjs update, wrapped in the same sync envelope the production code expects.
 */
function buildSyncUpdateFrame(clientDoc: Y.Doc, mutate: () => void) {
  let update: Uint8Array | null = null;
  const capture = (u: Uint8Array) => {
    update = u;
  };
  clientDoc.on("update", capture);
  mutate();
  clientDoc.off("update", capture);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update!);
  return encoding.toUint8Array(encoder);
}

/**
 * Builds a real MESSAGE_CUSTOM `file_open` frame the way an actual client
 * would announce which file it just opened: the same JSON envelope
 * handleMessage()'s MESSAGE_CUSTOM decoder reads via readVarString().
 */
function buildFileOpenFrame(path: string) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CUSTOM);
  encoding.writeVarString(encoder, JSON.stringify({ type: "file_open", path }));
  return encoding.toUint8Array(encoder);
}

/**
 * Wires a real client-side Yjs doc to a mock socket's `.send`, so incoming
 * MESSAGE_SYNC frames from the room (broadcasts, and the initial Sync
 * Step 1 handshake sent by addClient) are actually applied to `clientDoc`
 * via the real sync protocol — exactly what a genuine browser client does.
 * Sync Step 1 provokes a Step 2 reply, which is sent straight back into the
 * room via `room.handleMessage`, completing the real handshake.
 */
function wireClientToRoom(
  room: CollaborationRoom,
  ws: any,
  clientDoc: Y.Doc,
): void {
  ws.send = (message: Uint8Array) => {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, clientDoc, ws);
    if (encoding.length(encoder) > 1) {
      room.handleMessage(ws, encoding.toUint8Array(encoder));
    }
  };
}

/**
 * handleMessage() dispatches file_open to ensureFileLoaded() as a floating
 * promise, so the disk read completes after handleMessage() returns. Flush
 * pending microtasks/I-O so assertions observe the settled state.
 */
async function flushAsync() {
  // Real filesystem I/O (realpath/access/readFile) completes on the
  // threadpool, so drain with a real timer rather than microtask ticks.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("M4 Real-Time Multiplayer Collaboration & CRDT Engine", () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;
  let tempDataDir: string;

  beforeEach(async () => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m4-test-"));
    tempDataDir = mkdtempSync(join(tmpdir(), "cloudide-m4-data-"));
    db = openDb(":memory:");
    cfg = {
      ...resolveConfig(),
      workspacesDir: tempWorkspacesDir,
      dataDir: tempDataDir,
    };
    collaborationManager.init(cfg, db);
  });

  afterEach(async () => {
    try {
      rmSync(tempWorkspacesDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. CRDT Convergence: concurrent conflicting edits converge to identical text", () => {
    // Client A and Client B start synchronized
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const textA = docA.getText("main.py");
    const textB = docB.getText("main.py");

    textA.insert(0, "def compute(x):\n    return x * 2\n");

    // Sync initial state A -> B
    const initialUpdate = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, initialUpdate);

    expect(textA.toString()).toBe(textB.toString());

    // User A and User B concurrently edit
    // User A inserts docstring at line 1
    textA.insert(16, '    """Multiply input by 2"""\n');

    // User B simultaneously modifies return expression
    textB.delete(31, 1); // remove '2'
    textB.insert(31, "10 + x"); // change to x * 10 + x

    // Exchange updates
    const updateA = Y.encodeStateAsUpdate(docA);
    const updateB = Y.encodeStateAsUpdate(docB);

    Y.applyUpdate(docB, updateA);
    Y.applyUpdate(docA, updateB);

    // CRITICAL INVARIANT: Final text MUST converge to 100% identical content
    expect(textA.toString()).toBe(textB.toString());
    expect(textA.toString()).toContain("Multiply input by 2");
    expect(textA.toString()).toContain("10 + x");
  });

  it("2. Lazy file loading & disk workspace persistence", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("owner_u", "h", "user");
    const project = await createProject(cfg, db, 1, {
      name: "MultiplayerProj",
    });
    const filePath = "script.py";
    const diskPath = join(projectDir(cfg, project.id), filePath);
    await fs.writeFile(diskPath, 'print("initial disk content")', "utf-8");

    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded(filePath);
    expect(yText.toString()).toBe('print("initial disk content")');

    // Simulate collaborative edit in room
    yText.insert(yText.length, '\nprint("multiplayer added line")');
    room.markFileDirty(filePath);

    // Flush to disk
    await room.flushToDisk();

    const savedDiskContent = await fs.readFile(diskPath, "utf-8");
    expect(savedDiskContent).toBe(
      'print("initial disk content")\nprint("multiplayer added line")',
    );
  });

  it("3. External file mutation safety: REST file save updates active Y.Doc without divergence", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("owner_u", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "ExternalProj" });
    const filePath = "app.js";

    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded(filePath);
    yText.insert(0, "const port = 3000;");

    // Simulate an external snapshot restore or REST write
    const externalContent =
      'const port = 8080;\nconsole.log("Restored snapshot");';
    await collaborationManager.notifyExternalFileMutation(
      project.id,
      filePath,
      externalContent,
    );

    expect(yText.toString()).toBe(externalContent);
  });

  it("4. Multi-Tenant access authorization & RBAC permissions", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("charlie", "h", "user"); // id 3
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("admin_u", "h", "admin"); // id 4

    const project = await createProject(cfg, db, 1, { name: "SecuredProj" });

    // 1. Owner access
    const ownerAccess = requireProjectAccess(db, 1, project.id);
    expect(ownerAccess.role).toBe("owner");

    // 2. Uninvited user access
    expect(() => requireProjectAccess(db, 2, project.id)).toThrowError(
      /not found/,
    );

    // 3. Invite Bob as Editor
    addProjectCollaborator(db, project.id, 2, "editor");
    const editorAccess = requireProjectAccess(db, 2, project.id, "editor");
    expect(editorAccess.role).toBe("editor");

    // 4. Invite Charlie as Viewer
    addProjectCollaborator(db, project.id, 3, "viewer");
    const viewerAccess = requireProjectAccess(db, 3, project.id, "viewer");
    expect(viewerAccess.role).toBe("viewer");

    // Viewer fails editor minimum requirement
    expect(() =>
      requireProjectAccess(db, 3, project.id, "editor"),
    ).toThrowError(/read-only viewer/);

    // 5. Admin has owner-level access
    const adminAccess = requireProjectAccess(db, 4, project.id);
    expect(adminAccess.role).toBe("owner");

    // 6. List collaborators
    const members = listProjectCollaborators(db, project.id);
    expect(members.length).toBe(2);
    expect(
      members.some((m) => m.username === "bob" && m.role === "editor"),
    ).toBe(true);
    expect(
      members.some((m) => m.username === "charlie" && m.role === "viewer"),
    ).toBe(true);
  });

  it("5. Revocation & collaborator removal immediately cuts access", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2

    const project = await createProject(cfg, db, 1, { name: "RevokeProj" });
    addProjectCollaborator(db, project.id, 2, "editor");
    expect(requireProjectAccess(db, 2, project.id).role).toBe("editor");

    // Revoke collaborator
    removeProjectCollaborator(db, project.id, 2);
    expect(() => requireProjectAccess(db, 2, project.id)).toThrowError(
      /not found/,
    );
    expect(listProjectCollaborators(db, project.id).length).toBe(0);
  });

  it("6. Offline delta reconciliation: client reconnects and converges with room edits", () => {
    const serverDoc = new Y.Doc();
    const clientDoc = new Y.Doc();

    const serverText = serverDoc.getText("code.ts");
    const clientText = clientDoc.getText("code.ts");

    serverText.insert(0, "let count = 0;");
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc));

    // Client goes offline and edits locally
    clientText.insert(clientText.length, "\ncount += 5;");

    // Server concurrently receives another edit
    serverText.insert(serverText.length, "\nconsole.log(count);");

    // Client reconnects: performs Sync Step 1 & Step 2 exchange
    const clientStateVector = Y.encodeStateVector(clientDoc);
    const serverDiff = Y.encodeStateAsUpdate(serverDoc, clientStateVector);

    const serverStateVector = Y.encodeStateVector(serverDoc);
    const clientDiff = Y.encodeStateAsUpdate(clientDoc, serverStateVector);

    Y.applyUpdate(clientDoc, serverDiff);
    Y.applyUpdate(serverDoc, clientDiff);

    // Both client and server must have identical text
    expect(clientText.toString()).toBe(serverText.toString());
    expect(clientText.toString()).toContain("count += 5;");
    expect(clientText.toString()).toContain("console.log(count);");
  });

  it("7. Multi-File collaboration in same room", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "MultiFileProj" });

    const room = collaborationManager.getOrCreateRoom(project.id);
    const pyText = await room.ensureFileLoaded("main.py");
    const jsText = await room.ensureFileLoaded("index.js");
    const mdText = await room.ensureFileLoaded("README.md");

    pyText.insert(0, 'print("Python File")');
    jsText.insert(0, 'console.log("JavaScript File")');
    mdText.insert(0, "# Documentation");

    room.markFileDirty("main.py");
    room.markFileDirty("index.js");
    room.markFileDirty("README.md");

    await room.flushToDisk();

    const pyDisk = await fs.readFile(
      join(projectDir(cfg, project.id), "main.py"),
      "utf-8",
    );
    const jsDisk = await fs.readFile(
      join(projectDir(cfg, project.id), "index.js"),
      "utf-8",
    );
    const mdDisk = await fs.readFile(
      join(projectDir(cfg, project.id), "README.md"),
      "utf-8",
    );

    expect(pyDisk).toBe('print("Python File")');
    expect(jsDisk).toBe('console.log("JavaScript File")');
    expect(mdDisk).toBe("# Documentation");
  });

  it("8. Per-client awareness ownership: disconnect cleans up only that client's presence, peers preserved, duplicate cleanup is safe", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2

    const project = await createProject(cfg, db, 1, { name: "AwarenessProj" });
    const room = collaborationManager.getOrCreateRoom(project.id);

    const wsA = makeMockWs();
    const wsB = makeMockWs();

    await room.addClient(wsA, { userId: 1, username: "alice", role: "editor" });
    await room.addClient(wsB, { userId: 2, username: "bob", role: "editor" });

    // Baseline after addClient: the room's own Awareness instance always
    // seeds an entry for the *room's* doc.clientID (an internal Yjs detail,
    // via Awareness's constructor calling setLocalState({})) — this belongs
    // to neither connection A nor B. addClient itself writes no per-client
    // presence (the server is not a room participant), so read the actual
    // baseline instead of assuming 0.
    const baselineSize = room.awareness.getStates().size;

    // Each simulated client has its own real Yjs runtime (Doc + Awareness),
    // exactly like a real browser client would, producing genuinely distinct,
    // randomly-assigned clientIDs.
    const clientDocA = new Y.Doc();
    const clientAwarenessA = new awarenessProtocol.Awareness(clientDocA);
    const clientDocB = new Y.Doc();
    const clientAwarenessB = new awarenessProtocol.Awareness(clientDocB);

    const frameA = buildAwarenessFrame(clientAwarenessA, {
      name: "Alice",
      color: "#f00",
    });
    const frameB = buildAwarenessFrame(clientAwarenessB, {
      name: "Bob",
      color: "#0f0",
    });

    const clientIdA = clientAwarenessA.clientID;
    const clientIdB = clientAwarenessB.clientID;
    expect(clientIdA).not.toBe(clientIdB);

    room.handleMessage(wsA, frameA);
    room.handleMessage(wsB, frameB);

    // Both connections' real awareness states are now present in the room.
    const statesAfterBoth = room.awareness.getStates();
    expect(statesAfterBoth.size).toBe(baselineSize + 2);
    expect(statesAfterBoth.has(clientIdA)).toBe(true);
    expect(statesAfterBoth.has(clientIdB)).toBe(true);

    // Disconnect A.
    room.removeClient(wsA);

    const statesAfterRemoveA = room.awareness.getStates();
    // A's presence is gone...
    expect(statesAfterRemoveA.has(clientIdA)).toBe(false);
    // ...but B's presence (the peer) must be untouched. This is the exact
    // assertion that would have caught the old bug, which removed the
    // shared doc.clientID instead of the disconnecting connection's own
    // real awareness clientID(s).
    expect(statesAfterRemoveA.has(clientIdB)).toBe(true);
    expect(statesAfterRemoveA.size).toBe(baselineSize + 1);

    // Removing the same (already-removed) client again must be a safe no-op:
    // no throw, and B's state remains exactly as before.
    expect(() => room.removeClient(wsA)).not.toThrow();
    const statesAfterDuplicateRemove = room.awareness.getStates();
    expect(statesAfterDuplicateRemove.has(clientIdB)).toBe(true);
    expect(statesAfterDuplicateRemove.size).toBe(baselineSize + 1);

    clientAwarenessA.destroy();
    clientDocA.destroy();
    clientAwarenessB.destroy();
    clientDocB.destroy();
  });

  it("9. Project deletion disposes the active CollaborationRoom and disconnects live collaborators", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "DeletedProj" });
    const room = collaborationManager.getOrCreateRoom(project.id);

    let closeCode: number | undefined;
    const ws = {
      readyState: 1,
      send: () => {},
      close: (code: number) => {
        closeCode = code;
      },
    } as any;

    await room.addClient(ws, { userId: 1, username: "alice", role: "owner" });
    expect(collaborationManager.getRoom(project.id)).toBe(room);

    await deleteProject(cfg, db, 1, project.id);

    // The live collaborator's socket must be closed, not left dangling
    // against a workspace that no longer exists.
    expect(closeCode).toBe(1001);
    // The room must be fully removed from the manager, not leaked in memory.
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
  });

  it("10. Snapshot restore keeps an active CollaborationRoom's Y.Doc in sync (does not get silently reverted by the next flush)", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("owner_u", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "SnapRestoreProj",
    });
    const filePath = "main.py";
    const workspaceFile = join(tempWorkspacesDir, project.id, filePath);

    await fs.writeFile(workspaceFile, "print('v1')");
    const snapshot = await createSnapshot(cfg, db, 1, project.id, "snap-v1");

    // Disk drifts after the snapshot was taken.
    await fs.writeFile(workspaceFile, "print('v2')");

    // A collaborator has the file open with further, uncommitted local edits.
    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded(filePath);
    expect(yText.toString()).toBe("print('v2')");
    yText.delete(0, yText.length);
    yText.insert(0, "print('v3, unsaved local edit')");

    await restoreSnapshot(cfg, db, 1, project.id, snapshot.id);

    // Disk must reflect the restored snapshot content.
    const diskContent = await fs.readFile(workspaceFile, "utf-8");
    expect(diskContent).toBe("print('v1')");

    // The room's live Y.Doc must be updated to match — not left on the
    // collaborator's stale local edit, which would otherwise get flushed
    // back to disk shortly after, silently undoing the restore.
    expect(yText.toString()).toBe("print('v1')");
  });

  it("11. Role downgrade takes effect on a live connection: a demoted editor immediately loses write access", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("carol", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "RoleDowngradeProj",
    });
    const room = collaborationManager.getOrCreateRoom(project.id);
    const ws = makeMockWs();
    await room.addClient(ws, { userId: 1, username: "carol", role: "editor" });

    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText("main.py");

    // While still an editor, a real update is accepted into the room's doc.
    const frame1 = buildSyncUpdateFrame(clientDoc, () =>
      clientText.insert(0, "print(1)"),
    );
    room.handleMessage(ws, frame1);
    expect(room.doc.getText("main.py").toString()).toBe("print(1)");

    // Owner demotes this connected user to viewer via the live-session sync
    // path (mirrors what the /collaborators PATCH route now calls).
    collaborationManager.updateUserRole(project.id, 1, "viewer");

    // The same still-open connection must now be rejected: clientState.role
    // is otherwise only captured once at connect time, so without this fix
    // a demoted editor would keep write access until they reconnect.
    const frame2 = buildSyncUpdateFrame(clientDoc, () =>
      clientText.insert(clientText.length, " blocked"),
    );
    room.handleMessage(ws, frame2);
    expect(room.doc.getText("main.py").toString()).toBe("print(1)");

    clientDoc.destroy();
  });

  it("12. A failed disk write keeps the file dirty so the next flush retries it (no silent false 'clean')", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("dana", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "FlushFailProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "test.txt";
    const diskPath = join(projectDir(cfg, project.id), filePath);

    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "unsaved collaborative edit");
    });
    room.markFileDirty(filePath);

    const writeSpy = vi.spyOn(fs, "writeFile");
    // Simulate one transient write failure (e.g. ENOSPC / permission hiccup).
    writeSpy.mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );

    await room.flushToDisk();

    // The write never landed, so the file MUST still be tracked as dirty.
    // Clearing it here would permanently strand the content in memory only.
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);
    await expect(fs.readFile(diskPath, "utf-8")).rejects.toThrow();

    // Next flush (spy now falls through to the real writeFile) must retry it.
    await room.flushToDisk();

    expect((room as any).dirtyFiles.has(filePath)).toBe(false);
    expect(await fs.readFile(diskPath, "utf-8")).toBe(
      "unsaved collaborative edit",
    );

    writeSpy.mockRestore();
    room.dispose();
  });

  it("13. Idle disposal is deferred while a flush failure leaves content unpersisted, and only disposes once the retry succeeds", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("eli", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "IdleDisposeProj",
    });
    const onDispose = vi.fn();
    const writeSpy = vi.spyOn(fs, "writeFile");
    // flushToDisk() resolves symlinks (fs.realpath/fs.access) before writing.
    // Real filesystem I/O cannot be driven to completion by fake timers
    // (advanceTimersByTimeAsync drains microtasks, not threadpool
    // completions), so stub those two calls to a pass-through here. This test
    // is about disposal backoff, not the boundary check — test 18 exercises
    // the real symlink guard against a real planted symlink.
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: any) => p);
    const accessSpy = vi
      .spyOn(fs, "access")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();

    try {
      const room = new CollaborationRoom(project.id, cfg, db, onDispose);
      const filePath = "test.txt";
      const diskPath = join(projectDir(cfg, project.id), filePath);

      const ws = makeMockWs();
      await room.addClient(ws, { userId: 1, username: "eli", role: "editor" });

      room.doc.transact(() => {
        room.doc.getText(filePath).insert(0, "edits that must not be lost");
      });
      room.markFileDirty(filePath);

      // Every write fails for now — a persistent transient-looking error.
      writeSpy.mockRejectedValue(new Error("EIO: i/o error"));

      // Last collaborator leaves -> 10s idle grace timer starts.
      room.removeClient(ws);
      await vi.advanceTimersByTimeAsync(10_000);

      // The final flush failed, so the room must NOT be destroyed: its Y.Doc
      // holds the only surviving copy of the content.
      expect(onDispose).not.toHaveBeenCalled();
      expect((room as any).dirtyFiles.has(filePath)).toBe(true);
      expect(room.doc.getText(filePath).toString()).toBe(
        "edits that must not be lost",
      );

      // The disk error clears; the rescheduled grace period retries the flush.
      // (Resolved mock rather than real I/O so the assertion stays
      // deterministic under fake timers; test 12 covers the real disk write.)
      // The retry backs off exponentially (10s -> 20s), so the second grace
      // period is 20s, not another 10s.
      writeSpy.mockReset();
      writeSpy.mockResolvedValue(undefined as never);
      await vi.advanceTimersByTimeAsync(20_000);

      // Content was persisted on the retry, and only then was the room freed.
      expect(writeSpy).toHaveBeenLastCalledWith(
        diskPath,
        "edits that must not be lost",
        "utf-8",
      );
      expect(onDispose).toHaveBeenCalledWith(project.id);
    } finally {
      writeSpy.mockRestore();
      realpathSpy.mockRestore();
      accessSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("13b. Idle-disposal retry backs off exponentially, capped at 5 minutes, and never stops retrying", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("ida", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "BackoffCapProj",
    });
    const onDispose = vi.fn();
    const writeSpy = vi.spyOn(fs, "writeFile");
    // See test 13: fake timers cannot drive the real fs.realpath/fs.access
    // calls flushToDisk() makes before each write. Test 18 covers the real
    // symlink guard.
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: any) => p);
    const accessSpy = vi
      .spyOn(fs, "access")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();

    try {
      const room = new CollaborationRoom(project.id, cfg, db, onDispose);
      const filePath = "test.txt";
      const ws = makeMockWs();
      await room.addClient(ws, { userId: 1, username: "ida", role: "editor" });

      room.doc.transact(() => {
        room.doc.getText(filePath).insert(0, "content that must not be lost");
      });
      room.markFileDirty(filePath);

      // Every write fails permanently (e.g. workspace directory gone, disk
      // full forever) — the retry loop must never give up, but must not keep
      // hammering the filesystem/log at a fixed 10s cadence either.
      writeSpy.mockRejectedValue(new Error("ENOSPC: no space left on device"));

      room.removeClient(ws);

      // 10s -> 20s -> 40s -> 80s -> 160s -> 300s(capped, would be 320s
      // uncapped) -> 300s again. Advance through several cycles and confirm
      // the delay never exceeds the 5-minute cap and retries keep happening.
      const expectedDelays = [
        10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
      ];
      let callsBefore = writeSpy.mock.calls.length;
      for (const delay of expectedDelays) {
        await vi.advanceTimersByTimeAsync(delay);
        expect(writeSpy.mock.calls.length).toBeGreaterThan(callsBefore);
        callsBefore = writeSpy.mock.calls.length;
      }

      // Content was never dropped, and the room was never disposed despite
      // the permanent failure.
      expect(onDispose).not.toHaveBeenCalled();
      expect((room as any).dirtyFiles.has(filePath)).toBe(true);
      expect(room.doc.getText(filePath).toString()).toBe(
        "content that must not be lost",
      );

      room.dispose();
    } finally {
      writeSpy.mockRestore();
      realpathSpy.mockRestore();
      accessSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("14. A real sync-protocol edit marks the edited file dirty, even for a file the server never opened", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("frank", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "SyncDirtyProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const ws = makeMockWs();
    await room.addClient(ws, { userId: 1, username: "frank", role: "editor" });

    // Deliberately NO ensureFileLoaded / file_open for this path: the server
    // learns about the file purely from the incoming update. Yjs materializes
    // such a key as a bare AbstractType, which never fires .observe() and
    // never appears in transaction.changedParentTypes — so a fix hooked on
    // either of those would miss this file entirely.
    const filePath = "never-opened.py";
    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText(filePath);

    expect((room as any).dirtyFiles.has(filePath)).toBe(false);

    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () =>
        clientText.insert(0, "print('real collaborative edit')"),
      ),
    );

    // The edit landed in the room's doc...
    expect(room.doc.getText(filePath).toString()).toBe(
      "print('real collaborative edit')",
    );
    // ...and, crucially, was recorded as dirty. This was permanently false
    // before the fix (markFileDirty was never called from any real request
    // path), which silently disabled flush-retry and disposal deferral.
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    // End-to-end: the tracked file actually persists and then goes clean.
    await room.flushToDisk();
    expect(
      await fs.readFile(join(projectDir(cfg, project.id), filePath), "utf-8"),
    ).toBe("print('real collaborative edit')");
    expect((room as any).dirtyFiles.has(filePath)).toBe(false);

    clientDoc.destroy();
    room.dispose();
  });

  it("15. Two different files edited via separate real sync messages are both tracked dirty", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("grace", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "SyncMultiDirtyProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const ws = makeMockWs();
    await room.addClient(ws, { userId: 1, username: "grace", role: "editor" });

    const clientDoc = new Y.Doc();
    const textA = clientDoc.getText("alpha.py");
    const textB = clientDoc.getText("beta.js");

    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => textA.insert(0, "alpha = 1")),
    );
    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => textB.insert(0, "const beta = 2;")),
    );

    const dirty: Set<string> = (room as any).dirtyFiles;
    expect(dirty.has("alpha.py")).toBe(true);
    expect(dirty.has("beta.js")).toBe(true);

    // Both must survive a failed write and be retried, which is only possible
    // because they were tracked in the first place.
    const writeSpy = vi.spyOn(fs, "writeFile");
    writeSpy.mockRejectedValueOnce(new Error("EIO: i/o error"));
    await room.flushToDisk();
    expect(dirty.size).toBe(1);
    writeSpy.mockRestore();

    await room.flushToDisk();
    expect(dirty.size).toBe(0);
    expect(
      await fs.readFile(join(projectDir(cfg, project.id), "alpha.py"), "utf-8"),
    ).toBe("alpha = 1");
    expect(
      await fs.readFile(join(projectDir(cfg, project.id), "beta.js"), "utf-8"),
    ).toBe("const beta = 2;");

    clientDoc.destroy();
    room.dispose();
  });

  it("16. External mutations are never queued as dirty, so a deleted file is not resurrected by the next flush", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("heidi", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "ExtDirtyProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const ws = makeMockWs();
    await room.addClient(ws, { userId: 1, username: "heidi", role: "editor" });

    const filePath = "doomed.py";
    const diskPath = join(projectDir(cfg, project.id), filePath);
    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText(filePath);

    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => clientText.insert(0, "print(1)")),
    );
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    // Mirrors the REST delete route: the file is removed from disk FIRST,
    // then the room is notified with empty content.
    await fs.rm(diskPath, { force: true });
    await room.handleExternalFileMutation(filePath, "");

    // The external write must not re-queue the path — otherwise the next
    // flush would recreate the just-deleted file as an empty file.
    expect((room as any).dirtyFiles.has(filePath)).toBe(false);

    clientDoc.destroy();
    room.dispose();
  });

  it("17. A crafted shared-type key cannot queue a write outside the project workspace", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("ivan", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "TraversalProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const ws = makeMockWs();
    await room.addClient(ws, { userId: 1, username: "ivan", role: "editor" });

    // Yjs keys are entirely client-controlled, and flushToDisk() joins them
    // onto the project directory.
    const evilPath = "../../escaped.txt";
    const clientDoc = new Y.Doc();
    const evilText = clientDoc.getText(evilPath);

    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => evilText.insert(0, "pwned")),
    );

    expect((room as any).dirtyFiles.has(evilPath)).toBe(false);
    expect((room as any).dirtyFiles.size).toBe(0);

    await room.flushToDisk();
    await expect(
      fs.readFile(join(projectDir(cfg, project.id), evilPath), "utf-8"),
    ).rejects.toThrow();

    clientDoc.destroy();
    room.dispose();
  });

  it("18. A valid in-workspace collaborative path persists, while a path resolving through a planted symlink is refused", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("judy", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "SymlinkProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const ws = makeMockWs();
    await room.addClient(ws, { userId: 1, username: "judy", role: "editor" });
    const workspace = projectDir(cfg, project.id);
    const clientDoc = new Y.Doc();

    // A directory OUTSIDE the project workspace, standing in for a sibling
    // project's directory (real deployments put every project directory under
    // one shared workspacesDir parent) or any host path.
    const outsideDir = await fs.mkdtemp(join(tmpdir(), "cloudide-m4-outside-"));
    const victimFile = join(outsideDir, "victim.txt");
    await fs.writeFile(victimFile, "ORIGINAL", "utf-8");

    // The attacker plants the symlink from inside their own sandbox, which is
    // bind-mounted to this workspace. A *directory* link is used because it is
    // creatable unelevated on Windows (junction) as well as on POSIX, unlike a
    // file symlink (EPERM without Developer Mode) — see the it.skipIf(IS_WINDOWS)
    // symlink cases in api.test.ts. If even this is unavailable, the platform
    // cannot host the attack, so skip rather than assert nothing.
    let symlinkSupported = true;
    try {
      await fs.symlink(outsideDir, join(workspace, "escape"), "junction");
    } catch {
      symlinkSupported = false;
    }

    try {
      // 1. A legitimate in-workspace path still persists end to end.
      const goodPath = "src/app.py";
      await fs.mkdir(join(workspace, "src"), { recursive: true });
      const goodText = clientDoc.getText(goodPath);
      room.handleMessage(
        ws,
        buildSyncUpdateFrame(clientDoc, () =>
          goodText.insert(0, "print('legit collaborative edit')"),
        ),
      );
      expect((room as any).dirtyFiles.has(goodPath)).toBe(true);

      // 2. The symlinked path passes the lexical check (no ".." at all), so it
      // reaches dirtyFiles — the realpath guard must stop it at write time.
      const evilPath = "escape/victim.txt";
      if (symlinkSupported) {
        const evilText = clientDoc.getText(evilPath);
        room.handleMessage(
          ws,
          buildSyncUpdateFrame(clientDoc, () => evilText.insert(0, "pwned")),
        );
        expect((room as any).dirtyFiles.has(evilPath)).toBe(true);
      }

      await room.flushToDisk();

      // The legitimate file landed inside the real workspace and went clean.
      expect(await fs.readFile(join(workspace, goodPath), "utf-8")).toBe(
        "print('legit collaborative edit')",
      );
      expect((room as any).dirtyFiles.has(goodPath)).toBe(false);

      if (symlinkSupported) {
        // THE ASSERTION THAT MATTERS: nothing was written through the symlink.
        // The file outside the workspace is byte-for-byte untouched.
        expect(await fs.readFile(victimFile, "utf-8")).toBe("ORIGINAL");
        // ...and the rejected path is dropped permanently rather than retried
        // forever, which would otherwise wedge scheduleIdleDisposal()'s
        // backoff loop and keep the room alive indefinitely.
        expect((room as any).dirtyFiles.has(evilPath)).toBe(false);
        expect((room as any).dirtyFiles.size).toBe(0);
      }
    } finally {
      clientDoc.destroy();
      room.dispose();
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("19. A real file_open message loads an in-workspace file into the room doc and broadcasts it to peers", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("kate", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "FileOpenProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);

    const filePath = "src/main.py";
    await fs.mkdir(join(projectDir(cfg, project.id), "src"), {
      recursive: true,
    });
    await fs.writeFile(
      join(projectDir(cfg, project.id), filePath),
      "print('on disk')",
      "utf-8",
    );

    const wsA = makeMockWs();
    const peerFrames: Uint8Array[] = [];
    const wsPeer = makeMockWs();
    wsPeer.send = (m: Uint8Array) => peerFrames.push(m);

    await room.addClient(wsA, { userId: 1, username: "kate", role: "editor" });
    await room.addClient(wsPeer, {
      userId: 1,
      username: "kate2",
      role: "viewer",
    });
    peerFrames.length = 0; // drop the initial sync/awareness handshake frames

    room.handleMessage(wsA, buildFileOpenFrame(filePath));
    await flushAsync();

    // Disk content is now live in the shared doc under the real key...
    expect(room.doc.getText(filePath).toString()).toBe("print('on disk')");
    expect((room as any).doc.share.has(filePath)).toBe(true);
    // ...and the load was broadcast to the other connected collaborator.
    expect(peerFrames.length).toBeGreaterThan(0);

    room.dispose();
  });

  it("20. A traversal path in a file_open message cannot make the server read a file outside the workspace", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("liam", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "OpenTraversalProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);

    // A real, readable file OUTSIDE the project workspace (a sibling of the
    // project directory), standing in for /etc/passwd or another tenant's file.
    const victimFile = join(tempWorkspacesDir, "victim-secret.txt");
    await fs.writeFile(victimFile, "TOP SECRET HOST CONTENT", "utf-8");
    const evilPath = "../victim-secret.txt";

    const wsA = makeMockWs();
    const peerFrames: Uint8Array[] = [];
    const wsPeer = makeMockWs();
    wsPeer.send = (m: Uint8Array) => peerFrames.push(m);

    // Lowest-privilege role: MESSAGE_CUSTOM is reachable by a viewer.
    await room.addClient(wsA, { userId: 1, username: "liam", role: "viewer" });
    await room.addClient(wsPeer, {
      userId: 1,
      username: "liam2",
      role: "viewer",
    });
    peerFrames.length = 0;

    expect(() =>
      room.handleMessage(wsA, buildFileOpenFrame(evilPath)),
    ).not.toThrow();
    await flushAsync();

    // Nothing outside the workspace was read into the shared doc...
    expect(room.doc.getText(evilPath).toString()).toBe("");
    // ...and nothing was pushed to the other collaborators in the room.
    expect(peerFrames.length).toBe(0);
    // The victim file itself is untouched and its content never leaked.
    expect(await fs.readFile(victimFile, "utf-8")).toBe(
      "TOP SECRET HOST CONTENT",
    );

    room.dispose();
  });

  it("21. A file_open path resolving through a planted symlink is refused, and a rejected key is never registered in doc.share", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("mia", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "OpenSymlinkProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const workspace = projectDir(cfg, project.id);

    const outsideDir = await fs.mkdtemp(join(tmpdir(), "cloudide-m4-outside-"));
    const victimFile = join(outsideDir, "victim.txt");
    await fs.writeFile(victimFile, "TOP SECRET HOST CONTENT", "utf-8");

    // Same technique as test 18: a directory link is creatable unelevated on
    // both Windows (junction) and POSIX. If the platform cannot host the
    // attack, skip rather than assert nothing.
    let symlinkSupported = true;
    try {
      await fs.symlink(outsideDir, join(workspace, "escape"), "junction");
    } catch {
      symlinkSupported = false;
    }

    try {
      // Contains no "..", so it clears the lexical check — only the realpath
      // guard can stop it.
      const evilPath = "escape/victim.txt";

      const wsA = makeMockWs();
      const peerFrames: Uint8Array[] = [];
      const wsPeer = makeMockWs();
      wsPeer.send = (m: Uint8Array) => peerFrames.push(m);

      await room.addClient(wsA, { userId: 1, username: "mia", role: "viewer" });
      await room.addClient(wsPeer, {
        userId: 1,
        username: "mia2",
        role: "viewer",
      });
      peerFrames.length = 0;

      if (symlinkSupported) {
        room.handleMessage(wsA, buildFileOpenFrame(evilPath));
        await flushAsync();

        // The external file's content never enters the room's doc...
        expect(room.doc.getText(evilPath).toString()).toBe("");
        // ...and was never broadcast to the other collaborator.
        expect(peerFrames.length).toBe(0);
        expect(await fs.readFile(victimFile, "utf-8")).toBe(
          "TOP SECRET HOST CONTENT",
        );
      }

      // A rejected key must never be materialized in doc.share (Y.Doc.get()
      // is what registers it), otherwise it lingers as a dangling empty
      // Y.Text that flushToDisk()'s "no dirty files" fallback would pick up.
      const traversalPath = "../../escaped-open.txt";
      room.handleMessage(wsA, buildFileOpenFrame(traversalPath));
      await flushAsync();
      expect((room as any).doc.share.has(traversalPath)).toBe(false);

      // The rejected path also never reaches disk via the fallback flush.
      await room.flushToDisk();
      await expect(
        fs.readFile(join(workspace, traversalPath), "utf-8"),
      ).rejects.toThrow();
    } finally {
      room.dispose();
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("22. A client reconnecting while idle-disposal's flush is in flight is not evicted, and the room is not destroyed out from under them", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("nora", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "ReconnectDisposeRaceProj",
    });
    const onDispose = vi.fn();
    // Real fs.writeFile is stubbed to pause on a deferred promise we control,
    // so the vulnerable window (after scheduleIdleDisposal's flushToDisk()
    // starts, before it resolves) can be entered deterministically — no
    // sleep-based timing guesses. realpath/access are stubbed the same way
    // test 13/13b do, since fake timers cannot drive real threadpool I/O.
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async () => {
      await writeGate;
    });
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: any) => p);
    const accessSpy = vi
      .spyOn(fs, "access")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();

    try {
      const room = new CollaborationRoom(project.id, cfg, db, onDispose);
      const filePath = "test.txt";

      const ws1 = makeMockWs();
      await room.addClient(ws1, {
        userId: 1,
        username: "nora",
        role: "editor",
      });
      room.doc.transact(() => {
        room.doc.getText(filePath).insert(0, "before disconnect");
      });
      room.markFileDirty(filePath);

      // Last collaborator leaves -> 10s idle grace timer starts.
      room.removeClient(ws1);

      // Fire the idle-dispose timer. Its callback starts, sees clients.size
      // === 0, and calls flushToDisk() — which is now suspended inside our
      // paused fs.writeFile mock. advanceTimersByTimeAsync only drives the
      // fake clock and fake-timer-scheduled work; it does not (and must not)
      // block on our unrelated real writeGate promise, so this resolves with
      // the disposal callback parked mid-flight.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writeSpy).toHaveBeenCalled();
      expect(onDispose).not.toHaveBeenCalled(); // still suspended, not disposed yet

      // A client reconnects to the SAME project while the flush is still in
      // flight — exactly the vulnerable window.
      let ws2Closed: number | undefined;
      const ws2 = makeMockWs();
      ws2.close = (code: number) => {
        ws2Closed = code;
      };
      await room.addClient(ws2, {
        userId: 1,
        username: "nora",
        role: "editor",
      });
      expect(room.clients.size).toBe(1);

      // Now let the paused write complete and the disposal callback resume.
      releaseWrite();
      await vi.advanceTimersByTimeAsync(0);

      // THE ASSERTIONS THAT MATTER: the reconnected client must not have
      // been evicted, and the room must not have been torn down out from
      // under them just because the flush that raced their reconnect
      // happened to see an empty client list a moment earlier.
      expect(ws2Closed).toBeUndefined();
      expect(room.clients.has(ws2)).toBe(true);
      expect(onDispose).not.toHaveBeenCalled();
      // The room's content survived too — the reconnecting client can still
      // see it, not a freshly-destroyed empty doc.
      expect(room.doc.getText(filePath).toString()).toBe("before disconnect");

      room.dispose();
    } finally {
      writeSpy.mockRestore();
      realpathSpy.mockRestore();
      accessSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("23. Three concurrent editors converge to identical content via real sync-protocol messages, and no one's edit is lost", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice3", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob3", "h", "user"); // id 2
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("carol3", "h", "user"); // id 3

    const project = await createProject(cfg, db, 1, {
      name: "ThreeEditorProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "shared.py";

    const names = ["alice3", "bob3", "carol3"] as const;
    const wsList = names.map(() => makeMockWs());
    const clientDocs = names.map(() => new Y.Doc());

    // Each client's socket is wired for real round-trip delivery (Sync Step
    // 1/2 handshake + subsequent broadcasts) before connecting, exactly like
    // a real client attaches its message handler before the socket opens.
    for (let i = 0; i < names.length; i++) {
      wireClientToRoom(room, wsList[i], clientDocs[i]);
      await room.addClient(wsList[i], {
        userId: i + 1,
        username: names[i],
        role: "editor",
      });
    }

    // All three replicas (room + 3 clients) start converged (empty file).
    // The initial Sync Step 1/2 handshake is immediate/uncoalesced (M6:
    // "never delay the initial synchronization handshake"), so this holds
    // with no timer advance.
    for (const doc of clientDocs) {
      expect(doc.getText(filePath).toString()).toBe(
        room.doc.getText(filePath).toString(),
      );
    }

    // M6: broadcasts to OTHER clients are now coalesced within a short
    // window (see collab/manager.ts's DEFAULT_YJS_COALESCE_MS) instead of
    // sent synchronously — advance fake timers past that window before
    // asserting peer delivery, rather than relying on real elapsed time.
    vi.useFakeTimers();
    try {
      // Each client edits independently, based on the state it had *before*
      // seeing either peer's edit — genuine concurrent/divergent edits, not a
      // serialized turn-taking simulation.
      const edits = [
        "# Alice's contribution\n",
        "# Bob's contribution\n",
        "# Carol's contribution\n",
      ];
      for (let i = 0; i < names.length; i++) {
        const clientText = clientDocs[i].getText(filePath);
        room.handleMessage(
          wsList[i],
          buildSyncUpdateFrame(clientDocs[i], () =>
            clientText.insert(0, edits[i]),
          ),
        );
      }
      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);

      const roomContent = room.doc.getText(filePath).toString();
      for (const edit of edits) {
        expect(roomContent).toContain(edit.trim());
      }

      // Every client replica — not just the room — converged to the exact
      // same final text: proves broadcasts actually reached every peer, not
      // just that the room's own doc integrated all three updates.
      for (let i = 0; i < names.length; i++) {
        expect(clientDocs[i].getText(filePath).toString()).toBe(roomContent);
      }

      // Bob disconnects; Alice and Carol remain and must stay correct and
      // still receive each other's subsequent edits.
      room.removeClient(wsList[1]);
      const aliceText = clientDocs[0].getText(filePath);
      room.handleMessage(
        wsList[0],
        buildSyncUpdateFrame(clientDocs[0], () =>
          aliceText.insert(aliceText.length, "# Alice again\n"),
        ),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_YJS_COALESCE_MS);

      expect(clientDocs[2].getText(filePath).toString()).toBe(
        room.doc.getText(filePath).toString(),
      );
      expect(clientDocs[2].getText(filePath).toString()).toContain(
        "Alice again",
      );
    } finally {
      vi.useRealTimers();
    }

    for (const doc of clientDocs) doc.destroy();
    room.dispose();
  });

  it("24. Bounded reconnect storm across 3 clients converges correctly with no presence corruption and no premature disposal", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("storm1", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("storm2", "h", "user"); // id 2
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("storm3", "h", "user"); // id 3

    const project = await createProject(cfg, db, 1, { name: "StormProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "storm.py";
    const baselineAwareness = room.awareness.getStates().size;

    const NUM_CLIENTS = 3;
    const CYCLES = 3;
    // Deliberately bounded and deterministic: a fixed small matrix of
    // connect/edit/present/disconnect cycles, not an open-ended stress loop.
    let lastWs: any;
    let lastAwareness: awarenessProtocol.Awareness | undefined;
    let lastClientId: number | undefined;

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (let i = 0; i < NUM_CLIENTS; i++) {
        const ws = makeMockWs();
        const clientDoc = new Y.Doc();
        const clientAwareness = new awarenessProtocol.Awareness(clientDoc);
        const isLast = cycle === CYCLES - 1 && i === NUM_CLIENTS - 1;

        await room.addClient(ws, {
          userId: i + 1,
          username: `storm${i + 1}`,
          role: "editor",
        });
        // Each reconnect uses a brand-new Awareness (a fresh random
        // clientID, exactly like a real reloaded browser tab) — presence
        // must never be inherited from a prior, now-defunct connection.
        room.handleMessage(
          ws,
          buildAwarenessFrame(clientAwareness, {
            name: `storm${i + 1}`,
            cycle,
          }),
        );
        const clientText = clientDoc.getText(filePath);
        room.handleMessage(
          ws,
          buildSyncUpdateFrame(clientDoc, () =>
            clientText.insert(clientText.length, `c${cycle}u${i};`),
          ),
        );

        if (isLast) {
          // Keep the very last connection of the storm alive so the room's
          // end state (still-connected client) can be asserted.
          lastWs = ws;
          lastAwareness = clientAwareness;
          lastClientId = clientAwareness.clientID;
        } else {
          room.removeClient(ws);
          clientAwareness.destroy();
          clientDoc.destroy();
        }

        // The room must never be disposed mid-storm: every disconnect here
        // is immediately followed by another connect, well within the idle
        // grace period, and no fake-timer advance ever lets the 10s timer
        // fire during this test.
        expect(onDispose).not.toHaveBeenCalled();
      }
    }

    // Final content contains every cycle's edit from every client — nothing
    // was silently dropped across the reconnect churn.
    const finalContent = room.doc.getText(filePath).toString();
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (let i = 0; i < NUM_CLIENTS; i++) {
        expect(finalContent).toContain(`c${cycle}u${i};`);
      }
    }

    // Presence isolation across the whole storm: only the single
    // still-connected client's awareness state remains. Every earlier
    // cycle's disconnected clients' presence was fully cleaned up — none
    // linger, and the last connection did not inherit any of them.
    expect(room.clients.size).toBe(1);
    const finalStates = room.awareness.getStates();
    expect(finalStates.size).toBe(baselineAwareness + 1);
    expect(finalStates.has(lastClientId!)).toBe(true);

    lastAwareness?.destroy();
    room.removeClient(lastWs);
    room.dispose();
  });

  it("25. Many rooms created and disposed across the manager leave no dangling entries", async () => {
    const projectIds: string[] = [];
    // Safely under the default per-owner projectQuota (20) — this test is
    // about manager bookkeeping at moderate room count, not project quota
    // limits, which are covered elsewhere.
    const ROOM_COUNT = 15;

    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("soak_owner", "h", "user"); // id 1

    const baselineActive = collaborationManager.getActiveRoomCount();

    for (let i = 0; i < ROOM_COUNT; i++) {
      const project = await createProject(cfg, db, 1, {
        name: `SoakProj${i}`,
      });
      projectIds.push(project.id);
      const room = collaborationManager.getOrCreateRoom(project.id);
      const ws = makeMockWs();
      await room.addClient(ws, {
        userId: 1,
        username: "soak_owner",
        role: "owner",
      });
      room.doc.transact(() => {
        room.doc.getText("f.txt").insert(0, `room ${i}`);
      });
      room.markFileDirty("f.txt");
      // dispose() itself never flushes (by design — the project-deletion
      // path that normally calls it has nothing worth persisting), so flush
      // explicitly first, mirroring what the real idle-disposal path does
      // before it disposes. This test is about manager bookkeeping at
      // moderate room count and content survival, not disposal timing.
      await room.flushToDisk();
      room.dispose();
    }

    expect(collaborationManager.getActiveRoomCount()).toBe(baselineActive);
    for (const projectId of projectIds) {
      expect(collaborationManager.getRoom(projectId)).toBeUndefined();
    }

    // Content was actually flushed before disposal for every room, not
    // silently dropped at scale.
    for (let i = 0; i < ROOM_COUNT; i++) {
      const content = await fs.readFile(
        join(projectDir(cfg, projectIds[i]), "f.txt"),
        "utf-8",
      );
      expect(content).toBe(`room ${i}`);
    }
  });

  // --- M37: ghost-file resurrection fix -----------------------------------
  //
  // Root cause: handleExternalFileMutation("", path) called doc.getText(path)
  // unconditionally, which materializes `path` as an empty Y.Text in
  // doc.share as a side effect — even for a path the room never tracked.
  // flushToDisk()'s "dirtyFiles is empty" fallback then iterated every
  // Y.Text in doc.share with no emptiness check, writing that dangling empty
  // key back to disk as a 0-byte file. The /move and /delete routes call
  // handleExternalFileMutation(path, "") for every affected old/deleted path
  // specifically to guard against *stale* content resurrecting — the guard
  // itself was what created the resurrection vector for paths that were
  // never stale (never tracked) in the first place. Reproduced end-to-end
  // against a live server with: open a collab WS -> rename via /move ->
  // delete via /delete -> close the WS -> wait past the 10s idle-dispose
  // delay -> both the renamed-away and deleted paths reappeared as 0-byte
  // files. Test 16 above only asserted the path left dirtyFiles; it never
  // called flushToDisk() afterward, so it could not have caught this.

  it("26. The exact bug: an empty external mutation for a never-tracked path materializes nothing, and a subsequent empty-dirtyFiles flush does not resurrect it", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("oscar", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "GhostBugProj" });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "never-existed.py";
    const diskPath = join(projectDir(cfg, project.id), filePath);

    // The room never loaded, edited, or otherwise touched this path.
    expect((room as any).doc.share.has(filePath)).toBe(false);

    // Exactly what /move and /delete call for every affected old/deleted
    // path, unconditionally, whether or not the room ever tracked it.
    await room.handleExternalFileMutation(filePath, "");

    // With the fix: no key was materialized at all.
    expect((room as any).doc.share.has(filePath)).toBe(false);

    // dirtyFiles is empty (nothing else happened in this room), so this
    // exercises the exact fallback branch that resurrected the file before
    // the fix.
    expect((room as any).dirtyFiles.size).toBe(0);
    await room.flushToDisk();

    await expect(fs.readFile(diskPath, "utf-8")).rejects.toThrow();

    room.dispose();
  });

  it("27. Rename case: notifying the old path after a move leaves it absent from disk through an idle-style flush", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("pia", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "GhostRenameProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const oldPath = "main.py";
    const newPath = "renamed.py";
    const oldDiskPath = join(projectDir(cfg, project.id), oldPath);
    const newDiskPath = join(projectDir(cfg, project.id), newPath);

    // Mirrors POST /:id/move exactly: the file was never opened/tracked in
    // this room (no ensureFileLoaded/file_open ever happened for it), and
    // the actual disk rename already happened before these calls.
    await fs.writeFile(newDiskPath, "print('renamed')", "utf-8");
    await room.handleExternalFileMutation(oldPath, "");
    await room.handleExternalFileMutation(newPath, "print('renamed')");

    expect((room as any).doc.share.has(oldPath)).toBe(false);
    expect((room as any).dirtyFiles.size).toBe(0);

    await room.flushToDisk();

    await expect(fs.readFile(oldDiskPath, "utf-8")).rejects.toThrow();
    expect(await fs.readFile(newDiskPath, "utf-8")).toBe("print('renamed')");

    room.dispose();
  });

  it("28. Delete case: notifying the deleted path leaves it absent from disk through an idle-style flush", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("quinn", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "GhostDeleteProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "doomed.py";
    const diskPath = join(projectDir(cfg, project.id), filePath);

    // Mirrors POST /:id/delete: the file is removed from disk first, then
    // the room is notified — and, as in the real bug, this room never had
    // the file open/tracked at all.
    await fs.writeFile(diskPath, "print('about to die')", "utf-8");
    await fs.rm(diskPath, { force: true });
    await room.handleExternalFileMutation(filePath, "");

    expect((room as any).doc.share.has(filePath)).toBe(false);
    expect((room as any).dirtyFiles.size).toBe(0);

    await room.flushToDisk();

    await expect(fs.readFile(diskPath, "utf-8")).rejects.toThrow();

    room.dispose();
  });

  it("29. Real-edit regression: the primary dirtyFiles-driven flush path is untouched by the ghost-key guards", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("river", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "GhostRealEditProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "real-work.py";
    const diskPath = join(projectDir(cfg, project.id), filePath);
    const content = "def real():\n    return 42\n";

    // A genuine collaborative edit, tracked via the normal markFileDirty path
    // (not an external mutation), exactly like test 2 above.
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, content);
    });
    room.markFileDirty(filePath);
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    await room.flushToDisk();

    expect(await fs.readFile(diskPath, "utf-8")).toBe(content);
    expect((room as any).dirtyFiles.has(filePath)).toBe(false);

    room.dispose();
  });

  it("30. Externally created file: a never-tracked path with real non-empty content is still seeded and persisted correctly", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("sage", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "GhostExternalCreateProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "brand-new.py";
    const diskPath = join(projectDir(cfg, project.id), filePath);
    const content = "print('created externally with real content')";

    // Mirrors POST /:id/file (create/save): the file did not exist in this
    // room before, and the notification carries real, non-empty content —
    // the guard must not suppress this legitimate case.
    expect((room as any).doc.share.has(filePath)).toBe(false);
    await room.handleExternalFileMutation(filePath, content);

    expect((room as any).doc.share.has(filePath)).toBe(true);
    expect(room.doc.getText(filePath).toString()).toBe(content);
    expect((room as any).dirtyFiles.size).toBe(0);

    await room.flushToDisk();

    expect(await fs.readFile(diskPath, "utf-8")).toBe(content);

    room.dispose();
  });

  it("31. No ghost keys: an empty external mutation for an unknown path never registers a doc.share entry", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("tara", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "GhostNoKeyProj",
    });
    const onDispose = vi.fn();
    const room = new CollaborationRoom(project.id, cfg, db, onDispose);
    const filePath = "unknown/path/that/never/existed.txt";

    await room.handleExternalFileMutation(filePath, "");

    expect((room as any).doc.share.has(filePath)).toBe(false);

    room.dispose();
  });
});
