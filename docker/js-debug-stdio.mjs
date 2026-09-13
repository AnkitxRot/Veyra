#!/usr/bin/env node
/**
 * Stdio ↔ TCP bridge for vscode-js-debug's dapDebugServer.
 *
 * js-debug speaks DAP over a localhost TCP port, not stdio. A single file
 * launch also issues a DAP reverse-request `startDebugging` so the real
 * debuggee session can attach on a *second* TCP connection to the same
 * server. This wrapper (baked into the runner image) is the only Node debug
 * adapter the backend ever execs. It never leaves the sandbox.
 *
 * Stdio to the backend stays one DAP session. The child attach handshake is
 * internal to this process.
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
const MAX_PARSER = 256 * 1024;

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

function encode(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

function indexOfHeaderEnd(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

class Parser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    if (this.buf.length > MAX_PARSER) process.exit(1);
    const out = [];
    while (true) {
      const headerEnd = indexOfHeaderEnd(this.buf);
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      if (!Number.isFinite(len) || len < 0 || len > MAX_PARSER) process.exit(1);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) break;
      const json = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        out.push(JSON.parse(json));
      } catch {
        process.exit(1);
      }
    }
    return out;
  }
}

function start(port) {
  const proc = spawn(process.execPath, [SERVER, String(port), "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdinChunks = [];
  let stdinBuffered = 0;
  let parentSock = null;
  let childSock = null;
  let connected = false;
  let connecting = false;
  let childReady = false;
  let childAttaching = false;
  let buf = "";
  const deadline = Date.now() + STARTUP_MS;
  const parentParser = new Parser();
  const childParser = new Parser();
  const stdinParser = new Parser();
  const breakpoints = [];
  const childPending = new Map();
  let childSeq = 1;
  let childInitialized = false;
  const host = "127.0.0.1";

  function writeStdinTarget(chunk) {
    if (childReady && childSock) childSock.write(chunk);
    else if (parentSock) parentSock.write(chunk);
    else {
      if (stdinBuffered + chunk.length > MAX_STDIN_BUFFER) process.exit(1);
      stdinBuffered += chunk.length;
      stdinChunks.push(chunk);
    }
  }

  process.stdin.on("data", (chunk) => {
    for (const msg of stdinParser.push(chunk)) {
      if (msg?.type === "request" && msg.command === "setBreakpoints") {
        breakpoints.push(msg.arguments ?? {});
      }
    }
    writeStdinTarget(chunk);
  });
  process.stdin.on("end", () => {
    try {
      if (childSock) childSock.end();
    } catch {}
    try {
      if (parentSock) parentSock.end();
    } catch {}
  });

  function childRequest(command, args) {
    const seq = childSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        childPending.delete(seq);
        reject(new Error(`${command} timed out`));
      }, STARTUP_MS);
      childPending.set(seq, { resolve, reject, timer });
      childSock.write(
        encode({
          seq,
          type: "request",
          command,
          arguments: args ?? {},
        }),
      );
    });
  }

  function onChildMsg(msg) {
    if (msg?.type === "response" && typeof msg.request_seq === "number") {
      const pending = childPending.get(msg.request_seq);
      if (pending) {
        childPending.delete(msg.request_seq);
        clearTimeout(pending.timer);
        if (msg.success === false) {
          pending.reject(new Error(msg.message || "dap failed"));
        } else pending.resolve(msg.body);
        return;
      }
    }
    if (msg?.type === "event" && msg.event === "initialized") {
      childInitialized = true;
      if (!childReady) return;
    }
    if (!childReady && msg?.type === "response") return;
    process.stdout.write(encode(msg));
  }

  function connectOnce() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("child connect timeout"));
      }, 3000);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async function attachChild(cfg) {
    if (childAttaching || childSock) return;
    childAttaching = true;
    let lastErr = new Error("child connect failed");
    for (let i = 0; i < 8; i++) {
      try {
        const s = await connectOnce();
        childSock = s;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    if (!childSock) throw lastErr;

    childSock.on("data", (chunk) => {
      for (const msg of childParser.push(chunk)) onChildMsg(msg);
    });
    childSock.on("close", () => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      process.exit(0);
    });
    childSock.on("error", () => {});

    await childRequest("initialize", {
      adapterID: "pwa-node",
      clientID: "veyra",
      clientName: "Veyra",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: false,
      locale: "en-us",
    });

    const launchArgs =
      cfg && typeof cfg === "object"
        ? { ...cfg }
        : { type: "pwa-node", request: "launch" };
    const launchPromise = childRequest("launch", launchArgs);

    const waitInit = new Promise((resolve, reject) => {
      const startAt = Date.now();
      const poll = setInterval(() => {
        if (childInitialized) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - startAt > STARTUP_MS) {
          clearInterval(poll);
          reject(new Error("child initialize timed out"));
        }
      }, 10);
    });
    await waitInit;
    for (const bp of breakpoints) {
      await childRequest("setBreakpoints", bp);
    }
    await childRequest("configurationDone", {});
    childReady = true;
    await launchPromise;
  }

  function onParentMsg(msg) {
    if (msg?.type === "request" && msg.command === "startDebugging") {
      parentSock.write(
        encode({
          seq: Date.now() % 1_000_000,
          type: "response",
          request_seq: msg.seq,
          success: true,
          command: "startDebugging",
          body: {},
        }),
      );
      const cfg = msg.arguments?.configuration ?? {};
      attachChild(cfg).catch(() => process.exit(1));
      return;
    }
    process.stdout.write(encode(msg));
  }

  function attachParent(s) {
    parentSock = s;
    connected = true;
    connecting = false;
    for (const c of stdinChunks) s.write(c);
    stdinChunks.length = 0;
    s.on("data", (chunk) => {
      for (const msg of parentParser.push(chunk)) onParentMsg(msg);
    });
    s.on("close", () => {
      if (childReady) return;
      try {
        proc.kill("SIGKILL");
      } catch {}
      process.exit(0);
    });
    s.on("error", () => {
      if (childReady) return;
      try {
        proc.kill("SIGKILL");
      } catch {}
      process.exit(1);
    });
  }

  function tryConnect() {
    if (connected || connecting) return;
    connecting = true;
    const s = net.connect({ host, port }, () => attachParent(s));
    s.on("error", () => {
      connecting = false;
      if (connected) return;
      if (Date.now() < deadline) setTimeout(tryConnect, 40);
    });
  }

  function onProcOut(s) {
    buf += s;
    if (buf.length > 32 * 1024) buf = buf.slice(-16 * 1024);
    if (connected) return;
    const m = LISTEN.exec(buf);
    if (!m) return;
    const parsed = parseListen(m[1]);
    if (parsed && parsed.port === port) tryConnect();
  }

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", onProcOut);
  proc.stderr.on("data", (s) => {
    onProcOut(s);
    process.stderr.write(s);
  });
  proc.on("error", () => process.exit(1));
  proc.on("exit", (code) => {
    if (!connected) process.exit(code ?? 1);
  });

  tryConnect();

  setTimeout(() => {
    if (!connected) process.exit(1);
  }, STARTUP_MS).unref?.();
}

pickPort()
  .then(start)
  .catch(() => process.exit(1));
