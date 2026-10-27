import { describe, it, expect } from "vitest";
import { applyPreviewIsolation, PREVIEW_CSP_SANDBOX } from "../src/projects/proxyTargets.js";

describe("preview proxy isolation", () => {
  it("adds a sandbox CSP without allow-same-origin when upstream sets none", () => {
    const headers: Record<string, string | string[] | undefined> = {};
    applyPreviewIsolation(headers);
    expect(headers["content-security-policy"]).toBe(PREVIEW_CSP_SANDBOX);
    expect(PREVIEW_CSP_SANDBOX).toMatch(/^sandbox\b/);
    expect(PREVIEW_CSP_SANDBOX).not.toContain("allow-same-origin");
  });

  it("keeps the upstream CSP and appends the sandbox policy", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "content-security-policy": "default-src 'self'",
    };
    applyPreviewIsolation(headers);
    expect(headers["content-security-policy"]).toBe(`default-src 'self', ${PREVIEW_CSP_SANDBOX}`);
  });

  it("merges array-valued upstream CSP headers", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "content-security-policy": ["default-src 'self'", "img-src *"],
    };
    applyPreviewIsolation(headers);
    expect(headers["content-security-policy"]).toBe(
      `default-src 'self', img-src *, ${PREVIEW_CSP_SANDBOX}`,
    );
  });

  it("strips upstream Set-Cookie so project code cannot plant IDE-origin cookies", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "set-cookie": ["session_token=evil; Path=/"],
    };
    applyPreviewIsolation(headers);
    expect(headers["set-cookie"]).toBeUndefined();
  });
});
