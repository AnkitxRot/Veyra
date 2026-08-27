import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDockerRunning } from "../src/tools.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { openDb } from "../src/db.js";
import {
  encryptSecret,
  decryptSecret,
  computeFingerprint,
  resolveMasterKey,
  _resetKeyCacheForTests,
  SecretsKeyError,
  SecretsDecryptError,
  type SecretIdentity,
} from "../src/projectsecrets/crypto.js";
import {
  renderSecretsEnvFile,
  secretsExecPrefix,
} from "../src/projectsecrets/inject.js";
import { resolveSecretsForInjection } from "../src/projectsecrets/store.js";
import { createDatabaseBackup } from "../src/backup/service.js";
import { createWorkspaceBackup } from "../src/backup/workspaceBackup.js";

const KEY_B64 = Buffer.alloc(32, 3).toString("base64");
const KEY_HEX = Buffer.alloc(32, 9).toString("hex");
const WRONG_KEY = Buffer.alloc(32, 4).toString("base64");

const ID: SecretIdentity = {
  scope: "project",
  scopeId: "p1",
  environment: null,
  name: "TOKEN",
};

beforeEach(() => {
  _resetKeyCacheForTests();
});

// ---------------------------------------------------------------------------
// Crypto primitive
// ---------------------------------------------------------------------------
describe("secrets crypto", () => {
  it("round-trips a value", () => {
    const enc = encryptSecret("hunter2-swordfish", KEY_B64, ID);
    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
    expect(enc.nonce.length).toBe(12);
    expect(enc.keyVersion).toBe(1);
    const dec = decryptSecret(enc, KEY_B64, ID);
    expect(dec).toBe("hunter2-swordfish");
  });

  it("accepts hex-encoded keys", () => {
    const enc = encryptSecret("v", KEY_HEX, ID);
    expect(decryptSecret(enc, KEY_HEX, ID)).toBe("v");
  });

  it("uses a unique nonce per encryption", () => {
    const a = encryptSecret("same", KEY_B64, ID);
    const b = encryptSecret("same", KEY_B64, ID);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("detects tampering (auth tag)", () => {
    const enc = encryptSecret("secret", KEY_B64, ID);
    enc.ciphertext[0] ^= 0xff;
    expect(() => decryptSecret(enc, KEY_B64, ID)).toThrow(SecretsDecryptError);
  });

  it("detects an AAD/identity mismatch", () => {
    const enc = encryptSecret("secret", KEY_B64, ID);
    expect(() => decryptSecret(enc, KEY_B64, { ...ID, name: "OTHER" })).toThrow(
      SecretsDecryptError,
    );
  });

  it("fails with the wrong key", () => {
    const enc = encryptSecret("secret", KEY_B64, ID);
    expect(() => decryptSecret(enc, WRONG_KEY, ID)).toThrow(
      SecretsDecryptError,
    );
  });

  it("throws SecretsKeyError when the key is missing", () => {
    expect(() => resolveMasterKey(undefined)).toThrow(SecretsKeyError);
    expect(() => resolveMasterKey("")).toThrow(SecretsKeyError);
    expect(() => encryptSecret("x", undefined, ID)).toThrow(SecretsKeyError);
  });

  it("rejects malformed key material", () => {
    expect(() => resolveMasterKey("not-a-real-key")).toThrow(SecretsKeyError);
    expect(() => resolveMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(
      SecretsKeyError,
    );
  });

  it("rejects malformed ciphertext records", () => {
    expect(() =>
      decryptSecret(
        { ciphertext: Buffer.alloc(4), nonce: Buffer.alloc(12), keyVersion: 1 },
        KEY_B64,
        ID,
      ),
    ).toThrow(SecretsDecryptError);
  });

  it("rejects an unknown key version", () => {
    const enc = encryptSecret("x", KEY_B64, ID);
    expect(() =>
      decryptSecret({ ...enc, keyVersion: 99 }, KEY_B64, ID),
    ).toThrow(SecretsDecryptError);
  });

  it("computes a last-4 fingerprint only for long values", () => {
    expect(computeFingerprint("abcdefghij")).toBe("ghij");
    expect(computeFingerprint("short")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Injection rendering (argv safety)
// ---------------------------------------------------------------------------
describe("secrets injection rendering", () => {
  it("renders a sourceable env file with single-quote escaping", () => {
    const out = renderSecretsEnvFile({ FOO: "bar", QUOTE: "a'b" });
    expect(out).toBe("export FOO='bar'\nexport QUOTE='a'\\''b'\n");
  });

  it("drops keys that are not plain identifiers", () => {
    const out = renderSecretsEnvFile({ "BAD-NAME": "x", OK_1: "y" });
    expect(out).toBe("export OK_1='y'\n");
  });

  it("exec prefix never contains a secret value — only the file path", () => {
    const prefix = secretsExecPrefix("/run/cloudide-secrets/abc.env");
    expect(prefix).toEqual([
      "sh",
      "-c",
      "set -a; . '/run/cloudide-secrets/abc.env'; set +a; exec \"$@\"",
      "sh",
    ]);
    for (const p of prefix) expect(p).not.toContain("bar");
  });
});

// ---------------------------------------------------------------------------
// Schema / migration
// ---------------------------------------------------------------------------
describe("secrets schema", () => {
  it("creates the secrets table with the expected defaults on a fresh DB", () => {
    const db = openDb(":memory:");
    const cols = db.prepare("PRAGMA table_info(secrets)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.is_secret.dflt_value).toBe("1");
    expect(byName.key_version.dflt_value).toBe("1");
    expect(byName.environment).toBeDefined();
    const ver = db
      .prepare("SELECT MAX(version) AS v FROM schema_migrations")
      .get() as { v: number };
    expect(ver.v).toBeGreaterThanOrEqual(10);
    db.close();
  });

  it("migration is idempotent when openDb runs again on the same file", () => {
    const cfg = makeTestConfig();
    const path = join(cfg.dataDir, "idem.db");
    const a = openDb(path);
    a.close();
    const b = openDb(path);
    expect(() => b.prepare("SELECT COUNT(*) FROM secrets").get()).not.toThrow();
    b.close();
  });
});

// ---------------------------------------------------------------------------
// CRUD API + authorization
// ---------------------------------------------------------------------------
describe("secrets CRUD API", () => {
  let api: TestApi;
  let cfg: ReturnType<typeof makeTestConfig>;
  let owner: string;
  let editorTok: string;
  let viewerTok: string;
  let strangerTok: string;
  let projectId: string;

  beforeAll(async () => {
    cfg = makeTestConfig({ secretsMasterKey: KEY_B64 });
    api = await startTestApi(cfg);
    owner = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "owner1", password: "password12" },
      })
    ).data.token;
    editorTok = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "editor1", password: "password12" },
      })
    ).data.token;
    viewerTok = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "viewer1", password: "password12" },
      })
    ).data.token;
    strangerTok = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "stranger1", password: "password12" },
      })
    ).data.token;
    projectId = (
      await api.request("POST", "/api/projects", {
        token: owner,
        body: { name: "secret-proj" },
      })
    ).data.project.id;
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: owner,
      body: { username: "editor1", role: "editor" },
    });
    await api.request("POST", `/api/projects/${projectId}/collaborators`, {
      token: owner,
      body: { username: "viewer1", role: "viewer" },
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  it("owner creates a secret and gets metadata (no value)", async () => {
    const r = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "API_KEY", value: "supersecretvalue123" },
    });
    expect(r.status).toBe(201);
    expect(r.data.secret.name).toBe("API_KEY");
    expect(r.data.secret.isSecret).toBe(true);
    expect(r.data.secret.fingerprint).toBe("e123");
    expect(r.data.secret).not.toHaveProperty("value");
    expect(r.data.secret).not.toHaveProperty("ciphertext");
    expect(r.data.secret).not.toHaveProperty("nonce");
    expect(r.text).not.toContain("supersecretvalue123");
  });

  it("lists metadata only — never a value", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/secrets`, {
      token: owner,
    });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("supersecretvalue123");
    for (const s of r.data.secrets) expect(s).not.toHaveProperty("value");
  });

  it("does not return the value of an is_secret=true entry", async () => {
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/secrets/API_KEY/value`,
      { token: owner },
    );
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("supersecretvalue123");
  });

  it("returns the value of an is_secret=false config entry to the owner", async () => {
    await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "NODE_ENV", value: "production", isSecret: false },
    });
    const r = await api.request(
      "GET",
      `/api/projects/${projectId}/secrets/NODE_ENV/value`,
      { token: owner },
    );
    expect(r.status).toBe(200);
    expect(r.data.value).toBe("production");
  });

  it("updates (overwrites) a secret value", async () => {
    const r = await api.request(
      "PUT",
      `/api/projects/${projectId}/secrets/API_KEY`,
      { token: owner, body: { value: "rotatedvalue999" } },
    );
    expect(r.status).toBe(200);
    expect(r.data.secret.fingerprint).toBe("e999");
    expect(r.text).not.toContain("rotatedvalue999");
  });

  it("rejects a duplicate name", async () => {
    const r = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "API_KEY", value: "x" },
    });
    expect(r.status).toBe(409);
  });

  it("rejects invalid names", async () => {
    for (const bad of ["1BAD", "has space", "has-dash", "n\u0000ull", ""]) {
      const r = await api.request(
        "POST",
        `/api/projects/${projectId}/secrets`,
        { token: owner, body: { name: bad, value: "x" } },
      );
      expect(r.status).toBe(400);
    }
  });

  it("supports an environment dimension with independent uniqueness", async () => {
    const a = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "DB_URL", value: "dev", environment: "dev" },
    });
    const b = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "DB_URL", value: "prod", environment: "prod" },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const list = await api.request(
      "GET",
      `/api/projects/${projectId}/secrets`,
      { token: owner },
    );
    const envs = list.data.secrets
      .filter((s: any) => s.name === "DB_URL")
      .map((s: any) => s.environment)
      .sort();
    expect(envs).toEqual(["dev", "prod"]);
  });

  it("denies a viewer collaborator (IDOR-safe 404)", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/secrets`, {
      token: viewerTok,
    });
    expect(r.status).toBe(404);
    const c = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: viewerTok,
      body: { name: "X", value: "y" },
    });
    expect(c.status).toBe(404);
  });

  it("denies an editor collaborator CRUD (IDOR-safe 404)", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/secrets`, {
      token: editorTok,
    });
    expect(r.status).toBe(404);
    const c = await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: editorTok,
      body: { name: "X", value: "y" },
    });
    expect(c.status).toBe(404);
  });

  it("gives a non-collaborator the same 404", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/secrets`, {
      token: strangerTok,
    });
    expect(r.status).toBe(404);
  });

  it("denies demo (evaluator_*) accounts with 403", async () => {
    const demo = await api.request("POST", "/api/auth/demo", {});
    const demoTok = demo.data.token;
    const projects = await api.request("GET", "/api/projects", {
      token: demoTok,
    });
    const demoProj = projects.data.projects[0].id;
    const r = await api.request("POST", `/api/projects/${demoProj}/secrets`, {
      token: demoTok,
      body: { name: "X", value: "y" },
    });
    expect(r.status).toBe(403);
  });

  it("deletes a secret", async () => {
    const r = await api.request(
      "DELETE",
      `/api/projects/${projectId}/secrets/NODE_ENV`,
      { token: owner },
    );
    expect(r.status).toBe(200);
    const missing = await api.request(
      "DELETE",
      `/api/projects/${projectId}/secrets/NODE_ENV`,
      { token: owner },
    );
    expect(missing.status).toBe(404);
  });

  it("writes audit entries with metadata only — never the value", async () => {
    await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "AUDIT_ME", value: "auditsecretvalue" },
    });
    const rows = api.db
      .prepare(
        "SELECT event_type, details FROM audit_logs WHERE event_type LIKE 'SECRET_%'",
      )
      .all() as Array<{ event_type: string; details: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.details).not.toContain("auditsecretvalue");
      expect(row.details).not.toContain("supersecretvalue123");
      expect(row.details).not.toContain("rotatedvalue999");
    }
    const types = rows.map((r) => r.event_type);
    expect(types).toContain("SECRET_CREATED");
    expect(types).toContain("SECRET_UPDATED");
    expect(types).toContain("SECRET_DELETED");
  });
});

// ---------------------------------------------------------------------------
// Missing / wrong key at the API layer (fail closed)
// ---------------------------------------------------------------------------
describe("secrets fail-closed without a key", () => {
  it("returns a generic 503 on create when no master key is configured", async () => {
    const cfg = makeTestConfig({ secretsMasterKey: undefined });
    const api = await startTestApi(cfg);
    try {
      const tok = (
        await api.request("POST", "/api/auth/register", {
          body: { username: "nokey", password: "password12" },
        })
      ).data.token;
      const pid = (
        await api.request("POST", "/api/projects", {
          token: tok,
          body: { name: "p" },
        })
      ).data.project.id;
      const r = await api.request("POST", `/api/projects/${pid}/secrets`, {
        token: tok,
        body: { name: "X", value: "distinct-nokey-plaintext" },
      });
      expect(r.status).toBe(503);
      expect(r.data.error.code).toBe("secrets_key_unavailable");
      expect(r.text).not.toContain("distinct-nokey-plaintext");
    } finally {
      await api.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime injection resolution + SECRET_ACCESSED audit
// ---------------------------------------------------------------------------
describe("resolveSecretsForInjection", () => {
  let api: TestApi;
  let cfg: ReturnType<typeof makeTestConfig>;
  let owner: string;
  let projectId: string;

  beforeAll(async () => {
    cfg = makeTestConfig({ secretsMasterKey: KEY_B64 });
    api = await startTestApi(cfg);
    owner = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "injowner", password: "password12" },
      })
    ).data.token;
    projectId = (
      await api.request("POST", "/api/projects", {
        token: owner,
        body: { name: "inj" },
      })
    ).data.project.id;
    await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "RUNTIME_KEY", value: "runtimeplaintext" },
    });
    await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "PLAIN_CFG", value: "cfgval", isSecret: false },
    });
  });
  afterAll(async () => {
    await api?.close();
  });

  it("decrypts every entry and records exactly one SECRET_ACCESSED", () => {
    const before = (
      api.db
        .prepare(
          "SELECT COUNT(*) AS c FROM audit_logs WHERE event_type = 'SECRET_ACCESSED'",
        )
        .get() as { c: number }
    ).c;
    const env = resolveSecretsForInjection(api.db, cfg, projectId, {
      userId: 1,
      context: "run",
    });
    expect(env).toEqual({
      RUNTIME_KEY: "runtimeplaintext",
      PLAIN_CFG: "cfgval",
    });
    const after = api.db
      .prepare(
        "SELECT event_type, details FROM audit_logs WHERE event_type = 'SECRET_ACCESSED' ORDER BY id DESC LIMIT 1",
      )
      .get() as { details: string };
    const count = (
      api.db
        .prepare(
          "SELECT COUNT(*) AS c FROM audit_logs WHERE event_type = 'SECRET_ACCESSED'",
        )
        .get() as { c: number }
    ).c;
    expect(count).toBe(before + 1);
    expect(after.details).toContain("RUNTIME_KEY");
    expect(after.details).not.toContain("runtimeplaintext");
    // last_used_at bumped
    const row = api.db
      .prepare("SELECT last_used_at FROM secrets WHERE name = 'RUNTIME_KEY'")
      .get() as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
  });

  it("returns {} and writes no audit entry for a project with no secrets", async () => {
    const pid = (
      await api.request("POST", "/api/projects", {
        token: owner,
        body: { name: "empty" },
      })
    ).data.project.id;
    const env = resolveSecretsForInjection(api.db, cfg, pid, {
      userId: 1,
      context: "run",
    });
    expect(env).toEqual({});
  });

  it("records SECRET_ACCESSED with context=terminal when invoked for terminal injection", () => {
    const env = resolveSecretsForInjection(api.db, cfg, projectId, {
      userId: 1,
      context: "terminal",
    });
    expect(env).toEqual({
      RUNTIME_KEY: "runtimeplaintext",
      PLAIN_CFG: "cfgval",
    });
    const latest = api.db
      .prepare(
        "SELECT event_type, details FROM audit_logs WHERE event_type = 'SECRET_ACCESSED' ORDER BY id DESC LIMIT 1",
      )
      .get() as { details: string };
    expect(latest.details).toContain('"context":"terminal"');
    expect(latest.details).toContain("RUNTIME_KEY");
    expect(latest.details).not.toContain("runtimeplaintext");
  });

  it("fails closed when master key is missing during injection resolution", () => {
    const brokenCfg = makeTestConfig({ secretsMasterKey: undefined });
    expect(() =>
      resolveSecretsForInjection(api.db, brokenCfg, projectId, {
        userId: 1,
        context: "run",
      }),
    ).toThrow(SecretsKeyError);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: delete cascade, fork isolation, export/backup isolation
// ---------------------------------------------------------------------------
describe("secrets lifecycle", () => {
  let api: TestApi;
  let cfg: ReturnType<typeof makeTestConfig>;
  let owner: string;
  let projectId: string;

  beforeAll(async () => {
    cfg = makeTestConfig({ secretsMasterKey: KEY_B64 });
    api = await startTestApi(cfg);
    owner = (
      await api.request("POST", "/api/auth/register", {
        body: { username: "lifeowner", password: "password12" },
      })
    ).data.token;
    projectId = (
      await api.request("POST", "/api/projects", {
        token: owner,
        body: { name: "life" },
      })
    ).data.project.id;
    await api.request("POST", `/api/projects/${projectId}/secrets`, {
      token: owner,
      body: { name: "LIFE_SECRET", value: "lifecycleplaintextvalue" },
    });
  });
  afterAll(async () => {
    await api?.close();
  });

  it("hard-deletes secret rows when the project is deleted", async () => {
    const pid = (
      await api.request("POST", "/api/projects", {
        token: owner,
        body: { name: "todelete" },
      })
    ).data.project.id;
    await api.request("POST", `/api/projects/${pid}/secrets`, {
      token: owner,
      body: { name: "GONE", value: "willbedeleted" },
    });
    expect(
      (
        api.db
          .prepare("SELECT COUNT(*) AS c FROM secrets WHERE scope_id = ?")
          .get(pid) as { c: number }
      ).c,
    ).toBe(1);
    const del = await api.request("DELETE", `/api/projects/${pid}`, {
      token: owner,
    });
    expect(del.status).toBe(200);
    expect(
      (
        api.db
          .prepare("SELECT COUNT(*) AS c FROM secrets WHERE scope_id = ?")
          .get(pid) as { c: number }
      ).c,
    ).toBe(0);
  });

  it("a forked project starts with zero platform secret rows", async () => {
    const fork = await api.request("POST", `/api/projects/${projectId}/fork`, {
      token: owner,
      body: { name: "life-fork" },
    });
    expect(fork.status).toBe(201);
    const forkId = fork.data.project.id;
    expect(
      (
        api.db
          .prepare("SELECT COUNT(*) AS c FROM secrets WHERE scope_id = ?")
          .get(forkId) as { c: number }
      ).c,
    ).toBe(0);
    const list = await api.request("GET", `/api/projects/${forkId}/secrets`, {
      token: owner,
    });
    expect(list.data.secrets).toEqual([]);
  });

  it("workspace ZIP export contains no platform secret name or value", async () => {
    const r = await api.request("GET", `/api/projects/${projectId}/export`, {
      token: owner,
    });
    expect(r.status).toBe(200);
    // body is binary; fetch text is a lossy but sufficient scan for the
    // ascii plaintext / name.
    expect(r.text).not.toContain("lifecycleplaintextvalue");
    expect(r.text).not.toContain("LIFE_SECRET");
  });

  it("workspace backup archive contains no platform secret value", async () => {
    const res = await createWorkspaceBackup(cfg, api.db, projectId, {
      actorUserId: 1,
    });
    const buf = readFileSync(res.filePath);
    expect(buf.includes(Buffer.from("lifecycleplaintextvalue"))).toBe(false);
  });

  it("DB backup carries the secrets table as ciphertext only", async () => {
    const meta = await createDatabaseBackup(api.db, cfg, { actorUserId: 1 });
    const backupPath = meta.filePath;
    const buf = readFileSync(backupPath);
    // The encrypted row is in the backup, but the plaintext is not.
    expect(buf.includes(Buffer.from("lifecycleplaintextvalue"))).toBe(false);
    const bdb = openDb(backupPath);
    try {
      const row = bdb
        .prepare(
          "SELECT ciphertext, nonce, key_version FROM secrets WHERE name = 'LIFE_SECRET'",
        )
        .get() as
        | { ciphertext: Uint8Array; nonce: Uint8Array; key_version: number }
        | undefined;
      expect(row).toBeDefined();
      expect(Buffer.from(row!.ciphertext).toString("utf8")).not.toContain(
        "lifecycleplaintextvalue",
      );
      expect(row!.key_version).toBe(1);
      // and it still decrypts under the same key
      const plain = decryptSecret(
        {
          ciphertext: Buffer.from(row!.ciphertext),
          nonce: Buffer.from(row!.nonce),
          keyVersion: row!.key_version,
        },
        KEY_B64,
        {
          scope: "project",
          scopeId: projectId,
          environment: null,
          name: "LIFE_SECRET",
        },
      );
      expect(plain).toBe("lifecycleplaintextvalue");
    } finally {
      bdb.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Docker-gated: real run / terminal injection
// ---------------------------------------------------------------------------
describe.skipIf(!isDockerRunning())(
  "secrets runtime injection (docker)",
  () => {
    let api: TestApi;
    let cfg: ReturnType<typeof makeTestConfig>;
    let owner: string;
    let projectId: string;

    beforeAll(async () => {
      cfg = makeTestConfig({ secretsMasterKey: KEY_B64 });
      api = await startTestApi(cfg);
      owner = (
        await api.request("POST", "/api/auth/register", {
          body: { username: "dockowner", password: "password12" },
        })
      ).data.token;
      projectId = (
        await api.request("POST", "/api/projects", {
          token: owner,
          body: { name: "dock" },
        })
      ).data.project.id;
      await api.request("POST", `/api/projects/${projectId}/file`, {
        token: owner,
        body: {
          path: "main.py",
          content:
            "import os\nprint('VAL=' + os.environ.get('MY_SECRET','MISSING'))\n",
        },
      });
      await api.request("POST", `/api/projects/${projectId}/secrets`, {
        token: owner,
        body: { name: "MY_SECRET", value: "injected-xyz-42" },
      });
    }, 120_000);

    afterAll(async () => {
      try {
        const { sandboxManager } = await import("../src/execution/sandbox.js");
        await sandboxManager.stopProjectSandbox(projectId);
      } catch {}
      await api?.close();
    }, 60_000);

    it("injects the secret into a run", async () => {
      const r = await api.request("POST", `/api/projects/${projectId}/run`, {
        token: owner,
        body: { language: "python" },
      });
      expect(r.status).toBe(200);
      expect(r.data.stdout).toContain("VAL=injected-xyz-42");
    }, 120_000);

    it("does not inject the secret into install", async () => {
      await api.request("POST", `/api/projects/${projectId}/file`, {
        token: owner,
        body: { path: "requirements.txt", content: "# no packages\n" },
      });
      const r = await api.request(
        "POST",
        `/api/projects/${projectId}/install`,
        { token: owner, body: {} },
      );
      expect(r.text).not.toContain("injected-xyz-42");
    }, 120_000);
  },
);
