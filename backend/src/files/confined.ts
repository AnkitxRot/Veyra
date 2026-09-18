import { promises as fs, constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { ApiError } from "../errors.js";

/**
 * M87 — workspace file I/O that stays inside the workspace even when the
 * sandbox races the host.
 *
 * Project code can create, replace, and swap symlinks and directories in its
 * own bind-mounted workspace at any moment. A realpath check followed by a
 * path-based `readFile` / `writeFile` (M86) is therefore a check-then-use
 * race: a directory swapped for a symlink between the two makes the backend
 * read or write a host file with its own privileges.
 *
 * These helpers verify the *opened file* instead of the path:
 *  1. open without truncating and without following a final-component
 *     symlink on create (`O_EXCL`); FIFOs cannot block (`O_NONBLOCK`);
 *  2. prove the open handle is a regular file inside the workspace:
 *     Linux — `/proc/self/fd/<n>` is the kernel's name for the handle;
 *     elsewhere — the handle's (dev, ino) must equal that of a path whose
 *     realpath is inside the workspace;
 *  3. only then read, or truncate and write, through the same handle.
 *
 * A handle that fails the check is closed untouched, so an escaped
 * write never modifies a host file. What remains possible under a race is
 * creating a new, empty file (never an existing one — `O_EXCL`) in a
 * directory outside the workspace. It is deliberately left in place:
 * unlinking by path would itself be a race an attacker controlling that
 * directory (e.g. a sibling workspace) could redirect.
 */

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

function escapeError(): ApiError {
  return new ApiError(400, "path escapes the workspace", "invalid_path");
}

function isInside(realRoot: string, real: string): boolean {
  const rel = relative(realRoot, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** First segment of a workspace-relative real path names `.git`. */
function isGitInternal(realRoot: string, real: string): boolean {
  const first = relative(realRoot, real).replace(/\\/g, "/").split("/")[0] ?? "";
  const segment = first
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "")
    .toLowerCase();
  return segment === ".git" || /^git~\d+$/.test(segment);
}

async function kernelPath(fh: FileHandle): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    return await fs.readlink(`/proc/self/fd/${fh.fd}`);
  } catch {
    return null;
  }
}

let forcePortableCheck = false;
/** Test-only: exercise the non-/proc identity check on Linux too. */
export function setConfinedPortableCheckForTests(on: boolean): void {
  forcePortableCheck = on;
}

/**
 * Test-only hook for controlling confined writes. When set, the provided
 * function is called instead of the real truncate-and-write sequence. Return
 * a resolved promise for normal writes, a rejected promise to simulate a
 * write failure, or a hanging promise to stall the write.
 */
let testWriteHook:
  | ((abs: string, data: string) => Promise<void>)
  | null = null;
export function setConfinedWriteForTests(
  hook: ((abs: string, data: string) => Promise<void>) | null,
): void {
  testWriteHook = hook;
}

/**
 * Throw unless `fh` (opened from `abs`) is a file inside `root` and not in
 * `.git`.
 */
async function assertHandleConfined(
  root: string,
  abs: string,
  fh: FileHandle,
  st: BigIntStats,
): Promise<void> {
  const realRoot = await fs.realpath(root);
  const kp = forcePortableCheck ? null : await kernelPath(fh);
  if (kp !== null) {
    const real = kp.endsWith(" (deleted)") ? kp.slice(0, -10) : kp;
    if (!isInside(realRoot, real) || isGitInternal(realRoot, real)) {
      throw escapeError();
    }
    return;
  }
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw escapeError();
  }
  if (!isInside(realRoot, real) || isGitInternal(realRoot, real)) {
    throw escapeError();
  }
  const named = await fs.stat(real, { bigint: true });
  if (named.dev !== st.dev || named.ino !== st.ino) throw escapeError();
}

export interface ConfinedRead {
  content: string;
  size: number;
}

/**
 * Read a regular file at `abs` (already lexically inside `root`) only if the
 * opened file is inside `root`. `ENOENT` propagates as the fs error.
 */
export async function readConfinedFile(
  root: string,
  abs: string,
  opts: { maxBytes?: number } = {},
): Promise<ConfinedRead> {
  const buf = await readConfinedBytes(root, abs, opts);
  return { content: buf.toString("utf8"), size: buf.length };
}

/** Byte-exact variant of {@link readConfinedFile} (archives, copies). */
export async function readConfinedBytes(
  root: string,
  abs: string,
  opts: { maxBytes?: number } = {},
): Promise<Buffer> {
  const fh = await fs.open(abs, constants.O_RDONLY | O_NONBLOCK);
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) {
      throw new ApiError(400, "not a file", "not_a_file");
    }
    await assertHandleConfined(root, abs, fh, st);
    if (opts.maxBytes !== undefined && st.size > BigInt(opts.maxBytes)) {
      throw new ApiError(413, "file is too large to open", "file_too_large");
    }
    const limit = opts.maxBytes ?? Number(st.size);
    // Bounded read: the file may grow after fstat.
    const buf = Buffer.alloc(Math.min(limit + 1, 64 * 1024 * 1024));
    let size = 0;
    while (size < buf.length) {
      const { bytesRead } = await fh.read(buf, size, buf.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (opts.maxBytes !== undefined && size > opts.maxBytes) {
      throw new ApiError(413, "file is too large to open", "file_too_large");
    }
    return buf.subarray(0, size);
  } finally {
    await fh.close();
  }
}

/**
 * Replace (or create) the regular file at `abs` only if the opened file is
 * inside `root`. Nothing is truncated or written before the check passes.
 */
export async function writeConfinedFile(
  root: string,
  abs: string,
  content: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fh: FileHandle;
    try {
      fh = await fs.open(abs, constants.O_WRONLY | O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      try {
        // O_EXCL never follows a final-component symlink, dangling or not.
        fh = await fs.open(
          abs,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            O_NOFOLLOW |
            O_NONBLOCK,
          0o666,
        );
      } catch (err2) {
        // Lost a race with a concurrent create: open the existing file.
        if ((err2 as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err2;
      }
    }
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) {
        throw Object.assign(new Error("not a regular file"), {
          code: "EISDIR",
        });
      }
      await assertHandleConfined(root, abs, fh, st);
      await fh.truncate(0);
      const data = Buffer.from(content, "utf8");
      if (testWriteHook) {
        await testWriteHook(abs, data.toString("utf8"));
      } else {
        let off = 0;
        while (off < data.length) {
          const { bytesWritten } = await fh.write(data, off, data.length - off, off);
          off += bytesWritten;
        }
      }
      return;
    } finally {
      await fh.close();
    }
  }
  throw escapeError();
}
