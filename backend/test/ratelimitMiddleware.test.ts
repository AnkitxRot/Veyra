import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { classifyProjectPath, routeRateLimit } from "../src/ratelimitMiddleware.js";
import { renderPrometheus, type ObservabilitySnapshot } from "../src/observability.js";
import { metricsGate } from "../src/security.js";

const call = (mw: (r: Request, s: Response, n: (e?: unknown) => void) => void, req: object) => {
  let err: unknown;
  mw(req as Request, {} as Response, (e) => (err = e));
  return err;
};

describe("route rate limit", () => {
  it("classifies paths", () => {
    expect(classifyProjectPath("/abc/file")).toBe("files");
    expect(classifyProjectPath("/abc/run")).toBe("run");
    expect(classifyProjectPath("/abc/git/status")).toBe("git");
    expect(classifyProjectPath("/abc/ai/action")).toBe("ai");
    expect(classifyProjectPath("/abc/collaborators")).toBeNull();
  });
  it("limits per user per bucket", () => {
    const mw = routeRateLimit({
      files: { max: 1, windowMs: 60000 }, run: { max: 1, windowMs: 60000 },
      git: { max: 1, windowMs: 60000 }, ai: { max: 1, windowMs: 60000 },
    });
    const r = (id: number, path: string) => ({ path, user: { id } });
    expect(call(mw, r(1, "/p/run"))).toBeUndefined();
    expect(call(mw, r(1, "/p/run"))).toMatchObject({ status: 429 });
    expect(call(mw, r(2, "/p/run"))).toBeUndefined();
    expect(call(mw, r(1, "/p/git/log"))).toBeUndefined();
  });
});

describe("metrics", () => {
  it("renders prometheus text", () => {
    const txt = renderPrometheus({
      activeWsConnections: 3, activeCollabRooms: 1, activeSandboxes: 2, totalCollabBroadcastSends: 9,
      memory: { rssBytes: 5, heapUsedBytes: 4 }, cpuUsageMicros: { userMicros: 2e6, systemMicros: 1e6 },
      dbCalls: { overall: { count: 7 } }, eventLoopLagMs: null,
    } as unknown as ObservabilitySnapshot);
    expect(txt).toContain("# TYPE veyra_ws_connections gauge");
    expect(txt).toContain("veyra_ws_connections 3");
    expect(txt).toContain("veyra_process_cpu_user_seconds_total 2");
  });
  it("gates by token or ip", () => {
    expect(call(metricsGate("s3", []), { headers: { authorization: "Bearer s3" } })).toBeUndefined();
    expect(call(metricsGate("s3", []), { headers: { authorization: "Bearer no" } })).toMatchObject({ status: 401 });
    expect(call(metricsGate(undefined, ["127.0.0.1"]), { headers: {}, ip: "::ffff:127.0.0.1" })).toBeUndefined();
    expect(call(metricsGate(undefined, ["127.0.0.1"]), { headers: {}, ip: "10.0.0.5" })).toMatchObject({ status: 403 });
  });
});
