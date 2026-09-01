import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { makeStdinWriter } from "../src/execution/sandbox.js";

// Docker-free. Exercises the stdin-write guard that the interactive
// execution controller (`/ws/execute` -> sandboxRun) relies on.
//
// Regression target: before makeStdinWriter attached an 'error' listener to
// the child's stdin, a stdin frame that arrived after the sandboxed process
// had already exited (an interactive program that returned, a `stop`
// SIGKILL, or a program that never reads stdin) produced an unhandled
// 'EPIPE' 'error' on the stream. A Node stream with no 'error' listener
// rethrows it as an uncaughtException, crashing the whole backend and
// dropping every connected user — the same bug class as the /ws/execute
// malformed-frame crash covered in ws.test.ts.

describe("makeStdinWriter", () => {
  it("does not crash the process when the child has already exited", async () => {
    // Child exits the moment it receives any stdin byte.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdin.on('data', () => process.exit(0)); process.stdin.resume();",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    const write = makeStdinWriter(child);

    let uncaught: unknown = null;
    const onUncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on("uncaughtException", onUncaught);

    try {
      const closed = once(child, "close");
      // Keep writing across the moment the child exits (on the first byte),
      // so a write lands on the pipe just as its read end disappears — the
      // exact race the interactive controller hits. Each write is large
      // enough not to be absorbed synchronously into the pipe buffer.
      const deadline = Date.now() + 600;
      while (Date.now() < deadline) {
        write("x".repeat(128 * 1024) + "\n");
        await new Promise((r) => setImmediate(r));
      }
      await closed;
      await new Promise((r) => setTimeout(r, 100));

      // The pipe must actually have broken under a write (otherwise this
      // test proves nothing). `stream.errored` records that error whether
      // or not a listener exists; the point of the guard is that a listener
      // *does* exist so Node does not also rethrow it as uncaughtException.
      expect(child.stdin.errored).not.toBeNull();
      expect(uncaught).toBeNull();
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      child.kill("SIGKILL");
    }
  });

  it("still delivers stdin to a live child", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',d=>{s+=d;if(s.includes('\\n')){process.stdout.write('GOT:'+s.trim());process.exit(0);}});",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
    });

    const write = makeStdinWriter(child);
    write("hello world\n");

    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(0);
    expect(out).toBe("GOT:hello world");
  });
});
