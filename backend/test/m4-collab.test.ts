import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { openDb } from '../src/db.js';
import { resolveConfig } from '../src/config.js';
import {
  CollaborationRoom,
  CollaborationManager,
  collaborationManager,
} from '../src/collab/manager.js';
import {
  createProject,
  addProjectCollaborator,
  removeProjectCollaborator,
  listProjectCollaborators,
  requireProjectAccess,
  projectDir,
} from '../src/projects/service.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

describe('M4 Real-Time Multiplayer Collaboration & CRDT Engine', () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;

  beforeEach(async () => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), 'cloudide-m4-test-'));
    db = openDb(':memory:');
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

  it('1. CRDT Convergence: concurrent conflicting edits converge to identical text', () => {
    // Client A and Client B start synchronized
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const textA = docA.getText('main.py');
    const textB = docB.getText('main.py');

    textA.insert(0, 'def compute(x):\n    return x * 2\n');
    
    // Sync initial state A -> B
    const initialUpdate = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, initialUpdate);

    expect(textA.toString()).toBe(textB.toString());

    // User A and User B concurrently edit
    // User A inserts docstring at line 1
    textA.insert(16, '    """Multiply input by 2"""\n');

    // User B simultaneously modifies return expression
    textB.delete(31, 1); // remove '2'
    textB.insert(31, '10 + x'); // change to x * 10 + x

    // Exchange updates
    const updateA = Y.encodeStateAsUpdate(docA);
    const updateB = Y.encodeStateAsUpdate(docB);

    Y.applyUpdate(docB, updateA);
    Y.applyUpdate(docA, updateB);

    // CRITICAL INVARIANT: Final text MUST converge to 100% identical content
    expect(textA.toString()).toBe(textB.toString());
    expect(textA.toString()).toContain('Multiply input by 2');
    expect(textA.toString()).toContain('10 + x');
  });

  it('2. Lazy file loading & disk workspace persistence', async () => {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner_u', 'h', 'user');
    const project = await createProject(cfg, db, 1, { name: 'MultiplayerProj' });
    const filePath = 'script.py';
    const diskPath = join(projectDir(cfg, project.id), filePath);
    await fs.writeFile(diskPath, 'print("initial disk content")', 'utf-8');

    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded(filePath);
    expect(yText.toString()).toBe('print("initial disk content")');

    // Simulate collaborative edit in room
    yText.insert(yText.length, '\nprint("multiplayer added line")');
    room.markFileDirty(filePath);

    // Flush to disk
    await room.flushToDisk();

    const savedDiskContent = await fs.readFile(diskPath, 'utf-8');
    expect(savedDiskContent).toBe('print("initial disk content")\nprint("multiplayer added line")');
  });

  it('3. External file mutation safety: REST file save updates active Y.Doc without divergence', async () => {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner_u', 'h', 'user');
    const project = await createProject(cfg, db, 1, { name: 'ExternalProj' });
    const filePath = 'app.js';

    const room = collaborationManager.getOrCreateRoom(project.id);
    const yText = await room.ensureFileLoaded(filePath);
    yText.insert(0, 'const port = 3000;');

    // Simulate an external snapshot restore or REST write
    const externalContent = 'const port = 8080;\nconsole.log("Restored snapshot");';
    await collaborationManager.notifyExternalFileMutation(project.id, filePath, externalContent);

    expect(yText.toString()).toBe(externalContent);
  });

  it('4. Multi-Tenant access authorization & RBAC permissions', async () => {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alice', 'h', 'user'); // id 1
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('bob', 'h', 'user');   // id 2
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('charlie', 'h', 'user'); // id 3
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin_u', 'h', 'admin'); // id 4

    const project = await createProject(cfg, db, 1, { name: 'SecuredProj' });

    // 1. Owner access
    const ownerAccess = requireProjectAccess(db, 1, project.id);
    expect(ownerAccess.role).toBe('owner');

    // 2. Uninvited user access
    expect(() => requireProjectAccess(db, 2, project.id)).toThrowError(/not found/);

    // 3. Invite Bob as Editor
    addProjectCollaborator(db, project.id, 2, 'editor');
    const editorAccess = requireProjectAccess(db, 2, project.id, 'editor');
    expect(editorAccess.role).toBe('editor');

    // 4. Invite Charlie as Viewer
    addProjectCollaborator(db, project.id, 3, 'viewer');
    const viewerAccess = requireProjectAccess(db, 3, project.id, 'viewer');
    expect(viewerAccess.role).toBe('viewer');

    // Viewer fails editor minimum requirement
    expect(() => requireProjectAccess(db, 3, project.id, 'editor')).toThrowError(/read-only viewer/);

    // 5. Admin has owner-level access
    const adminAccess = requireProjectAccess(db, 4, project.id);
    expect(adminAccess.role).toBe('owner');

    // 6. List collaborators
    const members = listProjectCollaborators(db, project.id);
    expect(members.length).toBe(2);
    expect(members.some((m) => m.username === 'bob' && m.role === 'editor')).toBe(true);
    expect(members.some((m) => m.username === 'charlie' && m.role === 'viewer')).toBe(true);
  });

  it('5. Revocation & collaborator removal immediately cuts access', async () => {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alice', 'h', 'user'); // id 1
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('bob', 'h', 'user');   // id 2

    const project = await createProject(cfg, db, 1, { name: 'RevokeProj' });
    addProjectCollaborator(db, project.id, 2, 'editor');
    expect(requireProjectAccess(db, 2, project.id).role).toBe('editor');

    // Revoke collaborator
    removeProjectCollaborator(db, project.id, 2);
    expect(() => requireProjectAccess(db, 2, project.id)).toThrowError(/not found/);
    expect(listProjectCollaborators(db, project.id).length).toBe(0);
  });

  it('6. Offline delta reconciliation: client reconnects and converges with room edits', () => {
    const serverDoc = new Y.Doc();
    const clientDoc = new Y.Doc();

    const serverText = serverDoc.getText('code.ts');
    const clientText = clientDoc.getText('code.ts');

    serverText.insert(0, 'let count = 0;');
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc));

    // Client goes offline and edits locally
    clientText.insert(clientText.length, '\ncount += 5;');

    // Server concurrently receives another edit
    serverText.insert(serverText.length, '\nconsole.log(count);');

    // Client reconnects: performs Sync Step 1 & Step 2 exchange
    const clientStateVector = Y.encodeStateVector(clientDoc);
    const serverDiff = Y.encodeStateAsUpdate(serverDoc, clientStateVector);

    const serverStateVector = Y.encodeStateVector(serverDoc);
    const clientDiff = Y.encodeStateAsUpdate(clientDoc, serverStateVector);

    Y.applyUpdate(clientDoc, serverDiff);
    Y.applyUpdate(serverDoc, clientDiff);

    // Both client and server must have identical text
    expect(clientText.toString()).toBe(serverText.toString());
    expect(clientText.toString()).toContain('count += 5;');
    expect(clientText.toString()).toContain('console.log(count);');
  });

  it('7. Multi-File collaboration in same room', async () => {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alice', 'h', 'user');
    const project = await createProject(cfg, db, 1, { name: 'MultiFileProj' });

    const room = collaborationManager.getOrCreateRoom(project.id);
    const pyText = await room.ensureFileLoaded('main.py');
    const jsText = await room.ensureFileLoaded('index.js');
    const mdText = await room.ensureFileLoaded('README.md');

    pyText.insert(0, 'print("Python File")');
    jsText.insert(0, 'console.log("JavaScript File")');
    mdText.insert(0, '# Documentation');

    room.markFileDirty('main.py');
    room.markFileDirty('index.js');
    room.markFileDirty('README.md');

    await room.flushToDisk();

    const pyDisk = await fs.readFile(join(projectDir(cfg, project.id), 'main.py'), 'utf-8');
    const jsDisk = await fs.readFile(join(projectDir(cfg, project.id), 'index.js'), 'utf-8');
    const mdDisk = await fs.readFile(join(projectDir(cfg, project.id), 'README.md'), 'utf-8');

    expect(pyDisk).toBe('print("Python File")');
    expect(jsDisk).toBe('console.log("JavaScript File")');
    expect(mdDisk).toBe('# Documentation');
  });
});
