import { promises as fs, constants } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { requireOwnedProject, workspacePath, projectDir, touchProject } from '../projects/service.js';
import { safeResolve, assertInsideWorkspace, invalidateTreeCache } from './service.js';
import { collaborationManager } from '../collab/manager.js';
import { recordAuditLog } from '../audit.js';

export interface UploadFileItem {
  path: string; // relative path within target directory e.g. "app.py" or "nested/sub.ts"
  buffer: Buffer;
}

export interface UploadPayload {
  targetDir?: string;
  overwrite?: boolean;
  files: UploadFileItem[];
}

/**
 * Robust zero-dependency multipart/form-data parser.
 */
export function parseMultipartFormData(
  bodyBuffer: Buffer,
  contentTypeHeader: string,
): { fields: Record<string, string>; files: UploadFileItem[] } {
  const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new ApiError(400, 'Invalid multipart/form-data: missing boundary', 'invalid_multipart');
  }
  const boundaryStr = boundaryMatch[1] || boundaryMatch[2];
  const boundary = Buffer.from(`--${boundaryStr}`);
  const endBoundary = Buffer.from(`--${boundaryStr}--`);

  const fields: Record<string, string> = {};
  const files: UploadFileItem[] = [];

  let startIdx = 0;
  while (startIdx < bodyBuffer.length) {
    const nextIdx = bodyBuffer.indexOf(boundary, startIdx);
    if (nextIdx === -1) break;

    // Check if this is the end boundary
    if (bodyBuffer.indexOf(endBoundary, nextIdx) === nextIdx) {
      break;
    }

    const partStart = nextIdx + boundary.length;
    // Skip CRLF or LF after boundary
    let dataStart = partStart;
    if (bodyBuffer[dataStart] === 0x0d && bodyBuffer[dataStart + 1] === 0x0a) {
      dataStart += 2;
    } else if (bodyBuffer[dataStart] === 0x0a) {
      dataStart += 1;
    }

    const nextBoundaryIdx = bodyBuffer.indexOf(boundary, dataStart);
    if (nextBoundaryIdx === -1) break;

    // The part content ends before the CRLF preceding next boundary
    let partEnd = nextBoundaryIdx;
    if (partEnd >= 2 && bodyBuffer[partEnd - 2] === 0x0d && bodyBuffer[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    } else if (partEnd >= 1 && bodyBuffer[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const partBuffer = bodyBuffer.subarray(dataStart, partEnd);
    startIdx = nextBoundaryIdx;

    // Find headers / body delimiter (\r\n\r\n or \n\n)
    let headerEndIdx = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    let headerLen = 4;
    if (headerEndIdx === -1) {
      headerEndIdx = partBuffer.indexOf(Buffer.from('\n\n'));
      headerLen = 2;
    }
    if (headerEndIdx === -1) continue;

    const headersStr = partBuffer.subarray(0, headerEndIdx).toString('utf8');
    const content = partBuffer.subarray(headerEndIdx + headerLen);

    const dispositionMatch = headersStr.match(/Content-Disposition:\s*form-data;\s*([^;\r\n]+(?:;[^\r\n]+)*)/i);
    if (!dispositionMatch) continue;

    const dispositionParams = dispositionMatch[1];
    const nameMatch = dispositionParams.match(/name="([^"]+)"/i);
    const fieldName = nameMatch ? nameMatch[1] : '';

    const filenameMatch = dispositionParams.match(/filename="([^"]+)"/i) || dispositionParams.match(/filename\*=utf-8''([^;\r\n]+)/i);

    if (filenameMatch) {
      let rawFilename = filenameMatch[1];
      try {
        rawFilename = decodeURIComponent(rawFilename);
      } catch {}
      // Normalize slashes
      const cleanPath = rawFilename.replace(/\\/g, '/').replace(/^\/+/, '');
      files.push({
        path: cleanPath,
        buffer: Buffer.from(content),
      });
    } else if (fieldName) {
      fields[fieldName] = content.toString('utf8').trim();
    }
  }

  return { fields, files };
}

/**
 * Recursively copies all entries from src directory to dest directory.
 */
async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.mkdir(dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Handles transactional file and folder upload to a project workspace.
 */
export async function uploadProjectFiles(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  payload: UploadPayload,
): Promise<{
  ok: boolean;
  fileCount: number;
  totalBytes: number;
  uploadedFiles: string[];
}> {
  const project = requireOwnedProject(db, userId, projectId);
  const cwd = await workspacePath(cfg, project.id);

  const targetDir = (payload.targetDir ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const overwrite = Boolean(payload.overwrite);
  const files = payload.files;

  if (!files || !Array.isArray(files) || files.length === 0) {
    throw new ApiError(400, 'No files provided for upload', 'empty_upload');
  }

  // 1. Check file count limit
  if (files.length > cfg.maxUploadFileCount) {
    throw new ApiError(
      413,
      `Exceeded maximum uploaded file count of ${cfg.maxUploadFileCount} (got ${files.length})`,
      'upload_limit_exceeded',
    );
  }

  // 2. Check aggregate byte limit
  let aggregateBytes = 0;
  for (const f of files) {
    const size = f.buffer?.length ?? 0;
    aggregateBytes += size;
  }

  if (aggregateBytes > cfg.maxAggregateUploadBytes) {
    throw new ApiError(
      413,
      `Aggregate upload size (${aggregateBytes} bytes) exceeds limit of ${cfg.maxAggregateUploadBytes} bytes`,
      'upload_limit_exceeded',
    );
  }

  // 3. Validate target directory within workspace
  let targetAbs = cwd;
  if (targetDir.length > 0) {
    targetAbs = safeResolve(cwd, targetDir);
    await assertInsideWorkspace(cwd, targetAbs);
  }

  // 4. Validate each file and check for path traversal / limits / conflicts
  const conflicts: string[] = [];
  const normalizedItems: Array<{ relDest: string; absDest: string; buffer: Buffer }> = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string') {
      throw new ApiError(400, 'Each file must have a valid string path', 'invalid_path');
    }

    const rawPath = file.path.trim().replace(/\\/g, '/');
    if (!rawPath || rawPath === '.' || rawPath === '..') {
      throw new ApiError(400, 'Invalid file path in upload payload', 'invalid_path');
    }

    // Single file size limit
    const fileSize = file.buffer?.length ?? 0;
    if (fileSize > cfg.maxSingleUploadFileBytes) {
      throw new ApiError(
        413,
        `File "${rawPath}" (${fileSize} bytes) exceeds single-file limit of ${cfg.maxSingleUploadFileBytes} bytes`,
        'file_too_large',
      );
    }

    // Destination path relative to workspace root
    const relDest = targetDir ? `${targetDir}/${rawPath}` : rawPath;
    const absDest = safeResolve(cwd, relDest);
    await assertInsideWorkspace(cwd, absDest);

    // Conflict detection if overwrite is false
    if (!overwrite) {
      try {
        const st = await fs.stat(absDest);
        if (st.isFile()) {
          conflicts.push(relDest);
        }
      } catch {
        // File does not exist, safe to write
      }
    }

    normalizedItems.push({
      relDest,
      absDest,
      buffer: file.buffer,
    });
  }

  if (conflicts.length > 0) {
    throw new ApiError(
      409,
      `File(s) already exist: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''}. Confirmation required (pass overwrite=true to replace).`,
      'conflict',
    );
  }

  // 5. Transactional Staging: unpack into an isolated staging directory first
  const stagingDir = join(cfg.dataDir, `tmp_upload_${randomUUID()}`);
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    for (const item of normalizedItems) {
      const stagingFilePath = safeResolve(stagingDir, item.relDest);
      await fs.mkdir(dirname(stagingFilePath), { recursive: true });
      await fs.writeFile(stagingFilePath, item.buffer);
    }

    // 6. Move/Copy from staging into workspace
    await copyDirectoryRecursive(stagingDir, cwd);

  } finally {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
  }

  // 7. Live Workspace Sync
  invalidateTreeCache(cwd);
  touchProject(db, project.id);

  // Sync open collab buffers if text
  for (const item of normalizedItems) {
    try {
      const isLikelyText = !item.buffer.includes(0);
      if (isLikelyText) {
        const textContent = item.buffer.toString('utf8');
        await collaborationManager.notifyExternalFileMutation(project.id, item.relDest, textContent);
      }
    } catch {}
  }

  // 8. Record audit log
  try {
    recordAuditLog(db, {
      userId,
      projectId: project.id,
      eventType: 'PROJECT_FILES_UPLOADED',
      details: {
        projectName: project.name,
        targetDir: targetDir || '/',
        fileCount: normalizedItems.length,
        totalBytes: aggregateBytes,
        overwrite,
      },
    });
  } catch {}

  return {
    ok: true,
    fileCount: normalizedItems.length,
    totalBytes: aggregateBytes,
    uploadedFiles: normalizedItems.map((i) => i.relDest),
  };
}
