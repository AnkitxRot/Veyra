#!/usr/bin/env node
/**
 * Stdio ↔ TCP bridge for vscode-js-debug's dapDebugServer.
 *
 * js-debug speaks DAP over a localhost TCP port, not stdio. This wrapper
 * (baked into the runner image) is the only Node debug adapter the backend
 * ever execs. It never leaves the sandbox.
 */
import { spawn } from "node:child_process";
import net from "node:net";

const SERVER = "/opt/debug/js-debug/src/dapDebugServer.js";
const STARTUP_MS = 15_000;

const child = spawn(process.execPath, [SERVER, "0", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const stdinChunks = [];
let stdinBuffered = 0;
const MAX_STDIN_BUFFER = 256 * 1024;
let sock = null;
let connected = false;
let connecting = false;

process.stdin.on("data", (chunk) => {
  if (connected && sock) sock.write(chunk);
  else {
    if (stdinBuffered + chunk.length > MAX_STDIN_BUFFER) process.exit(1);
    stdinBuffered += chunk.length;
    stdinChunks.push(chunk);
  }
});
process.stdin.on("end", () => {
  if (sock) sock.end();
});

let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (s) => {
  buf += s;
  if (connecting || connected) return;
  const m = /Debug server listening at ([^\s]+)/.exec(buf);
  if (m) connect(m[1]);
});
child.stderr.pipe(process.stderr);
child.on("error", () => process.exit(1));
child.on("exit", (code) => {
  if (!connected) process.exit(code ?? 1);
});

function connect(addr) {
  connecting = true;
  let host = "127.0.0.1";
  let port = 0;
  const idx = addr.lastIndexOf(":");
  if (idx <= 0) {
    process.exit(1);
    return;
  }
  host = addr.slice(0, idx);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  port = Number(addr.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0) {
    process.exit(1);
    return;
  }
  sock = net.connect({ host, port }, () => {
    connected = true;
    for (const c of stdinChunks) sock.write(c);
    stdinChunks.length = 0;
  });
  sock.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  sock.on("close", () => {
    try {
      child.kill("SIGKILL");
    } catch {}
    process.exit(0);
  });
  sock.on("error", () => {
    try {
      child.kill("SIGKILL");
    } catch {}
    process.exit(1);
  });
}

setTimeout(() => {
  if (!connected) process.exit(1);
}, STARTUP_MS).unref?.();
