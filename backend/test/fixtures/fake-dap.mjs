#!/usr/bin/env node
/**
 * Deterministic DAP adapter for unit tests. Speaks Content-Length DAP over
 * stdio. Never used in production. Env flags:
 *   FAKE_DAP_CRASH, FAKE_DAP_SLOW, FAKE_DAP_MALFORMED, FAKE_DAP_HUGE_VAR
 */
import { Buffer } from "node:buffer";

const maxBytes = 256 * 1024;
let buf = Buffer.alloc(0);
let seq = 1;
let initialized = false;
let configured = false;
let running = false;
let paused = false;
let line = 3;
let terminated = false;
const breakpoints = new Map();

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

function event(name, body) {
  send({ seq: seq++, type: "event", event: name, body: body ?? {} });
}

function respond(req, body, success = true, message) {
  send({
    seq: seq++,
    type: "response",
    request_seq: req.seq,
    success,
    command: req.command,
    body: body ?? {},
    message,
  });
}

function programSource() {
  return { name: "main.py", path: "/workspace/main.py" };
}

function stop(reason) {
  running = false;
  paused = true;
  event("stopped", {
    reason,
    threadId: 1,
    description: reason,
    allThreadsStopped: true,
  });
}

function handle(req) {
  if (terminated) return;
  const cmd = req.command;
  const args = req.arguments ?? {};

  if (cmd === "initialize") {
    if (process.env.FAKE_DAP_SLOW === "1") return;
    respond(req, {
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: true,
      supportsEvaluateForHovers: false,
    });
    setTimeout(() => {
      initialized = true;
      event("initialized");
    }, 5);
    return;
  }

  if (cmd === "setBreakpoints") {
    const src = args.source?.path ?? "/workspace/main.py";
    const lines = (args.breakpoints ?? []).map((b) => b.line).filter(Boolean);
    breakpoints.set(src, lines);
    respond(req, {
      breakpoints: lines.map((line) => ({
        verified: line >= 1 && line <= 20,
        line,
      })),
    });
    return;
  }

  if (cmd === "launch") {
    respond(req, {});
    return;
  }

  if (cmd === "configurationDone") {
    configured = true;
    respond(req, {});
    const lines = breakpoints.get("/workspace/main.py") ?? [];
    running = true;
    if (lines.includes(3) || lines.includes(line)) {
      line = lines.includes(3) ? 3 : line;
      setTimeout(() => stop("breakpoint"), 10);
    } else if (process.env.FAKE_DAP_HOLD === "1") {
      // Stay running so tests can pause / terminate without a breakpoint.
    } else {
      setTimeout(() => {
        event("exited", { exitCode: 0 });
        event("terminated");
      }, 10);
    }
    return;
  }

  if (cmd === "continue") {
    if (!paused) {
      respond(req, {}, false, "not paused");
      return;
    }
    paused = false;
    running = true;
    respond(req, { allThreadsContinued: true });
    event("continued", { threadId: 1 });
    setTimeout(() => {
      event("exited", { exitCode: 0 });
      event("terminated");
    }, 10);
    return;
  }

  if (cmd === "pause") {
    if (!running) {
      respond(req, {}, false, "not running");
      return;
    }
    respond(req, {});
    stop("pause");
    return;
  }

  if (cmd === "next" || cmd === "stepIn" || cmd === "stepOut") {
    if (!paused) {
      respond(req, {}, false, "not paused");
      return;
    }
    line = Math.min(line + 1, 4);
    respond(req, {});
    stop("step");
    return;
  }

  if (cmd === "stackTrace") {
    respond(req, {
      stackFrames: [
        {
          id: 1,
          name: "main",
          line,
          column: 1,
          source: programSource(),
        },
        {
          id: 2,
          name: "<module>",
          line: 1,
          column: 1,
          source: programSource(),
        },
      ],
      totalFrames: 2,
    });
    return;
  }

  if (cmd === "scopes") {
    respond(req, {
      scopes: [
        { name: "Locals", variablesReference: 10, expensive: false },
      ],
    });
    return;
  }

  if (cmd === "variables") {
    if (process.env.FAKE_DAP_HUGE_VAR === "1") {
      respond(req, {
        variables: [
          {
            name: "blob",
            value: "x".repeat(20000),
            type: "str",
            variablesReference: 0,
          },
        ],
      });
      return;
    }
    respond(req, {
      variables: [
        { name: "x", value: "1", type: "int", variablesReference: 0 },
        { name: "y", value: "2", type: "int", variablesReference: 0 },
      ],
    });
    return;
  }

  if (cmd === "evaluate") {
    respond(req, { result: "should-never-run", variablesReference: 0 }, false, "blocked");
    return;
  }

  if (cmd === "threads") {
    respond(req, { threads: [{ id: 1, name: "MainThread" }] });
    return;
  }

  if (cmd === "terminate" || cmd === "disconnect") {
    terminated = true;
    respond(req, {});
    event("terminated");
    setTimeout(() => process.exit(0), 20);
    return;
  }

  respond(req, {}, false, "not implemented");
}

function indexOfHeaderEnd(b) {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

process.stdin.on("data", (chunk) => {
  if (process.env.FAKE_DAP_CRASH === "1" && initialized) {
    process.exit(1);
  }
  buf = Buffer.concat([buf, chunk]);
  if (buf.length > maxBytes) process.exit(1);
  while (true) {
    const headerEnd = indexOfHeaderEnd(buf);
    if (headerEnd < 0) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(1);
    const len = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
    buf = buf.subarray(bodyStart + len);
    if (process.env.FAKE_DAP_MALFORMED === "1") {
      process.stdout.write("not-a-dap-frame\n");
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (parsed && parsed.type === "request") handle(parsed);
  }
});

void configured;
