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
 *
 * After the child session is ready, parent *events* are dropped. Parent
 * *responses* (especially `launch`) still go to the backend. That stops the
 * parent session's `continued` / `terminated` from clobbering a real child
 * pause — the race that left the browser "Running" while FakeSock paused.
 *
 * TypeScript is precompiled into `/workspace/.cloudide-build-debug/<pid>`
 * (hidden from the file tree) with source maps rewritten to `/workspace/...`.
 * User sources are never mutated. `/tmp` emit is rejected because js-debug
 * relativizes those maps to `./../tmp/...` and then cannot bind breakpoints.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";

const CANDIDATES = [
  "/opt/debug/js-debug/src/dapDebugServer.js",
  "/opt/debug/src/dapDebugServer.js",
];
const TSC_CANDIDATES = [
  "/usr/local/lib/node_modules/typescript/bin/tsc",
  "/usr/local/bin/tsc",
];
const ESBUILD_CANDIDATES = [
  "/usr/local/lib/node_modules/tsx/node_modules/esbuild/bin/esbuild",
  "/usr/local/lib/node_modules/esbuild/bin/esbuild",
];
const STARTUP_MS = 20_000;
const LISTEN = /Debug server listening at ([^\s]+)/;
const MAX_STDIN_BUFFER = 256 * 1024;
const MAX_PARSER = 256 * 1024;
const WORKSPACE_PREFIX = "/workspace/";

export function isMainModule(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

/**
 * After the child DAP session owns the debuggee, only parent *responses*
 * may reach the backend. Parent events (continued/stopped/terminated/thread)
 * are the stale-session poison that overwrote a real pause.
 */
export function shouldForwardParentMessage(msg, childReady) {
  if (!msg || typeof msg !== "object") return false;
  if (!childReady) return true;
  return msg.type === "response";
}

/**
 * Child configurationDone must not run until the backend has sent its
 * launch-time breakpoints (or configurationDone with none). Otherwise
 * stopOnEntry + drain continues past unbound user breakpoints.
 */
export function shouldStartChildDebuggee(backendConfigured, waitedMs, timeoutMs = 2000) {
  return backendConfigured === true || waitedMs >= timeoutMs;
}

export function normalizeWorkspaceTsProgram(program, cwd) {
  if (typeof program !== "string" || program.length === 0 || program.length > 512) {
    return null;
  }
  let n = program.replace(/\\/g, "/");
  if (n.startsWith("file:")) {
    try {
      n = decodeURIComponent(n.replace(/^file:\/\/\/?/i, "/"));
      if (n.startsWith("/localhost/")) n = n.slice("/localhost".length);
    } catch {
      return null;
    }
  }
  if (!n.startsWith("/") && !/^[a-zA-Z]:/.test(n)) {
    const base =
      typeof cwd === "string" && cwd.replace(/\\/g, "/").startsWith("/workspace")
        ? cwd.replace(/\\/g, "/").replace(/\/$/, "")
        : "/workspace";
    n = `${base}/${n.replace(/^\.\//, "")}`;
  }
  const norm = posixNormalize(n);
  if (!norm || !norm.startsWith(WORKSPACE_PREFIX)) return null;
  if (norm.includes("\0") || norm.split("/").includes("..")) return null;
  if (!/\.ts$/i.test(norm)) return null;
  return norm;
}

export function isTypeScriptProgram(program) {
  return normalizeWorkspaceTsProgram(program) !== null;
}

export function posixNormalize(p) {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  const src = p.replace(/\\/g, "/");
  const drive = /^[a-zA-Z]:/.exec(src);
  const isAbs = src.startsWith("/") || !!drive;
  const parts = [];
  const raw = src.split("/");
  let i = 0;
  if (drive) {
    parts.push(raw[0]);
    i = 1;
  }
  for (; i < raw.length; i++) {
    const part = raw[i];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      if (drive && parts.length === 1) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (drive) {
    return parts.length === 1 ? `${parts[0]}/` : `${parts[0]}/${parts.slice(1).join("/")}`;
  }
  if (isAbs) return `/${parts.join("/")}`;
  return parts.join("/");
}

function isAbsolutePath(s) {
  return s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.startsWith("file:");
}

export function toWorkspaceSource(source, opts = {}) {
  if (typeof source !== "string" || !source || source.includes("\0")) return null;
  const sourceRoot = typeof opts.sourceRoot === "string" ? opts.sourceRoot : "";
  const actualRoot = posixNormalize(String(opts.actualRoot || "/workspace")) || "/workspace";
  const alias = String(opts.workspaceAlias || "/workspace").replace(/\/$/, "");
  const mapDir = opts.mapDir ? posixNormalize(String(opts.mapDir)) : null;
  let raw = source.replace(/\\/g, "/");
  if (raw.startsWith("file:")) {
    try {
      raw = decodeURIComponent(raw.replace(/^file:\/\/\/?/i, "/"));
      if (raw.startsWith("/localhost/")) raw = raw.slice("/localhost".length);
    } catch {
      return null;
    }
  }

  let combined;
  if (isAbsolutePath(raw)) {
    combined = raw;
  } else {
    const rel = `${sourceRoot}${raw}`.replace(/\\/g, "/");
    if (isAbsolutePath(rel)) {
      combined = rel;
    } else {
      const base = mapDir || actualRoot;
      combined = `${String(base).replace(/\/$/, "")}/${rel.replace(/^\.\//, "")}`;
    }
  }

  const s = posixNormalize(combined);
  if (!s) return null;

  const strip = (root) => {
    const r = String(root).replace(/\/$/, "");
    if (s === r) return null;
    const prefix = `${r}/`;
    if (s.startsWith(prefix)) {
      const rel = s.slice(prefix.length);
      if (!rel || rel.split("/").includes("..")) return null;
      return rel;
    }
    return null;
  };

  const fromActual = strip(actualRoot);
  if (fromActual) return `${alias}/${fromActual}`;
  const fromAlias = strip(alias);
  if (fromAlias) return `${alias}/${fromAlias}`;
  return null;
}

export function rewriteSourceMapSources(map, opts = {}) {
  if (!map || typeof map !== "object") return map;
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const next = [];
  for (const src of sources) {
    const mapped = toWorkspaceSource(src, {
      sourceRoot: map.sourceRoot,
      actualRoot: opts.actualRoot,
      workspaceAlias: opts.workspaceAlias,
      mapDir: opts.mapDir,
    });
    if (mapped) next.push(mapped);
  }
  map.sources = next;
  map.sourceRoot = "";
  return map;
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

export function rewriteSourceMapsUnder(outRoot, opts = {}) {
  const alias = String(opts.workspaceAlias || "/workspace").replace(/\/$/, "");
  for (const file of walkFiles(outRoot)) {
    if (!file.endsWith(".js.map") && !file.endsWith(".mjs.map")) continue;
    try {
      const map = JSON.parse(readFileSync(file, "utf8"));
      rewriteSourceMapSources(map, {
        ...opts,
        mapDir: dirname(file).replace(/\\/g, "/"),
      });
      if (!Array.isArray(map.sources) || map.sources.length === 0) {
        const relJs = relative(outRoot, file).replace(/\\/g, "/").replace(/\.map$/, "");
        const relTs = relJs.replace(/\.js$/i, ".ts");
        if (relTs && !relTs.includes("..") && !relTs.startsWith("/")) {
          map.sources = [`${alias}/${relTs}`];
        }
      }
      map.sourceRoot = "";
      writeFileSync(file, JSON.stringify(map));
    } catch {
      /* ignore a single bad map */
    }
  }
}

export function compiledJsPath(program, outRoot) {
  const n = String(program || "").replace(/\\/g, "/");
  const rel = n.startsWith(WORKSPACE_PREFIX)
    ? n.slice(WORKSPACE_PREFIX.length)
    : n.replace(/^.*\/workspace\//, "");
  if (!rel || rel.includes("..")) return null;
  return join(outRoot, rel.replace(/\.ts$/i, ".js")).replace(/\\/g, "/");
}

export function prepareChildLaunchConfig(cfg, compiledProgram) {
  const next = cfg && typeof cfg === "object" ? { ...cfg } : {};
  if (compiledProgram) {
    next.program = compiledProgram;
    delete next.runtimeArgs;
    next.sourceMaps = true;
    next.stopOnEntry = true;
    next.outFiles = [
      "/workspace/.cloudide-build-debug/**/*.js",
      "/tmp/veyra-debug/**/*.js",
    ];
    next.sourceMapPathOverrides = {
      "/workspace/*": "/workspace/*",
    };
    next.resolveSourceMapLocations = [
      "/workspace/**",
      "/tmp/veyra-debug/**",
      "!**/node_modules/**",
    ];
  }
  return next;
}

function resolveTsc(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const p of TSC_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveEsbuild() {
  for (const p of ESBUILD_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function compileTypeScriptProgram(program, opts = {}) {
  const allowHostPaths = opts.allowHostPaths === true;
  const workspaceRoot = String(opts.workspaceRoot || "/workspace").replace(
    /\\/g,
    "/",
  );
  const outRoot = String(opts.outRoot || "").replace(/\\/g, "/");
  if (!outRoot) throw new Error("missing TypeScript outDir");
  if (!allowHostPaths) {
    program = normalizeWorkspaceTsProgram(program);
    if (!program) {
      throw new Error("invalid TypeScript program path");
    }
    if (
      outRoot.includes("..") ||
      !(
        outRoot.startsWith("/tmp/veyra-debug/") ||
        outRoot.startsWith("/workspace/.cloudide-build-debug/")
      )
    ) {
      throw new Error("invalid TypeScript outDir");
    }
  } else if (String(program).includes("\0") || String(program).includes("..")) {
    throw new Error("invalid TypeScript program path");
  }

  mkdirSync(outRoot, { recursive: true });
  if (opts.bundle === true) {
    const esbuild = resolveEsbuild();
    if (esbuild) {
      const outfile = join(outRoot, "main.js").replace(/\\/g, "/");
      const bundled = spawnSync(
        esbuild,
        [
          program,
          "--bundle",
          "--platform=node",
          "--format=cjs",
          "--sourcemap",
          "--sources-content=false",
          `--outfile=${outfile}`,
          "--log-level=error",
        ],
        {
          encoding: "utf8",
          timeout: opts.timeoutMs ?? 25_000,
          windowsHide: true,
        },
      );
      if (existsSync(outfile)) {
        rewriteSourceMapsUnder(outRoot, {
          actualRoot: workspaceRoot,
          workspaceAlias: "/workspace",
        });
        return outfile;
      }
      if (bundled.status && bundled.stderr) {
        /* fall through to tsc */
      }
    }
  }
  const tsc = resolveTsc(opts.tscPath);
  if (!tsc) throw new Error("typescript compiler is not installed in the sandbox");

  const result = spawnSync(
    opts.execPath || process.execPath,
    [
      tsc,
      program,
      "--outDir",
      outRoot,
      "--rootDir",
      workspaceRoot,
      "--sourceMap",
      "--inlineSources",
      "false",
      "--declaration",
      "false",
      "--pretty",
      "false",
      "--skipLibCheck",
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "es2022",
      "--esModuleInterop",
      "--moduleDetection",
      "force",
    ],
    {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 25_000,
      windowsHide: true,
    },
  );
  const js = allowHostPaths
    ? join(outRoot, program.slice(workspaceRoot.length).replace(/^[/\\]/, "").replace(/\.ts$/i, ".js"))
    : compiledJsPath(program, outRoot);
  if (!js || !existsSync(js)) {
    const err = String(result.stderr || result.stdout || "compile produced no output").slice(
      0,
      400,
    );
    throw new Error(`TypeScript debug compile failed: ${err}`);
  }
  rewriteSourceMapsUnder(outRoot, {
    actualRoot: workspaceRoot,
    workspaceAlias: "/workspace",
  });
  return js.replace(/\\/g, "/");
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
  const SERVER = CANDIDATES.find((p) => existsSync(p));
  if (!SERVER) process.exit(1);

  const compileRoot = `/workspace/.cloudide-build-debug/${process.pid}`;
  const cleanup = () => {
    try {
      rmSync(compileRoot, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", cleanup);

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
  let backendConfigured = false;
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

  function rewriteLaunch(args) {
    if (!args || typeof args !== "object") return args;
    const tsProgram = normalizeWorkspaceTsProgram(args.program, args.cwd);
    if (!tsProgram) return args;
    const compiled = compileTypeScriptProgram(tsProgram, {
      outRoot: compileRoot,
    });
    try {
      process.stderr.write(
        `veyra-js-debug compiled ${tsProgram} -> ${compiled}\n`,
      );
    } catch {}
    return prepareChildLaunchConfig(args, compiled);
  }

  process.stdin.on("data", (chunk) => {
    for (const msg of stdinParser.push(chunk)) {
      if (msg?.type === "request" && msg.command === "setBreakpoints") {
        breakpoints.push(msg.arguments ?? {});
      }
      if (msg?.type === "request" && msg.command === "configurationDone") {
        backendConfigured = true;
      }
      if (msg?.type === "request" && msg.command === "launch") {
        try {
          msg.arguments = rewriteLaunch(msg.arguments ?? {});
        } catch (err) {
          try {
            process.stderr.write(
              `veyra-js-debug compile failed: ${err?.stack || err}\n`,
            );
          } catch {}
          process.exit(1);
        }
      }
      writeStdinTarget(encode(msg));
    }
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

  const childHold = [];

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
    }
    if (!childReady) {
      if (childHold.length < 64) childHold.push(msg);
      return;
    }
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

    let launchArgs =
      cfg && typeof cfg === "object"
        ? { ...cfg }
        : { type: "pwa-node", request: "launch" };
    try {
      launchArgs = rewriteLaunch(launchArgs);
    } catch (err) {
      try {
        process.stderr.write(
          `veyra-js-debug child compile failed: ${err?.stack || err}\n`,
        );
      } catch {}
      process.exit(1);
    }

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
    const waitCfgStart = Date.now();
    while (!shouldStartChildDebuggee(backendConfigured, Date.now() - waitCfgStart)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const bp of breakpoints) {
      await childRequest("setBreakpoints", bp);
    }
    await childRequest("configurationDone", {});
    childReady = true;
    for (const msg of childHold) process.stdout.write(encode(msg));
    childHold.length = 0;
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
      attachChild(cfg).catch((err) => {
        try {
          process.stderr.write(
            `veyra-js-debug child attach failed: ${err?.stack || err}\n`,
          );
        } catch {}
        process.exit(1);
      });
      return;
    }
    if (!shouldForwardParentMessage(msg, childReady)) return;
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

if (isMainModule()) {
  pickPort()
    .then(start)
    .catch(() => process.exit(1));
}
