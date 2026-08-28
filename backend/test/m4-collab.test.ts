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
import { importProjectZip } from "../src/projects/archive.js";
import { createZipArchive } from "../src/projects/zip.js";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
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

  it("3. External file mutation safety: converges the Y.Doc when safe, refuses to clobber an unpersisted collaborator edit", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("owner_u", "h", "user");
    const project = await createProject(cfg, db, 1, { name: "ExternalProj" });
    const room = collaborationManager.getOrCreateRoom(project.id);

    // (a) Safe case — a file with no unpersisted collaborator edits converges
    // to the external content (a genuine on-disk change flowing into the room).
    const calm = "calm.js";
    await room.ensureFileLoaded(calm);
    const externalContent =
      'const port = 8080;\nconsole.log("external change");';
    const applied = await collaborationManager.notifyExternalFileMutation(
      project.id,
      calm,
      externalContent,
    );
    expect(applied).toEqual({ applied: true, conflict: false });
    expect(room.doc.getText(calm).toString()).toBe(externalContent);

    // (b) Conflict case — a file the collaborator has edited but not yet
    // flushed is NOT overwritten by a divergent external write. Pre-fix this
    // blindly replaced the Y.Text and the "3000" edit was silently lost.
    const hot = "hot.js";
    const hotText = await room.ensureFileLoaded(hot);
    hotText.insert(0, "const port = 3000;");
    room.markFileDirty(hot);
    const refused = await collaborationManager.notifyExternalFileMutation(
      project.id,
      hot,
      'const port = 8080;\nconsole.log("stale");',
    );
    expect(refused).toEqual({ applied: false, conflict: true });
    expect(room.doc.getText(hot).toString()).toBe("const port = 3000;");
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

  it("10. Snapshot restore does not silently revert a collaborator's unsaved edit; disk reconverges to the live content", async () => {
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

    // A collaborator has the file open with further, uncommitted local edits
    // that live only in the Y.Doc (not yet flushed to disk).
    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded(filePath);
    expect(yText.toString()).toBe("print('v2')");
    yText.delete(0, yText.length);
    yText.insert(0, "print('v3, unsaved local edit')");

    await restoreSnapshot(cfg, db, 1, project.id, snapshot.id);

    // The restore wrote the snapshot content to disk...
    expect(await fs.readFile(workspaceFile, "utf-8")).toBe("print('v1')");

    // ...but the collaborator's UNPERSISTED edit is not discarded. Pre-fix
    // the restore blindly replaced the Y.Text (delete-all + insert) and the
    // edit was silently lost; now the room detects the conflict and keeps
    // the authoritative live content.
    expect(yText.toString()).toBe("print('v3, unsaved local edit')");

    // Because the live content is authoritative, the next flush reconverges
    // disk to it rather than leaving the half-applied restore in place.
    await room.flushToDisk();
    expect(await fs.readFile(workspaceFile, "utf-8")).toBe(
      "print('v3, unsaved local edit')",
    );
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

  // --- M38: collaboration zombie-room race on project deletion ------------
  //
  // Root cause: deleteProject() disposes the active collaboration room
  // early, then tears down the sandbox and telemetry state, removes the
  // workspace/snapshot directories, and only deletes the project's DB row
  // as its LAST statement. requireProjectAccess()/getProject() are pure DB
  // lookups, so throughout that entire teardown window the project row
  // still "exists" from the WS upgrade handler's point of view. A client
  // reconnecting during that window recreates a room via getOrCreateRoom()
  // — reproduced live against a real server with a 5ms-staggered concurrent
  // DELETE + reconnect, which succeeded on the first attempt every time. An
  // edit sent into that resurrected room was silently dropped (flushToDisk's
  // realpath/assertInsideWorkspace guard throws ENOENT once the workspace
  // directory is gone, caught by the same branch that logs a misleading
  // "path escapes the workspace" warning and permanently drops the file from
  // dirtyFiles) with no error or close signal ever reaching the client.
  //
  // Fix: a second `collaborationManager.getRoom(project.id)?.dispose()`
  // immediately after the DB row delete, mirroring the RECONNECT step
  // workspaceRestore.ts already uses (and already tests, see test #10 in
  // workspace-restore.test.ts) for the identical race shape.

  it("26. Existing normal delete still disposes an active room and closes its client with the standard code (no regression from the added second dispose)", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("uma", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "NormalDeleteNoRaceProj",
    });
    const room = collaborationManager.getOrCreateRoom(project.id);
    const ws = makeMockWs();
    let closeCode: number | undefined;
    let closeCallCount = 0;
    ws.close = (code: number) => {
      closeCallCount++;
      closeCode = code;
    };
    await room.addClient(ws, { userId: 1, username: "uma", role: "owner" });
    expect(collaborationManager.getRoom(project.id)).toBe(room);

    await deleteProject(cfg, db, 1, project.id);

    // The one real room is disposed exactly once (closeCallCount, not the
    // dispose count itself, is the observable proxy here): the added second
    // dispose() call finds no room (getRoom returns undefined post-delete)
    // and is a clean no-op, not a double-close of the same socket.
    expect(closeCallCount).toBe(1);
    expect(closeCode).toBe(1001);
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
  });

  it("27. Racing reconnect during project deletion: a room created after the first dispose (project row still visible) is disposed by the post-delete safety net, its client is closed normally, and the project is genuinely gone", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("vic", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "DeleteReconnectRaceProj",
    });

    // An initial room/client, matching the pre-existing (test 9) scenario,
    // so the FIRST dispose has something real to close before the race
    // window even opens.
    const preRoom = collaborationManager.getOrCreateRoom(project.id);
    const preWs = makeMockWs();
    let preCloseCode: number | undefined;
    preWs.close = (code: number) => {
      preCloseCode = code;
    };
    await preRoom.addClient(preWs, {
      userId: 1,
      username: "vic",
      role: "owner",
    });

    // Pause deleteProject() at its workspace-removal fs.rm call: by the time
    // execution reaches this await, the first dispose, sandbox teardown, and
    // telemetry teardown have already run, but the DB row delete (the
    // function's last statement) has not — exactly the race window this
    // milestone closes. Same deferred-gate technique as test 22 above.
    let releaseRm!: () => void;
    const rmGate = new Promise<void>((resolve) => {
      releaseRm = resolve;
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      await rmGate;
    });

    const deletePromise = deleteProject(cfg, db, 1, project.id);
    await new Promise((r) => setTimeout(r, 20));

    // The first dispose already ran and removed preRoom...
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
    // ...but the project row is still visible: this is exactly what lets a
    // reconnect through requireProjectAccess() during teardown.
    expect(() => requireProjectAccess(db, 1, project.id)).not.toThrow();

    // Simulate the race: a client reconnects here, mirroring exactly what
    // the /ws/collab upgrade handler does on a successful auth check.
    const raceRoom = collaborationManager.getOrCreateRoom(project.id);
    expect(collaborationManager.getRoom(project.id)).toBe(raceRoom);
    const raceWs = makeMockWs();
    let raceCloseCode: number | undefined;
    raceWs.close = (code: number) => {
      raceCloseCode = code;
    };
    await raceRoom.addClient(raceWs, {
      userId: 1,
      username: "vic",
      role: "owner",
    });

    // Let deleteProject() finish: unblocks the paused fs.rm, runs the
    // snapshot-dir rm, the DB row delete, then the new second dispose.
    releaseRm();
    await deletePromise;
    rmSpy.mockRestore();

    // RACE_ROOM_CLOSED: the race-created room is gone, not left running.
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
    // CLIENT SIGNAL: the race-created connection got the normal disposal
    // close code, not silent continuation.
    expect(raceCloseCode).toBe(1001);
    expect(preCloseCode).toBe(1001);

    // POST_DELETE_RECONNECT: the project row is genuinely gone — a further
    // access attempt gets the existing, unmodified IDOR-safe "not found"
    // behavior, the same as any other deleted project.
    expect(() => requireProjectAccess(db, 1, project.id)).toThrowError(
      /not found/,
    );
  });

  it("28. A race-created room cannot silently persist an edit after the project is deleted: the edit never reaches disk and the room does not survive to retry it", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("wren", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "DeleteRaceSilentLossProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "zombie.py");

    let releaseRm!: () => void;
    const rmGate = new Promise<void>((resolve) => {
      releaseRm = resolve;
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      await rmGate;
    });

    const deletePromise = deleteProject(cfg, db, 1, project.id);
    await new Promise((r) => setTimeout(r, 20));

    // Race-created room, plus a real collaborative edit sent into it while
    // the project row is still (briefly) visible — exactly the scenario
    // that silently dropped content before this fix.
    const raceRoom = collaborationManager.getOrCreateRoom(project.id);
    const raceWs = makeMockWs();
    await raceRoom.addClient(raceWs, {
      userId: 1,
      username: "wren",
      role: "owner",
    });
    raceRoom.doc.transact(() => {
      raceRoom.doc.getText("zombie.py").insert(0, "print('doomed edit')");
    });
    raceRoom.markFileDirty("zombie.py");
    expect((raceRoom as any).dirtyFiles.has("zombie.py")).toBe(true);

    releaseRm();
    await deletePromise;
    rmSpy.mockRestore();

    // The room is gone — disposed by the safety net before its own debounced
    // flush timers could ever fire, so there is no lingering retry loop.
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
    // Nothing was ever written for a project whose workspace no longer
    // exists.
    await expect(fs.readFile(diskPath, "utf-8")).rejects.toThrow();
  });

  // --- M39: collaboration race during workspace-replacement import --------
  //
  // Root cause: importProjectZip() (replace=true) disposes the active
  // collaboration room once, early, then tears down the sandbox and
  // telemetry state, then wipes and repopulates the workspace directory.
  // Unlike deleteProject(), the project's DB row is NEVER touched by an
  // import, so requireProjectAccess() succeeds throughout the entire
  // operation -- any reconnect during the async window between the first
  // dispose and the actual file replacement creates a fresh room that reads
  // STALE, pre-import content straight off disk (the wipe hasn't happened
  // yet). Reproduced live against a real server with a precisely time-mapped
  // stagger sweep (0-40ms): the first dispose fires at ~21-23ms, the whole
  // import completes at ~290-300ms (widened by stopProjectSandbox's
  // unconditional `docker rm -f` attempt even with no sandbox running) --
  // reconnects landing in that ~270ms window created a room that survived
  // the import entirely (no second dispose existed), and a real edit sent
  // through it silently overwrote the freshly-imported file with the old
  // content plus the new edit moments later.
  //
  // Precondition verified before this fix (not assumed): CollaborationRoom
  // .dispose() unconditionally closes every client registered on that room
  // instance (ws.close(1001, ...) for each, then removes the room from the
  // manager's map as its last, synchronous step) -- so no client can ever
  // remain continuously connected across a dispose call. Every connection
  // present after the first dispose is therefore, by construction, a fresh
  // reconnect, never a survivor. This is what makes an UNCONDITIONAL second
  // dispose safe here: anything connected when it runs either raced in with
  // stale content (must be torn down) or connected in the sub-millisecond
  // gap after replacement finished and would just need one harmless extra
  // reconnect either way -- the same accepted tradeoff M38 and
  // workspaceRestore.ts's RECONNECT step already establish for this exact
  // dispose-based mitigation shape.

  it("29. Normal (non-racing) import still disposes any pre-existing room exactly once, produces correct content, and leaves no room behind (no regression from the added second dispose)", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("xena", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "ImportNormalNoRaceProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "main.py");
    await fs.writeFile(diskPath, "print('OLD CONTENT')\n", "utf-8");

    const room = collaborationManager.getOrCreateRoom(project.id);
    const ws = makeMockWs();
    let closeCode: number | undefined;
    let closeCallCount = 0;
    ws.close = (code: number) => {
      closeCallCount++;
      closeCode = code;
    };
    await room.addClient(ws, { userId: 1, username: "xena", role: "owner" });
    expect(collaborationManager.getRoom(project.id)).toBe(room);

    const zip = createZipArchive([
      { path: "main.py", content: Buffer.from("print('NEW CONTENT')\n") },
    ]);
    const result = await importProjectZip(cfg, db, 1, project.id, zip, {
      replace: true,
    });

    expect(result.ok).toBe(true);
    // The pre-existing client is closed exactly once -- the added second
    // dispose finds no room left (getRoom returns undefined) and is a clean
    // no-op, not a double-close of the same socket.
    expect(closeCallCount).toBe(1);
    expect(closeCode).toBe(1001);
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
    expect(await fs.readFile(diskPath, "utf-8")).toBe("print('NEW CONTENT')\n");
  });

  it("30. Exact race: a room created after the first dispose but before workspace replacement reads stale pre-import content, and is disposed by the second (post-replacement) safety net", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("yara", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "ImportRaceStaleReadProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "main.py");
    await fs.writeFile(diskPath, "print('OLD CONTENT')\n", "utf-8");

    // Pause importProjectZip() at its workspace-wipe fs.rm call: by the time
    // execution reaches this await, the first dispose, sandbox teardown, and
    // telemetry teardown have already run, but the old files are still on
    // disk (the wipe/repopulate hasn't happened) -- exactly the race window
    // this milestone closes. Same deferred-gate technique as tests 22/27/28.
    let releaseRm!: () => void;
    const rmGate = new Promise<void>((resolve) => {
      releaseRm = resolve;
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      await rmGate;
    });

    const zip = createZipArchive([
      {
        path: "main.py",
        content: Buffer.from("print('NEW CONTENT FROM IMPORT')\n"),
      },
    ]);
    const importPromise = importProjectZip(cfg, db, 1, project.id, zip, {
      replace: true,
    });
    await new Promise((r) => setTimeout(r, 20));

    // The first dispose already ran (nothing was registered before this
    // test's own race room, so nothing to observe there directly) -- the
    // meaningful check is that the workspace still holds the OLD content.
    expect(await fs.readFile(diskPath, "utf-8")).toBe("print('OLD CONTENT')\n");

    // Simulate the race: a fresh room is created and loads whatever is
    // actually on disk right now -- the stale, pre-import content.
    const raceRoom = collaborationManager.getOrCreateRoom(project.id);
    expect(collaborationManager.getRoom(project.id)).toBe(raceRoom);
    const yText = await raceRoom.ensureFileLoaded("main.py");
    expect(yText.toString()).toBe("print('OLD CONTENT')\n");

    const raceWs = makeMockWs();
    let raceCloseCode: number | undefined;
    raceWs.close = (code: number) => {
      raceCloseCode = code;
    };
    await raceRoom.addClient(raceWs, {
      userId: 1,
      username: "yara",
      role: "owner",
    });

    // Let the import finish: unblocks the paused fs.rm, runs the actual
    // wipe/repopulate, cache invalidation, audit log, then the new second
    // dispose, then the staging-dir cleanup in the finally block.
    releaseRm();
    await importPromise;
    rmSpy.mockRestore();

    // The race-created room is gone, and its client got the normal
    // disposal close code, not silent continuation.
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
    expect(raceCloseCode).toBe(1001);
    // The import's own result is authoritative on disk.
    expect(await fs.readFile(diskPath, "utf-8")).toBe(
      "print('NEW CONTENT FROM IMPORT')\n",
    );
  });

  it("31. A real edit sent into the race-created room before the second dispose never overwrites the imported content", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("zane", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "ImportRaceStaleWriteProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "main.py");
    await fs.writeFile(diskPath, "print('OLD CONTENT')\n", "utf-8");

    let releaseRm!: () => void;
    const rmGate = new Promise<void>((resolve) => {
      releaseRm = resolve;
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      await rmGate;
    });

    const zip = createZipArchive([
      {
        path: "main.py",
        content: Buffer.from("print('NEW CONTENT FROM IMPORT')\n"),
      },
    ]);
    const importPromise = importProjectZip(cfg, db, 1, project.id, zip, {
      replace: true,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Race-created room, loaded with stale content, plus a REAL
    // collaborative edit sent into it before the import finishes -- exactly
    // the scenario that silently clobbered the import before this fix.
    const raceRoom = collaborationManager.getOrCreateRoom(project.id);
    const yText = await raceRoom.ensureFileLoaded("main.py");
    raceRoom.doc.transact(() => {
      yText.insert(yText.length, "print('EDIT SENT INTO RACE ROOM')\n");
    });
    raceRoom.markFileDirty("main.py");
    expect((raceRoom as any).dirtyFiles.has("main.py")).toBe(true);

    releaseRm();
    await importPromise;
    rmSpy.mockRestore();

    // The race room is gone -- disposed before its own debounced flush
    // timer could ever fire, so there is no lingering retry that could
    // still clobber the import later either.
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();
    // The imported content is untouched by the stale edit.
    expect(await fs.readFile(diskPath, "utf-8")).toBe(
      "print('NEW CONTENT FROM IMPORT')\n",
    );
  });

  it("32. Legitimate reconnect semantics: old client -> first dispose -> race reconnect -> second dispose -> a reconnect AFTER completion sees correct content and is not disposed", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("aria", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "ImportLegitReconnectProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "main.py");
    await fs.writeFile(diskPath, "print('OLD CONTENT')\n", "utf-8");

    // Step 1: an "old" client, connected before the import starts.
    const oldRoom = collaborationManager.getOrCreateRoom(project.id);
    const oldWs = makeMockWs();
    let oldCloseCode: number | undefined;
    oldWs.close = (code: number) => {
      oldCloseCode = code;
    };
    await oldRoom.addClient(oldWs, {
      userId: 1,
      username: "aria",
      role: "owner",
    });

    let releaseRm!: () => void;
    const rmGate = new Promise<void>((resolve) => {
      releaseRm = resolve;
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      await rmGate;
    });

    const zip = createZipArchive([
      {
        path: "main.py",
        content: Buffer.from("print('NEW CONTENT FROM IMPORT')\n"),
      },
    ]);
    const importPromise = importProjectZip(cfg, db, 1, project.id, zip, {
      replace: true,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Step 2: the first dispose already ran -- the old client is gone, not
    // preserved. There is no such thing as a client that "remains
    // continuously connected" across a dispose in this architecture.
    expect(oldCloseCode).toBe(1001);
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();

    // Step 3: a reconnect during the race window -- necessarily stale,
    // necessarily torn down by the second dispose below.
    const raceRoom = collaborationManager.getOrCreateRoom(project.id);
    const raceWs = makeMockWs();
    let raceCloseCode: number | undefined;
    raceWs.close = (code: number) => {
      raceCloseCode = code;
    };
    await raceRoom.addClient(raceWs, {
      userId: 1,
      username: "aria",
      role: "owner",
    });

    // Step 4: let the import complete -- runs the second dispose.
    releaseRm();
    await importPromise;
    rmSpy.mockRestore();

    expect(raceCloseCode).toBe(1001);
    expect(collaborationManager.getRoom(project.id)).toBeUndefined();

    // Step 5: a reconnect AFTER the import has genuinely finished gets a
    // brand-new room with the correct, authoritative imported content, and
    // is not itself disposed by anything left over from the import.
    const finalRoom = collaborationManager.getOrCreateRoom(project.id);
    const finalWs = makeMockWs();
    let finalCloseCode: number | undefined;
    finalWs.close = (code: number) => {
      finalCloseCode = code;
    };
    await finalRoom.addClient(finalWs, {
      userId: 1,
      username: "aria",
      role: "owner",
    });
    const finalText = await finalRoom.ensureFileLoaded("main.py");
    expect(finalText.toString()).toBe("print('NEW CONTENT FROM IMPORT')\n");
    expect(finalCloseCode).toBeUndefined();
    expect(collaborationManager.getRoom(project.id)).toBe(finalRoom);

    finalRoom.dispose();
  });

  // ---------------------------------------------------------------------------
  // M52 — Yjs/Monaco initial-load seed-race fix (server side).
  //
  // The client no longer seeds the shared Y.Text from its local Monaco model
  // on bind; instead it waits for an explicit `{type:"file_ready"}` custom
  // frame the room now emits once it has loaded a file from disk. These
  // cases pin the server half of that contract.
  // ---------------------------------------------------------------------------

  function decodeCustomFrames(frames: Uint8Array[]): any[] {
    const out: any[] = [];
    for (const m of frames) {
      const d = decoding.createDecoder(m);
      if (decoding.readVarUint(d) !== MESSAGE_CUSTOM) continue;
      try {
        out.push(JSON.parse(decoding.readVarString(d)));
      } catch {}
    }
    return out;
  }

  it("33. file_open triggers a `file_ready` custom frame back to the requesting client once the file is loaded from disk", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("olga", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, { name: "FileReadyProj" });
    await fs.writeFile(
      join(projectDir(cfg, project.id), "notes.txt"),
      "DISK",
      "utf-8",
    );

    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const frames: Uint8Array[] = [];
    const ws = makeMockWs();
    ws.send = (m: Uint8Array) => frames.push(m);
    await room.addClient(ws, { userId: 1, username: "olga", role: "editor" });
    frames.length = 0; // drop the initial handshake frames

    room.handleMessage(ws, buildFileOpenFrame("notes.txt"));
    await flushAsync();

    // Disk content is now live under the real key...
    expect(room.doc.getText("notes.txt").toString()).toBe("DISK");
    // ...and the client received the readiness signal for that exact path.
    expect(decodeCustomFrames(frames)).toContainEqual({
      type: "file_ready",
      path: "notes.txt",
    });

    room.dispose();
  });

  it("34. A path-escape key in file_open never registers in doc.share and never reaches disk, even though a file_ready may still be signalled", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("pete", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "FileReadyEscapeProj",
    });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const frames: Uint8Array[] = [];
    const ws = makeMockWs();
    ws.send = (m: Uint8Array) => frames.push(m);
    await room.addClient(ws, { userId: 1, username: "pete", role: "editor" });
    frames.length = 0;

    // Point the escape at a real, WRITABLE location that is genuinely
    // outside the workspace and cannot pre-exist — a uniquely-named probe
    // file in the (separate) data dir. If the path guard ever regressed and
    // the server wrote the key, this file would appear; if the guard holds,
    // reading it fails with ENOENT on every platform. (The prior
    // "../../../etc/passwd" target silently passed on Windows and FAILED on
    // Linux, where /etc/passwd always exists regardless of the server.)
    const escapeAbs = join(
      cfg.dataDir,
      `collab-escape-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const evil = relative(projectDir(cfg, project.id), escapeAbs)
      .split(sep)
      .join("/");

    expect(() =>
      room.handleMessage(ws, buildFileOpenFrame(evil)),
    ).not.toThrow();
    await flushAsync();

    // ensureFileLoaded refuses the path and returns a DETACHED Y.Text, so the
    // key is never materialized in the shared doc and nothing is queued.
    expect((room as any).doc.share.has(evil)).toBe(false);
    expect((room as any).dirtyFiles.size).toBe(0);

    // Nothing is written for the bad key on a flush.
    await room.flushToDisk();
    await expect(fs.readFile(escapeAbs, "utf-8")).rejects.toThrow();

    room.dispose();
  });

  it("35. Disk byte fidelity: a real sync-protocol edit on a loaded file flushes back byte-for-byte, trailing newline included", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("quinn", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "ByteFidelityProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "doc.txt");
    const base = "DISK CONTENT\nline2\n";
    await fs.writeFile(diskPath, base, "utf-8");

    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const yText = await room.ensureFileLoaded("doc.txt");
    expect(yText.toString()).toBe(base);

    const ws = makeMockWs();
    const clientDoc = new Y.Doc();
    wireClientToRoom(room, ws, clientDoc);
    await room.addClient(ws, { userId: 1, username: "quinn", role: "editor" });
    // Client adopts the room's already-loaded content (server -> client),
    // then makes exactly one edit and broadcasts it via the real sync path.
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(room.doc));
    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => {
        const t = clientDoc.getText("doc.txt");
        t.insert(t.length, "line3\n");
      }),
    );

    const expected = base + "line3\n";
    expect(room.doc.getText("doc.txt").toString()).toBe(expected);

    room.markFileDirty("doc.txt");
    await room.flushToDisk();

    const bytes = await fs.readFile(diskPath);
    expect(bytes.toString("utf-8")).toBe(expected);

    clientDoc.destroy();
    room.dispose();
  });

  it("36. A client joining a file the server already loaded from disk does not double its content (server-side proof of the seed-race class)", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("rick", "h", "user"); // id 1

    const project = await createProject(cfg, db, 1, {
      name: "NoDoubleSeedProj",
    });
    const diskPath = join(projectDir(cfg, project.id), "main.py");
    await fs.writeFile(diskPath, "SAME", "utf-8");

    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    await room.ensureFileLoaded("main.py"); // server loads "SAME" from disk

    // A fresh client (distinct clientID) joins and runs the real sync
    // handshake. Post-fix it adopts the server's authoritative content
    // rather than independently seeding its own copy from a local buffer.
    const ws = makeMockWs();
    const clientDoc = new Y.Doc();
    wireClientToRoom(room, ws, clientDoc);
    await room.addClient(ws, { userId: 1, username: "rick", role: "editor" });

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, clientDoc);
    room.handleMessage(ws, encoding.toUint8Array(enc));

    expect(clientDoc.getText("main.py").toString()).toBe("SAME");

    room.markFileDirty("main.py");
    await room.flushToDisk();

    expect(await fs.readFile(diskPath, "utf-8")).toBe("SAME");

    clientDoc.destroy();
    room.dispose();
  });

  // --- External-mutation conflict safety (data-loss regression) -----------
  //
  // handleExternalFileMutation() historically did an unconditional
  //   yText.delete(0, yText.length); yText.insert(0, newContent)
  // whenever the live content differed from the external content. If a
  // collaborator had an in-flight CRDT edit that was not yet flushed to
  // disk (still only in the Y.Doc), a stale external mutation — a REST
  // save / snapshot restore / template / Replace-All computed against the
  // pre-edit file — silently obliterated it.
  //
  // Invariant established here: an external mutation whose incoming
  // content is NOT what the live Y.Text currently holds is only applied
  // when the file has no unpersisted collaborator edits (not in
  // dirtyFiles). Otherwise it is a CONFLICT: the Y.Text is left untouched,
  // the file stays dirty so the room re-persists the authoritative live
  // content, and the call reports `{ applied: false, conflict: true }`.

  async function seedLoadedFile(
    room: CollaborationRoom,
    filePath: string,
    content: string,
  ): Promise<string> {
    const diskPath = join(projectDir((room as any).cfg, (room as any).projectId), filePath);
    await fs.writeFile(diskPath, content, "utf-8");
    await room.ensureFileLoaded(filePath);
    return diskPath;
  }

  it("37. External mutation does not discard a concurrent unpersisted collaborator edit", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("nate", "h", "user"); // id 1
    const project = await createProject(cfg, db, 1, { name: "ExtConflictA" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const filePath = "app.py";
    const diskPath = await seedLoadedFile(room, filePath, "print(1)\n");

    // A collaborator appends a line via the real sync path -> lands in
    // dirtyFiles, NOT yet flushed to disk.
    const ws = makeMockWs();
    const clientDoc = new Y.Doc();
    wireClientToRoom(room, ws, clientDoc);
    await room.addClient(ws, { userId: 1, username: "nate", role: "editor" });
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(room.doc));
    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => {
        const t = clientDoc.getText(filePath);
        t.insert(t.length, "print(2)\n");
      }),
    );
    expect(room.doc.getText(filePath).toString()).toBe("print(1)\nprint(2)\n");
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    // A stale external mutation carrying only the pre-edit content arrives
    // (e.g. a snapshot restore, or a REST save computed before the append).
    const result = await room.handleExternalFileMutation(filePath, "print(1)\n");

    // The collaborator's unpersisted line must survive, untouched.
    expect(room.doc.getText(filePath).toString()).toBe("print(1)\nprint(2)\n");
    expect(result).toEqual({ applied: false, conflict: true });
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    // Disk reconverges to the authoritative live content, not the stale bytes.
    await room.flushToDisk();
    expect(await fs.readFile(diskPath, "utf-8")).toBe("print(1)\nprint(2)\n");

    clientDoc.destroy();
    room.dispose();
  });

  it("38. External mutation with no concurrent collaborator edit applies cleanly", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("olive", "h", "user"); // id 1
    const project = await createProject(cfg, db, 1, { name: "ExtConflictB" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const filePath = "config.json";
    const diskPath = await seedLoadedFile(room, filePath, '{"v":1}\n');

    // A real caller writes the new bytes to disk first, then notifies the room.
    await fs.writeFile(diskPath, '{"v":2}\n', "utf-8");
    const result = await room.handleExternalFileMutation(filePath, '{"v":2}\n');

    expect(result).toEqual({ applied: true, conflict: false });
    expect(room.doc.getText(filePath).toString()).toBe('{"v":2}\n');
    // External-origin content already matches disk, so it is never queued
    // for a redundant write-back.
    expect((room as any).dirtyFiles.has(filePath)).toBe(false);

    await room.flushToDisk();
    expect(await fs.readFile(diskPath, "utf-8")).toBe('{"v":2}\n');

    room.dispose();
  });

  it("39. A collaborator edit AFTER an external mutation still syncs and persists normally", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("pat", "h", "user"); // id 1
    const project = await createProject(cfg, db, 1, { name: "ExtConflictC" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const filePath = "notes.md";
    const diskPath = await seedLoadedFile(room, filePath, "# Notes\n");

    await fs.writeFile(diskPath, "# Notes\n\n- imported line\n", "utf-8");
    const ext = await room.handleExternalFileMutation(
      filePath,
      "# Notes\n\n- imported line\n",
    );
    expect(ext).toEqual({ applied: true, conflict: false });

    // Normal collaboration resumes: a real sync-path edit lands, tracks
    // dirty, and flushes.
    const ws = makeMockWs();
    const clientDoc = new Y.Doc();
    wireClientToRoom(room, ws, clientDoc);
    await room.addClient(ws, { userId: 1, username: "pat", role: "editor" });
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(room.doc));
    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => {
        const t = clientDoc.getText(filePath);
        t.insert(t.length, "- my own line\n");
      }),
    );

    expect(room.doc.getText(filePath).toString()).toBe(
      "# Notes\n\n- imported line\n- my own line\n",
    );
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    await room.flushToDisk();
    expect(await fs.readFile(diskPath, "utf-8")).toBe(
      "# Notes\n\n- imported line\n- my own line\n",
    );

    clientDoc.destroy();
    room.dispose();
  });

  it("40. Sequential external mutations converge to the latest; a later stale one over a live edit is a conflict", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("quinn2", "h", "user"); // id 1
    const project = await createProject(cfg, db, 1, { name: "ExtConflictD" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const filePath = "seq.txt";
    await seedLoadedFile(room, filePath, "v0\n");

    const r1 = await room.handleExternalFileMutation(filePath, "v1\n");
    expect(r1).toEqual({ applied: true, conflict: false });
    const r2 = await room.handleExternalFileMutation(filePath, "v2\n");
    expect(r2).toEqual({ applied: true, conflict: false });
    expect(room.doc.getText(filePath).toString()).toBe("v2\n");
    // External-origin applies are never queued for write-back, so a later
    // flush can't resurrect a superseded version.
    expect((room as any).dirtyFiles.has(filePath)).toBe(false);

    // A collaborator now edits (unpersisted), then a stale external mutation
    // replays "v2" — it must not clobber the live edit.
    const ws = makeMockWs();
    const clientDoc = new Y.Doc();
    wireClientToRoom(room, ws, clientDoc);
    await room.addClient(ws, { userId: 1, username: "quinn2", role: "editor" });
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(room.doc));
    room.handleMessage(
      ws,
      buildSyncUpdateFrame(clientDoc, () => {
        const t = clientDoc.getText(filePath);
        t.insert(t.length, "v3-live\n");
      }),
    );
    expect(room.doc.getText(filePath).toString()).toBe("v2\nv3-live\n");

    const stale = await room.handleExternalFileMutation(filePath, "v2\n");
    expect(stale).toEqual({ applied: false, conflict: true });
    expect(room.doc.getText(filePath).toString()).toBe("v2\nv3-live\n");

    clientDoc.destroy();
    room.dispose();
  });

  it("41. A conflicting external mutation does not suppress the M56 external_mutation_notice", async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("rae", "h", "user"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("sam", "h", "user"); // id 2
    const project = await createProject(cfg, db, 1, { name: "ExtConflictE" });
    const room = new CollaborationRoom(project.id, cfg, db, vi.fn());
    const filePath = "shared.py";
    await seedLoadedFile(room, filePath, "shared = 0\n");

    const samWs = makeMockWs();
    const samFrames: Uint8Array[] = [];
    samWs.send = (m: Uint8Array) => samFrames.push(m);
    await room.addClient(samWs, { userId: 2, username: "sam", role: "editor" });
    room.handleMessage(samWs, buildFileOpenFrame(filePath));

    // Sam has an unpersisted edit in that file.
    const samDoc = new Y.Doc();
    Y.applyUpdate(samDoc, Y.encodeStateAsUpdate(room.doc));
    room.handleMessage(
      samWs,
      buildSyncUpdateFrame(samDoc, () => {
        const t = samDoc.getText(filePath);
        t.insert(t.length, "shared = sam_edit\n");
      }),
    );
    samFrames.length = 0;

    // Alice (userId 1) triggers a stale external replace -> conflict.
    const res = await room.handleExternalFileMutation(filePath, "shared = 0\n");
    expect(res).toEqual({ applied: false, conflict: true });

    // The independent M56 notice pipeline still fans out to Sam.
    room.sendExternalMutationNotice({
      paths: [filePath],
      mutationType: "replace",
      actor: { userId: 1, username: "rae" },
    });
    const notices = decodeCustomFrames(samFrames).filter(
      (n) => n.type === "external_mutation_notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: "external_mutation_notice",
      path: filePath,
      mutationType: "replace",
      actor: { userId: 1, username: "rae" },
    });

    samDoc.destroy();
    room.dispose();
  });
});
