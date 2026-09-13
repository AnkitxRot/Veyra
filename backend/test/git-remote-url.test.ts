import { describe, it, expect } from "vitest";
import {
  validateHttpsGitRemoteUrl,
  httpsRemoteHost,
  httpsRemotesEquivalent,
  sanitizeRemoteUrlForClient,
} from "../src/git/remoteUrl.js";
import { redactGitOutput } from "../src/git/redact.js";
import { askpassAllowsPrompt } from "../src/git/askpass.js";

function expectCode(fn: () => unknown, code: string, label?: string): void {
  try {
    fn();
    expect.fail(`${label ?? code}: expected throw`);
  } catch (err: any) {
    expect(err?.code, label).toBe(code);
  }
}

describe("M80 — HTTPS remote URL validator", () => {
  it("accepts ordinary HTTPS Git remotes", () => {
    expect(validateHttpsGitRemoteUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
    expect(validateHttpsGitRemoteUrl("https://gitlab.com/org/repo.git")).toBe(
      "https://gitlab.com/org/repo.git",
    );
    expect(
      validateHttpsGitRemoteUrl("https://git.example.com:8443/group/sub/repo.git"),
    ).toBe("https://git.example.com:8443/group/sub/repo.git");
    expect(validateHttpsGitRemoteUrl("https://127.0.0.1/repo.git")).toBe(
      "https://127.0.0.1/repo.git",
    );
    expect(validateHttpsGitRemoteUrl("https://[::1]/org/repo.git")).toBe(
      "https://[::1]/org/repo.git",
    );
    expect(
      validateHttpsGitRemoteUrl("https://[::1]:8443/org/repo.git"),
    ).toBe("https://[::1]:8443/org/repo.git");
    expect(httpsRemoteHost("https://[::1]:8443/org/repo.git")).toBe("::1");
  });

  it("trims surrounding whitespace but does not rewrite schemes", () => {
    expect(
      validateHttpsGitRemoteUrl("  https://github.com/org/repo.git  "),
    ).toBe("https://github.com/org/repo.git");
  });

  it("rejects git://", () => {
    expectCode(
      () => validateHttpsGitRemoteUrl("git://github.com/org/repo.git"),
      "unsupported_protocol",
    );
  });

  it("rejects ssh://", () => {
    expectCode(
      () => validateHttpsGitRemoteUrl("ssh://git@github.com/org/repo.git"),
      "unsupported_protocol",
    );
  });

  it("rejects SCP-like git@host:path", () => {
    expectCode(
      () => validateHttpsGitRemoteUrl("git@github.com:org/repo.git"),
      "unsupported_protocol",
    );
  });

  it("rejects file://", () => {
    expectCode(
      () => validateHttpsGitRemoteUrl("file:///tmp/repo"),
      "unsupported_protocol",
    );
  });

  it("rejects local filesystem paths", () => {
    for (const p of [
      "/tmp/repo",
      "C:\\repo",
      "\\\\server\\share",
      "./repo",
      "../repo",
      "~/repo",
    ]) {
      expectCode(() => validateHttpsGitRemoteUrl(p), "invalid_remote_url", p);
    }
  });

  it("rejects credential-bearing URLs", () => {
    expectCode(
      () =>
        validateHttpsGitRemoteUrl("https://user:token@github.com/org/repo.git"),
      "credential_bearing_url",
    );
    expectCode(
      () => validateHttpsGitRemoteUrl("https://user@github.com/org/repo.git"),
      "credential_bearing_url",
    );
    expectCode(
      () => validateHttpsGitRemoteUrl("https://:token@github.com/org/repo.git"),
      "credential_bearing_url",
    );
    expectCode(
      () =>
        validateHttpsGitRemoteUrl(
          "https://user%3Atoken@github.com/org/repo.git",
        ),
      "credential_bearing_url",
    );
  });

  it("rejects http:// and other non-https schemes", () => {
    expectCode(
      () => validateHttpsGitRemoteUrl("http://github.com/org/repo.git"),
      "unsupported_protocol",
    );
    expectCode(
      () => validateHttpsGitRemoteUrl("ftp://github.com/org/repo.git"),
      "unsupported_protocol",
    );
  });

  it("rejects malformed / ambiguous URLs", () => {
    for (const p of [
      "",
      "not a url",
      "https://",
      "https://github.com",
      "https://github.com/",
      "https://github.com/org/repo.git?foo=1",
      "https://github.com/org/repo.git#branch",
      "https://github.com/org/repo.git\nhttps://evil.test",
      "https://github.com/org/repo.git\u0000.git",
      "https://github.com\\org\\repo.git",
    ]) {
      expectCode(
        () => validateHttpsGitRemoteUrl(p),
        "invalid_remote_url",
        JSON.stringify(p),
      );
    }
  });

  it("does not coerce an unsafe URL into an allowed one", () => {
    expect(() =>
      validateHttpsGitRemoteUrl("ssh://git@github.com/org/repo.git"),
    ).toThrow();
    expect(() =>
      validateHttpsGitRemoteUrl("git@github.com:org/repo.git"),
    ).toThrow();
  });

  it("treats trailing .git / slash as equivalent remotes", () => {
    expect(
      httpsRemotesEquivalent(
        "https://github.com/org/repo.git",
        "https://github.com/org/repo",
      ),
    ).toBe(true);
  });

  it("strips userinfo before a URL is shown to a client", () => {
    expect(
      sanitizeRemoteUrlForClient("https://user:supersecret@github.com/org/repo.git"),
    ).not.toContain("supersecret");
    expect(
      sanitizeRemoteUrlForClient("https://user:supersecret@github.com/org/repo.git"),
    ).not.toContain("user:");
    expect(
      sanitizeRemoteUrlForClient(
        "https://github.com/org/repo.git?access_token=supersecret",
      ),
    ).not.toContain("supersecret");
    expect(
      sanitizeRemoteUrlForClient(
        "https://github.com/org/repo.git?access_token=supersecret",
      ),
    ).not.toContain("?");
  });
});

describe("M80 — askpass host binding", () => {
  it("releases credentials only for the validated HTTPS host", () => {
    expect(
      askpassAllowsPrompt("Password for 'https://github.com':", "github.com"),
    ).toBe(true);
    expect(
      askpassAllowsPrompt(
        "Password for 'https://git@github.com':",
        "github.com",
      ),
    ).toBe(true);
    expect(
      askpassAllowsPrompt("Password for 'https://[::1]:8443':", "::1"),
    ).toBe(true);
    expect(
      askpassAllowsPrompt("Password for 'https://evil.test':", "github.com"),
    ).toBe(false);
    expect(askpassAllowsPrompt("Password:", "github.com")).toBe(false);
  });
});

describe("M80 — Git output redaction", () => {
  it("redacts supplied secrets and userinfo / Authorization headers", () => {
    const token = "ghp_super_secret_token_value";
    const raw = [
      `fatal: Authentication failed for 'https://user:${token}@example.com/r.git'`,
      "Authorization: Basic abcdef1234",
      "Authorization: Bearer ghp_other",
    ].join("\n");
    const out = redactGitOutput(raw, [token]);
    expect(out).not.toContain(token);
    expect(out).not.toContain("abcdef1234");
    expect(out).not.toContain("ghp_other");
    expect(out).toContain("https://***@");
    expect(out).toContain("Authorization: Basic ***");
  });
});
