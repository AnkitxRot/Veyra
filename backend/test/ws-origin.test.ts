import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { isOriginAllowed, parseAllowedOrigins } from "../src/ws/origin.js";

const req = (origin?: string, host = "ide.example.com"): IncomingMessage =>
  ({ headers: { origin, host } }) as unknown as IncomingMessage;

describe("ws origin check", () => {
  it("allows missing Origin (non-browser client)", () => {
    expect(isOriginAllowed(req(undefined), [])).toBe(true);
  });
  it("defaults to same-host", () => {
    expect(isOriginAllowed(req("https://ide.example.com"), [])).toBe(true);
    expect(isOriginAllowed(req("https://evil.example"), [])).toBe(false);
  });
  it("rejects malformed Origin", () => {
    expect(isOriginAllowed(req("not a url"), [])).toBe(false);
  });
  it("uses the allowlist when set, ignoring Host", () => {
    const allowed = ["https://app.example.com"];
    expect(isOriginAllowed(req("https://app.example.com"), allowed)).toBe(true);
    expect(isOriginAllowed(req("https://ide.example.com"), allowed)).toBe(false);
  });
  it("parses and normalizes ALLOWED_ORIGINS", () => {
    expect(parseAllowedOrigins(" https://a.com/ , http://b.com:8080 ")).toEqual([
      "https://a.com",
      "http://b.com:8080",
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(() => parseAllowedOrigins("nope")).toThrow(/ALLOWED_ORIGINS/);
  });
});
