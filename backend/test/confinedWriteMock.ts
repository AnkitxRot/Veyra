/**
 * M90 — Shared confined-write test utilities.
 *
 * M87 replaced fs.writeFile with writeConfinedFile (handle-based I/O) in
 * flushToDisk(). Tests that still mock fs.writeFile silently bypass the
 * production write path. This module provides helpers that route through
 * setConfinedWriteForTests instead.
 *
 * Usage:
 *   import { controlWriteFile, failWritesTo, resetWriteControl } from
 *     "../test/confinedWriteMock.js";
 *
 *   // Replace all confined writes:
 *   const cleanup = controlWriteFile(async (abs, data) => {
 *     // custom logic, or delegate to real write:
 *     const { writeFileSync } = await import("node:fs");
 *     writeFileSync(abs, data, "utf-8");
 *   });
 *
 *   // Poison writes to specific paths:
 *   failWritesTo("blocked.txt"); // throws EACCES for paths ending in blocked.txt
 *
 *   // Reset in afterEach:
 *   resetWriteControl();
 */

import { setConfinedWriteForTests } from "../src/files/confined.js";
import { writeFileSync } from "node:fs";

let writeControlReset: (() => void) | null = null;

/** Reset the confined-write hook to the production implementation. */
export function resetWriteControl(): void {
  if (writeControlReset) {
    writeControlReset();
    writeControlReset = null;
  }
}

/**
 * Route all confined writes through `handler(absPath, data)`. Return a
 * function that resets or reconfigures the hook.
 *
 * Usage:
 *   const cleanup = controlWriteFile(async (abs, data) => {
 *     // custom logic, or delegate to real write:
 *     const { writeFileSync } = await import("node:fs");
 *     writeFileSync(abs, data, "utf-8");
 *   });
 *
 *   // Later, change the behavior without resetting:
 *   cleanup({ passThrough: true });  // switches to real writeFileSync
 *
 *   // Or reset entirely:
 *   cleanup();  // restores production writeConfinedFile
 */
export function controlWriteFile(
  handler: (abs: string, data: string) => Promise<void>,
): (config?: { passThrough?: boolean }) => void {
  setConfinedWriteForTests(handler);
  return (config?: { passThrough?: boolean }) => {
    if (config?.passThrough) {
      setConfinedWriteForTests(async (abs, data) => {
        writeFileSync(abs, data, "utf-8");
      });
    } else {
      setConfinedWriteForTests(null);
    }
  };
}

/**
 * Poison confined writes for files whose absolute path ends in `suffix`.
 * Non-matching writes pass through to the real filesystem.
 */
export function failWritesTo(suffix: string): () => void {
  const cleanup = controlWriteFile(async (abs: string, data: string) => {
    if (abs.replace(/\\/g, "/").endsWith(suffix)) {
      throw Object.assign(new Error("EACCES: m86 poisoned write"), {
        code: "EACCES",
      });
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(abs, data, "utf-8");
  });
  return cleanup;
}
