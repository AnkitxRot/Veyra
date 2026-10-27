import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { csrfGuard, isProxyPath, APP_CSP } from "../src/security.js";

function run(method: string, headers: Record<string, string>, allowed: string[] = []) {
  let err: unknown = "unset";
  csrfGuard(allowed)({ method, headers } as unknown as Request, {} as Response, (e?: unknown) => {
    err = e;
  });
  return err;
}

describe("csrfGuard", () => {
  it("passes safe methods regardless of origin", () => {
    expect(run("GET", { origin: "https://evil.example", host: "ide.test" })).toBeUndefined();
  });
  it("rejects cross-origin writes", () => {
    expect(run("POST", { origin: "https://evil.example", host: "ide.test" })).toMatchObject({ status: 403 });
  });
  it("allows same-host and allowlisted writes", () => {
    expect(run("POST", { origin: "http://ide.test", host: "ide.test" })).toBeUndefined();
    expect(run("PUT", { origin: "https://a.com", host: "x" }, ["https://a.com"])).toBeUndefined();
  });
  it("rejects Sec-Fetch-Site cross-site without Origin; allows no-header clients", () => {
    expect(run("DELETE", { "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403 });
    expect(run("POST", {})).toBeUndefined();
  });
});

describe("csp", () => {
  it("excludes proxy paths and forbids objects", () => {
    expect(isProxyPath("/api/projects/abc/proxy/3000/x")).toBe(true);
    expect(isProxyPath("/api/projects/abc/files")).toBe(false);
    expect(APP_CSP).toContain("object-src 'none'");
  });
});
