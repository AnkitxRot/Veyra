#!/usr/bin/env node
/**
 * Stdio ↔ TCP bridge for vscode-js-debug's dapDebugServer.
 *
 * js-debug speaks DAP over a localhost TCP port, not stdio. This wrapper
 * (baked into the runner image) is the only Node debug adapter the backend
 * ever execs. It never leaves the sandbox.
 *
 * The listen banner may appear on stdout or stderr, and piped stdout can
 * buffer. We therefore pick a port, spawn the server with that port, and
 * retry TCP until it accepts (also matching the banner as a fallback).
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";

const CANDIDATES = [
  "/opt/debug/js-debug/src/dapDebugServer.js",
  "/opt/debug/src/dapDebugServer.js",
];
const SERVER = CANDIDATES.find((p) => existsSync(p));
if (!SERVER) process.exit(1);

const STARTUP_MS = 20_000;
const LISTEN = /Debug server listening at ([^\s]+)/;
const MAX_STDIN_BUFFER = 256 * 1024;

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => {
        if (err || !port) reject(err ?? new Error("no port"));
        else resolve(port);
      });
    });
  });
}

function parseListen(addr) {
  const idx = addr.lastIndexOf(":");
  if (idx <= 0) return null;
  let host = addr.slice(0, idx);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "::" || host === "0.0.0.0") {
    host = "127.0.0.1";
  }
  const port = Number(String(addr.slice(idx + 1)).replace(/[^\d].*$/, ""));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

function start(port) {
  const child = spawn(process.execPath, [SERVER, String(port), "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdinChunks = [];
  let stdinBuffered = 0;
  let sock = null;
  let connected = false;
  let connecting = false;
  let buf = "";
  const deadline = Date.now() + STARTUP_MS;

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

  function attach(s) {
    sock = s;
    connected = true;
    connecting = false;
    for (const c of stdinChunks) s.write(c);
    stdinChunks.length = 0;
    s.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    s.on("close", () => {
      try {
        child.kill("SIGKILL");
      } catch {}
      process.exit(0);
    });
    s.on("error", () => {
      try {
        child.kill("SIGKILL");
      } catch {}
      process.exit(1);
    });
  }

  function tryConnect(host, p) {
    if (connected || connecting) return;
    connecting = true;
    const s = net.connect({ host, port: p }, () => attach(s));
    s.on("error", () => {
      connecting = false;
      if (connected) return;
      if (Date.now() < deadline) setTimeout(() => tryConnect(host, p), 40);
    });
  }

  function onChildOut(s) {
    buf += s;
    if (buf.length > 32 * 1024) buf = buf.slice(-16 * 1024);
    if (connected) return;
    const m = LISTEN.exec(buf);
    if (!m) return;
    const parsed = parseListen(m[1]);
    if (parsed) tryConnect(parsed.host, parsed.port);
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", onChildOut);
  child.stderr.on("data", (s) => {
    onChildOut(s);
    process.stderr.write(s);
  });
  child.on("error", () => process.exit(1));
  child.on("exit", (code) => {
    if (!connected) process.exit(code ?? 1);
  });

  tryConnect("127.0.0.1", port);

  setTimeout(() => {
    if (!connected) process.exit(1);
  }, STARTUP_MS).unref?.();
}

pickPort()
  .then(start)
  .catch(() => process.exit(1));
