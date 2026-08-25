import { deflateRawSync, inflateRawSync } from "node:zlib";
import { promises as fs } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../config.js";

// Standard CRC-32 table initialization
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipFileEntry {
  path: string;
  rawPath?: string;
  content: Buffer;
  mode?: number;
}

/**
 * Creates a standard PKZIP 2.0 Deflate archive buffer from a list of files.
 */
export function createZipArchive(files: ZipFileEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];

  let currentOffset = 0;

  for (const file of files) {
    // Preserve rawPath if provided (for testing traversal attacks), otherwise normalize
    const entryPath = file.rawPath ?? file.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const nameBuf = Buffer.from(entryPath, "utf8");

    const rawContent = file.content;
    const uncompressedSize = rawContent.length;
    const fileCrc = crc32(rawContent);

    // Deflate compression
    const compressedData = deflateRawSync(rawContent);
    const compressedSize = compressedData.length;
    const compressionMethod = 8; // Deflate

    // Local file header (30 bytes + name + compressed data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0x21, 12); // Mod date (1980-01-01)
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra length

    const localEntry = Buffer.concat([localHeader, nameBuf, compressedData]);
    localChunks.push(localEntry);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central header signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12); // Mod time
    centralHeader.writeUInt16LE(0x21, 14); // Mod date
    centralHeader.writeUInt32LE(fileCrc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra length
    centralHeader.writeUInt16LE(0, 32); // Comment length
    centralHeader.writeUInt16LE(0, 34); // Disk start
    centralHeader.writeUInt16LE(0, 36); // Internal attr
    // External attributes: standard file permissions (e.g. 0644 -> 0x81a40000)
    const modeAttr = (((file.mode ?? 0o644) << 16) >>> 0);
    centralHeader.writeUInt32LE(modeAttr, 38);
    centralHeader.writeUInt32LE(currentOffset, 42); // Offset of local header

    centralChunks.push(Buffer.concat([centralHeader, nameBuf]));

    currentOffset += localEntry.length;
  }

  const centralDirBuffer = Buffer.concat(centralChunks);
  const centralDirOffset = currentOffset;
  const centralDirSize = centralDirBuffer.length;
  const entryCount = files.length;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Start disk
  eocd.writeUInt16LE(entryCount, 8); // Entries on disk
  eocd.writeUInt16LE(entryCount, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localChunks, centralDirBuffer, eocd]);
}

/**
 * Sanitizes and validates archive entry paths against path traversal attacks.
 */
export function sanitizeArchivePath(entryPath: string, rootDir: string): string {
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    throw new ApiError(400, "Invalid archive entry path", "invalid_archive_path");
  }

  if (entryPath.includes("\0")) {
    throw new ApiError(400, "Archive contains null byte in path", "path_traversal");
  }

  // Normalize slashes
  let clean = entryPath.replace(/\\/g, "/");

  // Reject absolute paths (Unix or Windows)
  if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean) || clean.startsWith("//")) {
    throw new ApiError(400, "Archive contains absolute path", "path_traversal");
  }

  // Check path segments for traversal
  const segments = clean.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      if (seg === "..") {
        throw new ApiError(400, "Archive contains directory traversal segment", "path_traversal");
      }
    }
  }

  const resolved = resolve(rootDir, clean);
  const rel = relative(rootDir, resolved);
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    throw new ApiError(400, "Archive path escapes target directory", "path_traversal");
  }

  return resolved;
}

export interface ExtractedFile {
  relPath: string;
  absPath: string;
  isDir: boolean;
}

/**
 * Safely extracts a ZIP archive into a destination directory while enforcing limits
 * and guarding against zip bombs, path traversals, symlink escapes, and corrupted entries.
 */
export async function extractZipArchive(
  zipBuffer: Buffer,
  destDir: string,
  cfg: AppConfig,
): Promise<ExtractedFile[]> {
  const maxUploadBytes = cfg.maxArchiveUploadBytes ?? 25 * 1024 * 1024;
  if (zipBuffer.length > maxUploadBytes) {
    throw new ApiError(
      413,
      `Archive upload size (${zipBuffer.length} bytes) exceeds limit of ${maxUploadBytes} bytes`,
      "archive_too_large",
    );
  }

  if (zipBuffer.length < 22) {
    throw new ApiError(400, "Invalid ZIP archive: file is too small", "invalid_archive");
  }

  // Locate End of Central Directory Record (EOCD)
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65535 - 22); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new ApiError(400, "Invalid ZIP archive: EOCD record not found", "invalid_archive");
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const maxEntries = cfg.maxArchiveEntries ?? 1000;
  if (totalEntries > maxEntries) {
    throw new ApiError(
      400,
      `Archive contains too many entries (${totalEntries}), limit is ${maxEntries}`,
      "too_many_files",
    );
  }

  if (centralDirOffset + centralDirSize > zipBuffer.length) {
    throw new ApiError(400, "Corrupted ZIP archive: invalid central directory bounds", "invalid_archive");
  }

  const maxUncompressed = cfg.maxArchiveUncompressedBytes ?? 50 * 1024 * 1024;
  const maxSingleFile = cfg.maxArchiveSingleFileBytes ?? 10 * 1024 * 1024;

  let totalUncompressedBytes = 0;
  let cdPtr = centralDirOffset;

  const entriesToExtract: Array<{
    relPath: string;
    isDir: boolean;
    localHeaderOffset: number;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    crc: number;
    externalAttr: number;
  }> = [];

  for (let i = 0; i < totalEntries; i++) {
    if (cdPtr + 46 > zipBuffer.length) {
      throw new ApiError(400, "Corrupted ZIP archive: truncated central directory header", "invalid_archive");
    }

    const signature = zipBuffer.readUInt32LE(cdPtr);
    if (signature !== 0x02014b50) {
      throw new ApiError(400, `Corrupted ZIP archive: invalid central header at entry ${i}`, "invalid_archive");
    }

    const compressionMethod = zipBuffer.readUInt16LE(cdPtr + 10);
    const crc = zipBuffer.readUInt32LE(cdPtr + 16);
    const compressedSize = zipBuffer.readUInt32LE(cdPtr + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cdPtr + 24);
    const nameLen = zipBuffer.readUInt16LE(cdPtr + 28);
    const extraLen = zipBuffer.readUInt16LE(cdPtr + 30);
    const commentLen = zipBuffer.readUInt16LE(cdPtr + 32);
    const externalAttr = zipBuffer.readUInt32LE(cdPtr + 38);
    const localHeaderOffset = zipBuffer.readUInt32LE(cdPtr + 42);

    const nameStart = cdPtr + 46;
    if (nameStart + nameLen > zipBuffer.length) {
      throw new ApiError(400, "Corrupted ZIP archive: truncated entry filename", "invalid_archive");
    }

    const rawName = zipBuffer.toString("utf8", nameStart, nameStart + nameLen);
    // Strict validation on raw entry name
    sanitizeArchivePath(rawName, destDir);

    const normalizedName = rawName.replace(/\\/g, "/");

    // Check if this is a directory entry
    const isDir = normalizedName.endsWith("/") || (externalAttr & 0x10) !== 0;

    // Check symlinks: mode 0120000 in high 16 bits -> (externalAttr >> 16) & 0170000 === 0120000
    const unixMode = externalAttr >>> 16;
    const isSymlink = (unixMode & 0o170000) === 0o120000;
    if (isSymlink) {
      throw new ApiError(400, "Archive contains symlink entries which are forbidden", "forbidden_archive_entry");
    }

    // Skip unwanted system/metadata directories
    if (
      normalizedName.startsWith(".git/") ||
      normalizedName.startsWith("node_modules/") ||
      normalizedName.startsWith(".venv/") ||
      normalizedName.startsWith(".cloudide-build-") ||
      normalizedName === ".git" ||
      normalizedName === "node_modules" ||
      normalizedName === ".venv"
    ) {
      cdPtr += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    if (!isDir) {
      if (uncompressedSize > maxSingleFile) {
        throw new ApiError(
          413,
          `File '${normalizedName}' uncompressed size (${uncompressedSize} bytes) exceeds limit of ${maxSingleFile} bytes`,
          "file_too_large",
        );
      }

      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > maxUncompressed) {
        throw new ApiError(
          413,
          `Archive uncompressed size (${totalUncompressedBytes} bytes) exceeds limit of ${maxUncompressed} bytes`,
          "archive_too_large",
        );
      }
    }

    entriesToExtract.push({
      relPath: normalizedName,
      isDir,
      localHeaderOffset,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      crc,
      externalAttr,
    });

    cdPtr += 46 + nameLen + extraLen + commentLen;
  }

  const extracted: ExtractedFile[] = [];

  for (const entry of entriesToExtract) {
    const absPath = sanitizeArchivePath(entry.relPath, destDir);

    if (entry.isDir) {
      await fs.mkdir(absPath, { recursive: true });
      extracted.push({ relPath: entry.relPath, absPath, isDir: true });
      continue;
    }

    // Verify local header
    const lOffset = entry.localHeaderOffset;
    if (lOffset + 30 > zipBuffer.length) {
      throw new ApiError(400, "Corrupted ZIP archive: truncated local header", "invalid_archive");
    }

    const localSig = zipBuffer.readUInt32LE(lOffset);
    if (localSig !== 0x04034b50) {
      throw new ApiError(400, "Corrupted ZIP archive: invalid local header signature", "invalid_archive");
    }

    const localNameLen = zipBuffer.readUInt16LE(lOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(lOffset + 28);
    const dataStart = lOffset + 30 + localNameLen + localExtraLen;

    if (dataStart + entry.compressedSize > zipBuffer.length) {
      throw new ApiError(400, "Corrupted ZIP archive: truncated compressed data", "invalid_archive");
    }

    const compressedSlice = zipBuffer.subarray(dataStart, dataStart + entry.compressedSize);

    let uncompressedData: Buffer;
    if (entry.compressionMethod === 0) {
      // Stored (no compression)
      uncompressedData = compressedSlice;
    } else if (entry.compressionMethod === 8) {
      // Deflate
      try {
        uncompressedData = inflateRawSync(compressedSlice);
      } catch (err: any) {
        throw new ApiError(400, `Corrupted ZIP data for ${entry.relPath}: ${err.message}`, "invalid_archive");
      }
    } else {
      throw new ApiError(
        400,
        `Unsupported compression method (${entry.compressionMethod}) for ${entry.relPath}`,
        "unsupported_compression",
      );
    }

    if (uncompressedData.length !== entry.uncompressedSize) {
      throw new ApiError(
        400,
        `Size mismatch for ${entry.relPath}: expected ${entry.uncompressedSize}, got ${uncompressedData.length}`,
        "invalid_archive",
      );
    }

    if (entry.crc !== 0 && crc32(uncompressedData) !== entry.crc) {
      throw new ApiError(400, `CRC32 checksum failure for ${entry.relPath}`, "corrupted_archive_data");
    }

    await fs.mkdir(dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, uncompressedData);
    extracted.push({ relPath: entry.relPath, absPath, isDir: false });
  }

  return extracted;
}
