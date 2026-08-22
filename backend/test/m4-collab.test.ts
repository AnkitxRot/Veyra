import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { collaborationManager } from "../src/collab/manager.js";
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

describe("M4 Real-Time Multiplayer Collaboration & CRDT Engine", () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;

  beforeEach(async () => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m4-test-"));
    db = openDb(":memory:");
    cfg = {
      ...resolveConfig(),
      workspacesDir: tempWorkspacesDir,
    };
    collaborationManager.init(cfg, db);
  });

  afterEach(async () => {
    try {
      rmSync(tempWorkspacesDir, { recursive: true, force: true });
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
});
