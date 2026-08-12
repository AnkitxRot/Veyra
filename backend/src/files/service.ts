import { promises as fs, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ApiError } from '../errors.js';

const MAX_FILE_SIZE = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.venv', '.git']);
const BUILD_PREFIX = '.cloudide-build-';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[];
}

function escapeError(): ApiError {
  return new ApiError(400, 'path escapes the workspace', 'invalid_path');
}

export function safeResolve(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new ApiError(400, 'path is required', 'invalid_path');
  }
  if (relPath.includes('\0')) throw escapeError();
  if (relPath.startsWith('/')) throw escapeError();
  // Reject Windows-style absolute paths (C:\, \\server\share, etc.)
  if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) throw escapeError();
  const resolved = resolve(root, relPath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) throw escapeError();
  return resolved;
}

export async function assertInsideWorkspace(root: string, abs: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let cur = abs;
  const tail: string[] = [];
  
  while (true) {
    try {
      await fs.access(cur, constants.F_OK);
      break; // exists
    } catch {
      tail.unshift(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  
  try {
    await fs.access(cur, constants.F_OK);
  } catch {
    throw escapeError();
  }
  
  let realAbs = await fs.realpath(cur);
  for (const part of tail) realAbs = join(realAbs, part);
  const rel = relative(realRoot, realAbs);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) throw escapeError();
}

export async function listFiles(root: string, rel = '', out: string[] = []): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(BUILD_PREFIX)) continue;
        await listFiles(root, relPath, out);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(BUILD_PREFIX)) continue;
        out.push(relPath);
      }
    }
  } catch (err) {
    // ignore dir read errors
  }
  return out;
}

export async function tree(root: string): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
  );
  
  for (const e of entries) {
    if (e.name.startsWith(BUILD_PREFIX)) continue;
    const relPath = e.name;
    const abs = join(root, relPath);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      nodes.push({ name: e.name, path: relPath, type: 'dir', children: await tree(abs) });
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(abs);
        nodes.push({ name: e.name, path: relPath, type: 'file', size: st.size });
      } catch (err) {
        // file might have disappeared
      }
    }
  }
  return nodes;
}

export async function readProjectFile(root: string, relPath: string): Promise<{ content: string; size: number }> {
  const abs = safeResolve(root, relPath);
  await assertInsideWorkspace(root, abs);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (err) {
    throw new ApiError(404, 'file not found', 'not_found');
  }
  if (!st.isFile()) throw new ApiError(400, 'not a file', 'not_a_file');
  if (st.size > MAX_FILE_SIZE) {
    throw new ApiError(413, 'file is too large to open', 'file_too_large');
  }
  const content = await fs.readFile(abs, 'utf8');
  return { content, size: st.size };
}

export async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  if (typeof content !== 'string') throw new ApiError(400, 'content must be a string', 'invalid_content');
  const abs = safeResolve(root, relPath);
  await assertInsideWorkspace(root, abs);
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
    throw new ApiError(413, 'file is too large to save', 'file_too_large');
  }
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

export async function moveProjectPath(root: string, from: string, to: string): Promise<{ path: string }> {
  const srcAbs = safeResolve(root, from);
  const dstAbs = safeResolve(root, to);
  await assertInsideWorkspace(root, srcAbs);
  await assertInsideWorkspace(root, dstAbs);
  try {
    await fs.access(srcAbs, constants.F_OK);
  } catch {
    throw new ApiError(404, 'path not found', 'not_found');
  }
  try {
    await fs.access(dstAbs, constants.F_OK);
    throw new ApiError(409, 'destination already exists', 'already_exists');
  } catch (err: any) {
    if (err.status === 409) throw err;
  }
  await fs.mkdir(dirname(dstAbs), { recursive: true });
  await fs.rename(srcAbs, dstAbs);
  return { path: to };
}

export async function deleteProjectPath(root: string, relPath: string): Promise<void> {
  if (relPath === '' || relPath === '.') throw new ApiError(400, 'cannot delete the workspace root', 'invalid_path');
  const abs = safeResolve(root, relPath);
  await assertInsideWorkspace(root, abs);
  if (abs === resolve(root)) throw new ApiError(400, 'cannot delete the workspace root', 'invalid_path');
  try {
    await fs.access(abs, constants.F_OK);
  } catch {
    throw new ApiError(404, 'path not found', 'not_found');
  }
  await fs.rm(abs, { recursive: true, force: true });
}

export { SKIP_DIRS };
