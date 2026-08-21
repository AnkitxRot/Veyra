import { promises as fs, constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { IS_WINDOWS } from '../config.js';
import { ApiError } from '../errors.js';

export interface ProjectRow {
  id: string;
  owner_id: number;
  name: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export function projectDir(cfg: AppConfig, id: string): string {
  return join(cfg.workspacesDir, id);
}

export async function workspacePath(cfg: AppConfig, id: string): Promise<string> {
  const dir = projectDir(cfg, id);
  try {
    await fs.access(dir, constants.F_OK);
  } catch {
    throw new ApiError(404, 'workspace not found', 'not_found');
  }
  return dir;
}

export function getProject(db: Db, id: string): ProjectRow | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ?? null;
}

export function requireOwnedProject(db: Db, ownerId: number, id: string): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(id, ownerId) as
    | ProjectRow
    | undefined;
  if (!row) throw new ApiError(404, 'project not found', 'not_found');
  return row;
}

export interface CollaboratorInfo {
  userId: number;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  createdAt: string;
}

export function requireProjectAccess(
  db: Db,
  userId: number,
  projectId: string,
  minRole?: 'viewer' | 'editor' | 'owner'
): { project: ProjectRow; role: 'owner' | 'editor' | 'viewer' } {
  const project = getProject(db, projectId);
  if (!project) {
    throw new ApiError(404, 'project not found', 'not_found');
  }

  // 1. Owner has full access
  if (project.owner_id === userId) {
    return { project, role: 'owner' };
  }

  // 2. Check collaborator membership
  const collab = db
    .prepare('SELECT role, created_at FROM project_collaborators WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as { role: 'editor' | 'viewer'; created_at: string } | undefined;

  if (collab) {
    if (minRole === 'owner') {
      throw new ApiError(403, 'project owner permission required', 'forbidden');
    }
    if (minRole === 'editor' && collab.role === 'viewer') {
      throw new ApiError(403, 'read-only viewer permission: editor access required', 'forbidden');
    }
    return { project, role: collab.role };
  }

  // 3. Platform Admin access
  const userRow = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined;
  if (userRow?.role === 'admin') {
    return { project, role: 'owner' };
  }

  throw new ApiError(404, 'project not found', 'not_found');
}

export function listProjectCollaborators(db: Db, projectId: string): CollaboratorInfo[] {
  const rows = db
    .prepare(
      `SELECT u.id as userId, u.username, pc.role, pc.created_at as createdAt
       FROM project_collaborators pc
       JOIN users u ON u.id = pc.user_id
       WHERE pc.project_id = ?
       ORDER BY pc.created_at ASC`
    )
    .all(projectId) as unknown as CollaboratorInfo[];
  return rows;
}

export function addProjectCollaborator(
  db: Db,
  projectId: string,
  targetUserId: number,
  role: 'editor' | 'viewer' = 'editor'
): void {
  const project = getProject(db, projectId);
  if (!project) throw new ApiError(404, 'project not found', 'not_found');
  if (project.owner_id === targetUserId) {
    throw new ApiError(400, 'owner is already project administrator', 'invalid_request');
  }

  db.prepare(
    `INSERT INTO project_collaborators (project_id, user_id, role)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(projectId, targetUserId, role);
}

export function removeProjectCollaborator(db: Db, projectId: string, targetUserId: number): void {
  db.prepare('DELETE FROM project_collaborators WHERE project_id = ? AND user_id = ?').run(
    projectId,
    targetUserId
  );
}

export function listProjects(db: Db, ownerId: number): ProjectRow[] {
  // Returns projects owned by user + projects shared with user
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_collaborators pc ON pc.project_id = p.id
       WHERE p.owner_id = ? OR pc.user_id = ?
       ORDER BY p.updated_at DESC`
    )
    .all(ownerId, ownerId) as unknown as ProjectRow[];
}

export async function createProject(
  cfg: AppConfig,
  db: Db,
  ownerId: number,
  opts: { name: string; language?: string },
): Promise<ProjectRow> {
  const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 64) : 'untitled';
  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM projects WHERE owner_id = ?')
    .get(ownerId) as { count: number };
  if (count >= cfg.projectQuota) {
    throw new ApiError(403, `project quota reached (max ${cfg.projectQuota})`, 'quota_exceeded');
  }
  const id = randomUUID();
  const dir = projectDir(cfg, id);
  await fs.mkdir(dir, { recursive: true });

  if (!IS_WINDOWS) {
    try {
      await fs.chown(dir, cfg.runUser.uid, cfg.runUser.gid);
      await fs.chmod(dir, 0o770);
    } catch {
      // best-effort: workspace still usable when running as non-root owner
    }
  }

  db.prepare('INSERT INTO projects (id, owner_id, name, language) VALUES (?, ?, ?, ?)').run(
    id,
    ownerId,
    name,
    typeof opts.language === 'string' ? opts.language : 'auto',
  );
  const project = getProject(db, id)!;
  return project;
}

export async function deleteProject(cfg: AppConfig, db: Db, ownerId: number, id: string): Promise<void> {
  const project = requireOwnedProject(db, ownerId, id);
  // Clean up Docker resources before removing the workspace directory
  try {
    const { sandboxManager } = await import('../execution/sandbox.js');
    await sandboxManager.stopProjectSandbox(project.id);
  } catch {
    // Best-effort: container may already be gone
  }
  await fs.rm(projectDir(cfg, project.id), { recursive: true, force: true });
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function touchProject(db: Db, id: string): void {
  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);
}
