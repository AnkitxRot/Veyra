import { createServer as createHttpsServer, type Server } from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/**
 * Test-only HTTPS Git remote (git-http-backend + a generated self-signed cert).
 * Used to prove M80 clone/fetch/pull/push over the real HTTPS transport.
 */

function prependIfDir(dir: string): void {
  if (existsSync(dir) && !process.env.PATH?.includes(dir)) {
    process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  }
}

// Git for Windows often isn't on PATH for non-interactive shells.
prependIfDir("C:\\Program Files\\Git\\cmd");
prependIfDir("C:\\Program Files\\Git\\usr\\bin");

function findOpenssl(): string | null {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "/usr/bin/openssl",
    "/opt/homebrew/bin/openssl",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

export function generateSelfSignedTls(dir: string): {
  certPath: string;
  keyPath: string;
} {
  const openssl = findOpenssl();
  if (!openssl) {
    throw new Error("openssl is not available");
  }
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const extPath = join(dir, "san.cnf");
  const cnf = `[req]
distinguished_name = req
[req]
[v3]
subjectAltName = IP:127.0.0.1,DNS:localhost
`;
  writeFileSync(extPath, cnf);
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "2",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error("failed to generate TLS material");
  }
  return { certPath, keyPath };
}

export async function seedBareRepo(
  bareDir: string,
  files: Record<string, string>,
  opts: { branch?: string; extraCommits?: Array<Record<string, string>> } = {},
): Promise<void> {
  const branch = opts.branch ?? "main";
  const work = mkdtempSync(join(tmpdir(), "cloudide-git-work-"));
  try {
    try {
      execFileSync("git", ["init", "-b", branch, work], { stdio: "ignore" });
    } catch {
      execFileSync("git", ["init", work], { stdio: "ignore" });
      execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
        cwd: work,
        stdio: "ignore",
      });
    }
    execFileSync("git", ["config", "user.name", "testermc"], {
      cwd: work,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "test@veyra.local"], {
      cwd: work,
      stdio: "ignore",
    });
    for (const [rel, content] of Object.entries(files)) {
      const dest = join(work, rel);
      await fs.mkdir(join(dest, ".."), { recursive: true });
      await fs.writeFile(dest, content, "utf8");
    }
    execFileSync("git", ["add", "-A"], { cwd: work, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], {
      cwd: work,
      stdio: "ignore",
    });
    if (opts.extraCommits) {
      let i = 0;
      for (const extra of opts.extraCommits) {
        i++;
        for (const [rel, content] of Object.entries(extra)) {
          const dest = join(work, rel);
          await fs.mkdir(join(dest, ".."), { recursive: true });
          await fs.writeFile(dest, content, "utf8");
        }
        execFileSync("git", ["add", "-A"], { cwd: work, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", `extra ${i}`], {
          cwd: work,
          stdio: "ignore",
        });
      }
    }
    execFileSync("git", ["clone", "--bare", work, bareDir], { stdio: "ignore" });
    execFileSync("git", ["config", "http.receivepack", "true"], {
      cwd: bareDir,
      stdio: "ignore",
    });
  } finally {
    try {
      await fs.rm(work, { recursive: true, force: true });
    } catch {}
  }
}

export async function pushCommitsToBare(
  bareDir: string,
  files: Record<string, string>,
  message: string,
): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "cloudide-git-push-"));
  try {
    execFileSync("git", ["clone", bareDir, work], { stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "testermc"], {
      cwd: work,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "test@veyra.local"], {
      cwd: work,
      stdio: "ignore",
    });
    for (const [rel, content] of Object.entries(files)) {
      const dest = join(work, rel);
      await fs.mkdir(join(dest, ".."), { recursive: true });
      await fs.writeFile(dest, content, "utf8");
    }
    execFileSync("git", ["add", "-A"], { cwd: work, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", message], {
      cwd: work,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", "HEAD"], {
      cwd: work,
      stdio: "ignore",
    });
  } finally {
    try {
      await fs.rm(work, { recursive: true, force: true });
    } catch {}
  }
}

export interface TestGitRemote {
  url: string;
  port: number;
  reposRoot: string;
  bareDir: string;
  certPath: string;
  close: () => Promise<void>;
}

export async function startTestGitHttpsRemote(opts: {
  reposRoot: string;
  repoName?: string;
  certPath: string;
  keyPath: string;
  requireAuth?: { username: string; password: string };
  alwaysUnauthorized?: boolean;
}): Promise<TestGitRemote> {
  const repoName = opts.repoName ?? "repo.git";
  const cert = await fs.readFile(opts.certPath);
  const key = await fs.readFile(opts.keyPath);

  const server: Server = createHttpsServer({ cert, key }, (req, res) => {
    if (opts.alwaysUnauthorized) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end("unauthorized");
      return;
    }
    if (opts.requireAuth) {
      const hdr = req.headers.authorization ?? "";
      const expected =
        "Basic " +
        Buffer.from(
          `${opts.requireAuth.username}:${opts.requireAuth.password}`,
          "utf8",
        ).toString("base64");
      if (hdr !== expected) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        res.end("unauthorized");
        return;
      }
    }

    const host = req.headers.host ?? "127.0.0.1";
    const u = new URL(req.url || "/", `https://${host}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: opts.reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: u.pathname,
      PATH_TRANSLATED: join(opts.reposRoot, u.pathname.replace(/^\//, "")),
      REQUEST_METHOD: req.method || "GET",
      QUERY_STRING: u.search.startsWith("?") ? u.search.slice(1) : u.search,
      CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
      CONTENT_LENGTH: String(req.headers["content-length"] ?? "0"),
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: opts.requireAuth ? opts.requireAuth.username : "",
    };

    const child = spawn("git", ["http-backend"], {
      env,
      windowsHide: true,
    });
    req.pipe(child.stdin);

    let buf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!headersDone) {
        buf = Buffer.concat([buf, chunk]);
        let sep = buf.indexOf("\r\n\r\n");
        let sepLen = 4;
        if (sep === -1) {
          sep = buf.indexOf("\n\n");
          sepLen = 2;
        }
        if (sep === -1) return;
        const headerPart = buf.subarray(0, sep).toString("utf8");
        const rest = buf.subarray(sep + sepLen);
        const statusMatch = headerPart.match(/^Status:\s*(\d+)/im);
        res.statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;
        for (const line of headerPart.split(/\r?\n/)) {
          const c = line.indexOf(":");
          if (c > 0 && !/^Status:/i.test(line)) {
            res.setHeader(line.slice(0, c).trim(), line.slice(c + 1).trim());
          }
        }
        headersDone = true;
        if (rest.length) res.write(rest);
      } else {
        res.write(chunk);
      }
    });
    child.stderr.on("data", () => {
      // discard; product code never sees this helper's git-http-backend logs
    });
    child.on("close", () => {
      if (!headersDone) {
        if (!res.headersSent) res.statusCode = 500;
      }
      res.end();
    });
    child.on("error", () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `https://127.0.0.1:${port}/${repoName}`,
    port,
    reposRoot: opts.reposRoot,
    bareDir: join(opts.reposRoot, repoName),
    certPath: opts.certPath,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
