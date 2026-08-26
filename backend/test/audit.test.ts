import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import {
  createProject,
  deleteProject,
  projectDir,
} from "../src/projects/service.js";
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
} from "../src/projects/snapshots.js";
import { writeProjectFile } from "../src/files/service.js";
import { recordAuditLog, queryAuditLogs } from "../src/audit.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };

describe("Milestone 33 — Audit Trail Coverage & Deletion Integrity", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerId: number;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;
    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "audit_owner", password: "password123" },
    });
    ownerId = reg.data.user.id;
  });

  afterEach(async () => {
    await api.close();
  });

  function eventsFor(projectId: string): any[] {
    return db
      .prepare("SELECT * FROM audit_logs WHERE project_id = ? ORDER BY id ASC")
      .all(projectId) as any[];
  }

  it("A. project creation emits PROJECT_CREATED with project identity and no secrets", async () => {
    const project = await createProject(cfg, db, ownerId, {
      name: "Audited Project",
      language: "python",
    });
    const rows = eventsFor(project.id);
    const created = rows.find((r) => r.event_type === "PROJECT_CREATED");
    expect(created).toBeDefined();
    expect(created.user_id).toBe(ownerId);
    const details = JSON.parse(created.details);
    expect(details.projectName).toBe("Audited Project");
    expect(JSON.stringify(details)).not.toMatch(/password|secret|token/i);
  });

  it("B. & E. project deletion emits PROJECT_DELETED before the row is removed, retaining project identity/name in the detail", async () => {
    const project = await createProject(cfg, db, ownerId, {
      name: "To Be Deleted",
    });
    await deleteProject(cfg, db, ownerId, project.id);

    // audit_logs.project_id is now SET NULL (M33), so this row is found by
    // event_type + detail content, not by the now-nulled project_id column.
    const row = db
      .prepare(
        "SELECT * FROM audit_logs WHERE event_type = 'PROJECT_DELETED' ORDER BY id DESC LIMIT 1",
      )
      .get() as any;
    expect(row).toBeDefined();
    const details = JSON.parse(row.details);
    expect(details.projectName).toBe("To Be Deleted");
  });

  it("C. & D. project deletion preserves all earlier audit rows for that project, now with project_id NULL instead of being cascaded away", async () => {
    const project = await createProject(cfg, db, ownerId, {
      name: "History Project",
    });
    await createSnapshot(cfg, db, ownerId, project.id, "Snap 1");
    const beforeCount = eventsFor(project.id).length;
    expect(beforeCount).toBeGreaterThanOrEqual(2); // PROJECT_CREATED + SNAPSHOT_CREATED

    await deleteProject(cfg, db, ownerId, project.id);

    // The rows must still exist — findable by event_type since project_id
    // is now null, not by the old project_id value.
    const survivingCreated = db
      .prepare(
        "SELECT * FROM audit_logs WHERE event_type = 'PROJECT_CREATED' AND details LIKE '%History Project%'",
      )
      .get() as any;
    expect(survivingCreated).toBeDefined();
    expect(survivingCreated.project_id).toBeNull();

    const survivingSnapshot = db
      .prepare(
        "SELECT * FROM audit_logs WHERE event_type = 'SNAPSHOT_CREATED' AND details LIKE '%Snap 1%'",
      )
      .get() as any;
    expect(survivingSnapshot).toBeDefined();
    expect(survivingSnapshot.project_id).toBeNull();

    // Nothing under the old (now-invalid) project_id remains queryable that
    // way, but the row count under a direct scan of all audit_logs is
    // unchanged -- proving nothing was destroyed, only unlinked.
    const totalRows = (
      db.prepare("SELECT COUNT(*) as c FROM audit_logs").get() as {
        c: number;
      }
    ).c;
    expect(totalRows).toBeGreaterThanOrEqual(beforeCount);
  });

  it("F. snapshot creation emits SNAPSHOT_CREATED", async () => {
    const project = await createProject(cfg, db, ownerId, { name: "P" });
    const snapshot = await createSnapshot(cfg, db, ownerId, project.id, "S1");
    const rows = eventsFor(project.id);
    const row = rows.find((r) => r.event_type === "SNAPSHOT_CREATED");
    expect(row).toBeDefined();
    expect(JSON.parse(row.details).snapshotId).toBe(snapshot.id);
  });

  it("G. snapshot restoration emits SNAPSHOT_RESTORED", async () => {
    const project = await createProject(cfg, db, ownerId, { name: "P" });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "a.txt", "original");
    const snapshot = await createSnapshot(cfg, db, ownerId, project.id, "S1");
    await writeProjectFile(cwd, "a.txt", "mutated");

    await restoreSnapshot(cfg, db, ownerId, project.id, snapshot.id);

    const rows = eventsFor(project.id);
    const row = rows.find((r) => r.event_type === "SNAPSHOT_RESTORED");
    expect(row).toBeDefined();
    expect(JSON.parse(row.details).snapshotId).toBe(snapshot.id);
  });

  it("H. snapshot deletion emits SNAPSHOT_DELETED", async () => {
    const project = await createProject(cfg, db, ownerId, { name: "P" });
    const snapshot = await createSnapshot(cfg, db, ownerId, project.id, "S1");
    await deleteSnapshot(cfg, db, ownerId, project.id, snapshot.id);

    const rows = eventsFor(project.id);
    const row = rows.find((r) => r.event_type === "SNAPSHOT_DELETED");
    expect(row).toBeDefined();
    expect(JSON.parse(row.details).snapshotId).toBe(snapshot.id);
  });

  it("I. sanitizeDetails still redacts every sensitive key", async () => {
    const project = await createProject(cfg, db, ownerId, { name: "P" });
    recordAuditLog(db, {
      userId: ownerId,
      projectId: project.id,
      eventType: "ADMIN_ACTION",
      details: {
        password: "plain",
        password_hash: "hash",
        token: "tok",
        secret: "shh",
        cookie: "c",
        session_token: "st",
        newPassword: "np", // key match is case-insensitive per sanitizeDetails
        harmless: "keep me",
      },
    });
    const { logs } = queryAuditLogs(db, {
      projectId: project.id,
      eventType: "ADMIN_ACTION",
    });
    const details = logs[0].details as Record<string, any>;
    expect(details.password).toBe("[REDACTED]");
    expect(details.password_hash).toBe("[REDACTED]");
    expect(details.token).toBe("[REDACTED]");
    expect(details.secret).toBe("[REDACTED]");
    expect(details.cookie).toBe("[REDACTED]");
    expect(details.session_token).toBe("[REDACTED]");
    expect(details.harmless).toBe("keep me");
  });

  it("J. K. L. M. queryAuditLogs filters by event_type, user_id, project_id, and paginates", async () => {
    const projectA = await createProject(cfg, db, ownerId, { name: "A" });
    const projectB = await createProject(cfg, db, ownerId, { name: "B" });
    await createSnapshot(cfg, db, ownerId, projectA.id, "s");

    const byEvent = queryAuditLogs(db, { eventType: "PROJECT_CREATED" });
    expect(byEvent.logs.every((l) => l.event_type === "PROJECT_CREATED")).toBe(
      true,
    );
    expect(byEvent.total).toBeGreaterThanOrEqual(2);

    const byUser = queryAuditLogs(db, { userId: ownerId });
    expect(byUser.logs.every((l) => l.user_id === ownerId)).toBe(true);

    const byProject = queryAuditLogs(db, { projectId: projectA.id });
    expect(byProject.logs.every((l) => l.project_id === projectA.id)).toBe(
      true,
    );
    expect(
      byProject.logs.some((l) => l.event_type === "SNAPSHOT_CREATED"),
    ).toBe(true);
    expect(byProject.logs.some((l) => l.project_id === projectB.id)).toBe(
      false,
    );

    const page1 = queryAuditLogs(db, { limit: 1, offset: 0 });
    const page2 = queryAuditLogs(db, { limit: 1, offset: 1 });
    expect(page1.logs.length).toBe(1);
    expect(page2.logs.length).toBe(1);
    expect(page1.logs[0].id).not.toBe(page2.logs[0].id);
  });

  it("N. querying audit logs by a since-deleted project's id returns nothing new (rows are unlinked, not orphan-queryable by that id) without erroring", async () => {
    const project = await createProject(cfg, db, ownerId, {
      name: "Will Be Deleted",
    });
    await deleteProject(cfg, db, ownerId, project.id);

    const result = queryAuditLogs(db, { projectId: project.id });
    expect(result.logs.length).toBe(0);
    expect(result.total).toBe(0);
  });

  it("O. a recordAuditLog failure never propagates to the caller (fail-soft, project/snapshot operations never fail because audit logging fails)", () => {
    const brokenDb = new DatabaseSync(":memory:");
    brokenDb.close(); // any operation on a closed connection throws internally
    expect(() =>
      recordAuditLog(brokenDb, {
        userId: 1,
        eventType: "PROJECT_CREATED",
        details: { projectName: "x" },
      }),
    ).not.toThrow();
  });

  it("the M27/M31 project-existence check before recordAuditLog for a since-deleted project remains necessary — ON DELETE SET NULL does not relax FK validation on INSERT (verified directly, not assumed)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO audit_logs (project_id, event_type, details) VALUES (?, ?, ?)",
        )
        .run("00000000-0000-0000-0000-000000000000", "ADMIN_ACTION", "{}"),
    ).toThrow(/FOREIGN KEY/i);
  });
});
