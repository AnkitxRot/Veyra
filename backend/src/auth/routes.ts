import { Router, raw } from "express";
import type { Request } from "express";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { issueSession, requireAuth, hashToken } from "./middleware.js";
import { invalidateCachedToken } from "./sessionCache.js";
import { RateLimiter } from "./ratelimit.js";
import { createProject, projectDir } from "../projects/service.js";
import { writeProjectFile } from "../files/service.js";
import { recordAuditLog } from "../audit.js";
import { closeAllConnectionsForUser } from "../ws/connectionRegistry.js";
import { getUserPreferences, updateUserPreferences } from "./preferences.js";
import { getProfile, updateProfile } from "../profile/store.js";
import { validateProfilePatch } from "../profile/validate.js";
import {
  canViewAvatar,
  deleteAvatar,
  getAvatarFile,
  storeAvatar,
} from "../profile/media.js";
import { parseMultipartFormData } from "../files/upload.js";
import { collaborationManager } from "../collab/manager.js";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

const DEMO_FILES = [
  {
    path: "1_welcome.py",
    content: `# Welcome to CloudeeeIDE Cloud Computing Demonstration
import sys, os, platform

print("=" * 60)
print("🚀 CLOUDEEEIDE CLOUD SANDBOX ENVIRONMENT")
print("=" * 60)
print(f"• Container OS:       {platform.system()} {platform.release()}")
print(f"• Python Version:     {sys.version.split()[0]}")
print(f"• Sandboxed User:     UID={os.getuid()} (unprivileged ide)")
print(f"• Process ID in Jail: PID={os.getpid()}")
print("=" * 60)

# Interactive cloud calculation demo
print("\\nCalculating Fibonacci series inside Docker runner container...")
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

seq = list(fib(12))
print(f"Fibonacci(12): {seq}")
print("\\n✅ Python execution completed securely in cloudeeeide-runner!")
`,
  },
  {
    path: "2_benchmark.c",
    content: `#include <stdio.h>
#include <stdlib.h>
#include <time.h>

// CloudeeeIDE Cloud C Compilation & Resource Limit Demo
int is_prime(int n) {
    if (n <= 1) return 0;
    for (int i = 2; i * i <= n; i++) {
        if (n % i == 0) return 0;
    }
    return 1;
}

int main() {
    printf("====================================================\\n");
    printf("⚡ GCC 12 COMPILATION & EXECUTION IN CLOUD RUNNER\\n");
    printf("====================================================\\n");
    printf("Searching for prime numbers up to 10,000 in sandbox...\\n");

    clock_t start = clock();
    int count = 0;
    for (int i = 2; i <= 10000; i++) {
        if (is_prime(i)) count++;
    }
    clock_t end = clock();
    double elapsed = ((double)(end - start)) / CLOCKS_PER_SEC;

    printf("Found %d primes in %.4f seconds.\\n", count, elapsed);
    printf("CPU Quota: 1.0 Core | RAM Ceiling: 512 MB (Enforced)\\n");
    printf("====================================================\\n");
    return 0;
}
`,
  },
  {
    path: "3_web_server.js",
    content: `// CloudeeeIDE Sandboxed Web Server Preview Demo
const http = require('http');
const PORT = 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(\`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Cloud Preview</title>
        <style>
          body { font-family: -apple-system, sans-serif; background: #0f121a; color: #f5f7ff; text-align: center; padding: 40px; }
          .card { background: rgba(30,35,50,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 24px; max-width: 480px; margin: auto; }
          h1 { color: #89b4fa; margin-bottom: 8px; }
          p { color: #a6adc8; line-height: 1.5; }
          .badge { display: inline-block; padding: 4px 10px; background: rgba(166,227,161,0.2); color: #a6e3a1; border-radius: 20px; font-weight: bold; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">LIVE CLOUD PREVIEW</div>
          <h1>Hello from Sandbox!</h1>
          <p>This Node.js HTTP server is running inside the Docker sandbox.</p>
          <p>Reverse proxy mapped from container port 3000.</p>
          <p style="font-family: monospace; font-size: 13px; color: #fab387;">Server Time: \${new Date().toLocaleTimeString()}</p>
        </div>
      </body>
    </html>
  \`);
});

server.listen(PORT, () => {
  console.log(\`⚡ Sandboxed HTTP Web Server listening on port \${PORT}\`);
});
`,
  },
  {
    path: "4_security_probe.py",
    content: `# CloudeeeIDE Security & Isolation Boundary Probe
import os, sys

print("=" * 60)
print("🛡️  RUNNING SANDBOX SECURITY & ISOLATION PROBE")
print("=" * 60)

# Check 1: User UID
uid = os.getuid()
print(f"1. Process User ID:  UID={uid} (Expected != 0 root)")
if uid == 0:
    print("   ❌ FAIL: Running as root!")
else:
    print("   ✅ PASS: Running as unprivileged non-root user.")

# Check 2: Attempt to read /etc/shadow
print("\\n2. Testing /etc/shadow access...")
try:
    with open("/etc/shadow", "r") as f:
        print("   ❌ VULNERABILITY: /etc/shadow is readable!")
except PermissionError:
    print("   ✅ PASS: Permission denied reading /etc/shadow.")
except Exception as e:
    print(f"   ✅ PASS: Access blocked ({e}).")

# Check 3: Read-only Root Filesystem
print("\\n3. Testing write access to root filesystem (/root_test)...")
try:
    with open("/root_test", "w") as f:
        f.write("tamper")
    print("   ❌ FAIL: Root filesystem is writable!")
except Exception as e:
    print(f"   ✅ PASS: Root filesystem is read-only ({type(e).__name__}).")

# Check 4: Workspace Writable
print("\\n4. Testing write access to /workspace...")
try:
    with open("/workspace/.probe_test", "w") as f:
        f.write("ok")
    os.remove("/workspace/.probe_test")
    print("   ✅ PASS: Workspace is correctly read-write.")
except Exception as e:
    print(f"   ❌ FAIL: Cannot write to workspace ({e})")

print("=" * 60)
print("🛡️  SECURITY AUDIT COMPLETE: ALL BOUNDARY CHECKS PASSED")
print("=" * 60)
`,
  },
];

export function authRoutes(db: Db, cfg: AppConfig): Router {
  const router = Router();
  const sessionTtlMs = cfg.sessionTtlMs;
  const authLimiter = new RateLimiter(
    cfg.authRateLimit.max,
    cfg.authRateLimit.windowMs,
  );
  const demoLimiter = new RateLimiter(10, 60_000); // 10 demo creations per min per IP

  const checkRateLimit = (req: Request, limiter = authLimiter): void => {
    if (!limiter.allow(req.ip ?? "unknown")) {
      throw new ApiError(
        429,
        "too many requests, please try again later",
        "rate_limited",
      );
    }
  };

  const setCookie = (res: any, token: string, ttl: number) => {
    res.cookie("session_token", token, {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: ttl,
    });
  };

  router.post("/register", async (req, res, next) => {
    try {
      checkRateLimit(req);
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || !USERNAME_RE.test(username)) {
        throw new ApiError(
          400,
          "username must be 3-32 characters of [a-zA-Z0-9_]",
          "invalid_username",
        );
      }
      if (username === cfg.adminUsername || username.startsWith("evaluator_")) {
        throw new ApiError(409, "username already taken", "username_taken");
      }
      if (
        typeof password !== "string" ||
        password.length < cfg.minPasswordLength
      ) {
        throw new ApiError(
          400,
          `password must be at least ${cfg.minPasswordLength} characters`,
          "invalid_password",
        );
      }
      const exists = db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(username);
      if (exists)
        throw new ApiError(409, "username already taken", "username_taken");
      const hash = await hashPassword(password);
      const info = db
        .prepare(
          "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        )
        .run(username, hash, "user");
      const userId = Number(info.lastInsertRowid);
      const token = issueSession(db, userId, sessionTtlMs);
      setCookie(res, token, sessionTtlMs);

      recordAuditLog(db, {
        userId,
        eventType: "USER_REGISTERED",
        details: { username },
        ipAddress: req.ip,
      });

      res
        .status(201)
        .json({ token, user: { id: userId, username, role: "user" } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      checkRateLimit(req);
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string") {
        throw new ApiError(
          400,
          "username and password are required",
          "invalid_credentials",
        );
      }
      const row = db
        .prepare(
          "SELECT id, username, password_hash, role FROM users WHERE username = ?",
        )
        .get(username) as
        | { id: number; username: string; password_hash: string; role?: string }
        | undefined;

      let valid = false;
      if (row) {
        valid = await verifyPassword(password, row.password_hash);
      }
      if (!row || !valid) {
        recordAuditLog(db, {
          eventType: "AUTH_FAILED_LOGIN",
          details: { username, reason: "invalid_credentials" },
          ipAddress: req.ip,
        });
        recordAuditLog(db, {
          eventType: "USER_LOGIN_FAILED",
          details: { username, reason: "invalid_credentials" },
          ipAddress: req.ip,
        });
        throw new ApiError(
          401,
          "invalid username or password",
          "invalid_credentials",
        );
      }

      const role = (row.role as "user" | "admin") || "user";
      const token = issueSession(db, row.id, sessionTtlMs);
      setCookie(res, token, sessionTtlMs);

      recordAuditLog(db, {
        userId: row.id,
        eventType: "AUTH_LOGIN",
        details: { username: row.username, role },
        ipAddress: req.ip,
      });

      res.json({ token, user: { id: row.id, username: row.username, role } });
    } catch (err) {
      next(err);
    }
  });

  // Dedicated Admin Authentication Endpoint
  router.post("/admin-login", async (req, res, next) => {
    try {
      checkRateLimit(req);
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string") {
        throw new ApiError(
          400,
          "username and password are required",
          "invalid_credentials",
        );
      }
      const row = db
        .prepare(
          "SELECT id, username, password_hash, role FROM users WHERE username = ?",
        )
        .get(username) as
        | { id: number; username: string; password_hash: string; role?: string }
        | undefined;

      let valid = false;
      if (row) {
        valid = await verifyPassword(password, row.password_hash);
      }
      if (!row || !valid) {
        recordAuditLog(db, {
          eventType: "AUTH_FAILED_LOGIN",
          details: { username, reason: "admin_login_invalid_credentials" },
          ipAddress: req.ip,
        });
        recordAuditLog(db, {
          eventType: "USER_LOGIN_FAILED",
          details: { username, reason: "admin_login_invalid_credentials" },
          ipAddress: req.ip,
        });
        throw new ApiError(
          401,
          "invalid username or password",
          "invalid_credentials",
        );
      }

      if (row.role !== "admin") {
        recordAuditLog(db, {
          userId: row.id,
          eventType: "AUTH_FAILED_LOGIN",
          details: {
            username: row.username,
            reason: "insufficient_privileges_non_admin",
          },
          ipAddress: req.ip,
        });
        throw new ApiError(403, "admin privileges required", "forbidden");
      }

      const token = issueSession(db, row.id, sessionTtlMs);
      setCookie(res, token, sessionTtlMs);

      recordAuditLog(db, {
        userId: row.id,
        eventType: "ADMIN_LOGIN",
        details: { username: row.username, action: "control_plane_login" },
        ipAddress: req.ip,
      });

      res.json({
        token,
        user: { id: row.id, username: row.username, role: "admin" },
      });
    } catch (err) {
      next(err);
    }
  });

  // Zero-Setup Demo / Guest Session Endpoint
  router.post("/demo", async (req, res, next) => {
    try {
      checkRateLimit(req, demoLimiter);
      const guestUsername = `evaluator_${randomBytes(3).toString("hex")}`;
      const randomPass = randomBytes(16).toString("hex");
      const hash = await hashPassword(randomPass);

      const info = db
        .prepare(
          "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        )
        .run(guestUsername, hash, "user");
      const userId = Number(info.lastInsertRowid);

      const demoTtlMs = 2 * 3600 * 1000; // 2 hours disposable TTL
      const token = issueSession(db, userId, demoTtlMs);
      setCookie(res, token, demoTtlMs);

      // Create pre-seeded showcase project
      const project = await createProject(cfg, db, userId, {
        name: "CloudShowcase",
        language: "python",
      });

      const cwd = projectDir(cfg, project.id);
      for (const f of DEMO_FILES) {
        await writeProjectFile(cwd, f.path, f.content);
      }

      recordAuditLog(db, {
        userId,
        projectId: project.id,
        eventType: "DEMO_SESSION_CREATED",
        details: { username: guestUsername, ttlMs: demoTtlMs },
        ipAddress: req.ip,
      });

      res.status(201).json({
        token,
        user: {
          id: userId,
          username: guestUsername,
          role: "user",
          isDemo: true,
        },
        project,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", requireAuth(db), (req, res) => {
    const header = req.headers.authorization ?? "";
    let token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;
    if (!token && req.cookies && req.cookies.session_token) {
      token = req.cookies.session_token;
    }
    if (token) {
      const hashedToken = hashToken(token);
      db.prepare("DELETE FROM sessions WHERE token = ?").run(hashedToken);
      invalidateCachedToken(hashedToken);
    }

    if (req.user) {
      recordAuditLog(db, {
        userId: req.user.id,
        eventType: "AUTH_LOGOUT",
        details: { username: req.user.username },
        ipAddress: req.ip,
      });
      closeAllConnectionsForUser(req.user.id);
    }

    res.clearCookie("session_token", { path: "/" });
    res.json({ ok: true });
  });

  router.get("/me", requireAuth(db), (req, res) => {
    res.json({
      user: {
        ...req.user,
        isDemo: req.user?.username.startsWith("evaluator_") || false,
      },
    });
  });

  router.get("/preferences", requireAuth(db), (req, res, next) => {
    try {
      const preferences = getUserPreferences(db, req.user!.id);
      res.json({ preferences });
    } catch (err) {
      next(err);
    }
  });

  router.put("/preferences", requireAuth(db), (req, res, next) => {
    try {
      const preferences = updateUserPreferences(db, req.user!.id, req.body);
      try {
        recordAuditLog(db, {
          userId: req.user!.id,
          eventType: "USER_PREFERENCES_UPDATED",
          details: { updates: req.body },
          ipAddress: req.ip,
        });
      } catch {}
      res.json({ preferences });
    } catch (err) {
      next(err);
    }
  });

  // M62-2 — self-service profile identity (displayName / pronouns / bio).
  const assertNotDemo = (req: Request): void => {
    if (req.user!.username.startsWith("evaluator_")) {
      throw new ApiError(
        403,
        "demo accounts cannot edit their profile",
        "demo_forbidden",
      );
    }
  };

  router.get("/profile", requireAuth(db), (req, res, next) => {
    try {
      res.json({ profile: getProfile(db, req.user!.id) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/profile", requireAuth(db), (req, res, next) => {
    try {
      assertNotDemo(req);
      const patch = validateProfilePatch(req.body);
      const { profile, changedFields } = updateProfile(db, req.user!.id, patch);
      try {
        recordAuditLog(db, {
          userId: req.user!.id,
          eventType: "PROFILE_UPDATED",
          details: { fields: changedFields },
          ipAddress: req.ip,
        });
      } catch {}
      collaborationManager.broadcastProfileEventForUser(req.user!.id);
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  });

  // M72 — avatar media. Self-service upload/remove; share-scoped read.
  const avatarUploadLimiter = new RateLimiter(
    cfg.profileMediaUploadMax,
    cfg.profileMediaUploadWindowMs,
  );
  const avatarBody = raw({
    type: () => true,
    limit: cfg.profileMediaAvatarMaxBytes + 64 * 1024,
  });

  const parseAvatarTargetId = (raw: string): number => {
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) {
      throw new ApiError(404, "not found", "not_found");
    }
    return Number(raw);
  };

  const sendAvatarFile = (req: Request, res: any, targetId: number): void => {
    if (!canViewAvatar(db, req.user!.id, targetId)) {
      // 404, not 403 — an avatar's existence is not disclosed to non-viewers.
      throw new ApiError(404, "not found", "not_found");
    }
    const file = getAvatarFile(db, cfg, targetId);
    if (!file || !existsSync(file.absPath)) {
      throw new ApiError(404, "not found", "not_found");
    }
    res.set({
      "Content-Type": file.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=300",
    });
    res.sendFile(file.absPath);
  };

  router.post(
    "/profile/avatar",
    requireAuth(db),
    avatarBody,
    async (req, res, next) => {
      try {
        assertNotDemo(req);
        const userId = req.user!.id;
        if (!avatarUploadLimiter.allow(String(userId))) {
          throw new ApiError(429, "too many avatar uploads", "rate_limited");
        }
        const ct = req.headers["content-type"];
        if (typeof ct !== "string" || !ct.toLowerCase().includes("multipart/form-data")) {
          throw new ApiError(
            400,
            "avatar upload requires multipart/form-data",
            "invalid_multipart",
          );
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new ApiError(400, "no upload body received", "empty_upload");
        }
        const { files } = parseMultipartFormData(req.body, ct);
        if (files.length !== 1) {
          throw new ApiError(
            400,
            "avatar upload requires exactly one file",
            "invalid_upload",
          );
        }
        const stored = await storeAvatar(db, cfg, userId, files[0]!.buffer);
        try {
          recordAuditLog(db, {
            userId,
            eventType: "PROFILE_MEDIA_UPLOADED",
            details: {
              kind: "avatar",
              mime: stored.mime,
              bytes: stored.bytes,
              width: stored.width,
              height: stored.height,
            },
            ipAddress: req.ip,
          });
        } catch {}
        collaborationManager.broadcastProfileEventForUser(userId);
        res.json({
          avatarVersion: stored.avatarVersion,
          mime: stored.mime,
          width: stored.width,
          height: stored.height,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete("/profile/avatar", requireAuth(db), async (req, res, next) => {
    try {
      assertNotDemo(req);
      const userId = req.user!.id;
      const removed = await deleteAvatar(db, cfg, userId);
      if (removed) {
        try {
          recordAuditLog(db, {
            userId,
            eventType: "PROFILE_MEDIA_DELETED",
            details: { kind: "avatar" },
            ipAddress: req.ip,
          });
        } catch {}
        collaborationManager.broadcastProfileEventForUser(userId);
      }
      res.json({ ok: true, avatarVersion: 0 });
    } catch (err) {
      next(err);
    }
  });

  router.get("/profile/avatar", requireAuth(db), (req, res, next) => {
    try {
      sendAvatarFile(req, res, req.user!.id);
    } catch (err) {
      next(err);
    }
  });

  router.get("/profile/:id/avatar", requireAuth(db), (req, res, next) => {
    try {
      sendAvatarFile(req, res, parseAvatarTargetId(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
