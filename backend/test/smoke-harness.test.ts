import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const smokeScriptPath = join(__dirname, "..", "..", "scripts", "smoke-test.js");

describe("Milestone 23 — Smoke Test Harness Helper Unit Tests", () => {
  it("displays help message on --help or -h and exits with code 0", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      smokeScriptPath,
      "--help",
    ]);
    expect(stdout).toContain("Veyra Production Deployment Smoke & Readiness Verification Harness");
    expect(stdout).toContain("--url=<url>");
  });

  it("rejects invalid target URLs with non-zero exit code and fatal error", async () => {
    try {
      await execFileAsync(process.execPath, [
        smokeScriptPath,
        "--url=not_a_valid_url",
      ]);
      expect.fail("Should have thrown error on invalid URL");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain("[FATAL] Invalid target URL");
    }
  });

  it("rejects unsupported protocols (e.g. ftp:// or file://)", async () => {
    try {
      await execFileAsync(process.execPath, [
        smokeScriptPath,
        "--url=ftp://example.com",
      ]);
      expect.fail("Should have thrown on non-http protocol");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain("[FATAL] Unsupported protocol");
    }
  });

  it("rejects embedded user credentials in URL to avoid accidental credential leaks", async () => {
    try {
      await execFileAsync(process.execPath, [
        smokeScriptPath,
        "--url=http://admin:secret@localhost:3000",
      ]);
      expect.fail("Should have thrown on embedded credentials");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain("[FATAL] Target URL must not contain embedded user credentials");
    }
  });

  it("fails with clear diagnostic output when target host is down/unreachable", async () => {
    try {
      await execFileAsync(process.execPath, [
        smokeScriptPath,
        "--url=http://127.0.0.1:59999",
      ]);
      expect.fail("Should have failed against unreachable target");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stdout).toContain("[FAIL] 1. Liveness Check");
      expect(err.stdout).toContain("Smoke Suite Summary");
      expect(err.stdout).toContain("Result:          FAILED");
    }
  });
});
