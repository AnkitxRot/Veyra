import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * M97 ratchet. Every mutating Express route (POST/PUT/PATCH/DELETE) in these
 * files must record an audit event inside its handler, or be listed in
 * KNOWN_UNAUDITED. New unaudited routes fail this test; when a listed route
 * gains an audit call the test fails until it is removed from the list, so the
 * list can only shrink. Some listed routes are audited in a service layer the
 * static scan cannot see; they are still listed so the debt stays visible.
 */
const ROUTE_FILES = ["admin", "ai", "auth", "comments", "git", "projects", "projectsecrets"];

/**
 * M114: routes whose audit event is emitted in a service module the route
 * scan cannot see. Each entry is verified: the named file must emit the event.
 */
const SERVICE_AUDITED: Record<string, { file: string; event: string }> = {
  'projects POST "/"': { file: "projects/service.ts", event: "PROJECT_CREATED" },
  'projects POST "/from-template"': { file: "projects/service.ts", event: "PROJECT_CREATED" },
  'projects POST "/import"': { file: "projects/archive.ts", event: "PROJECT_IMPORTED" },
  'projects DELETE "/:id"': { file: "projects/service.ts", event: "PROJECT_DELETED" },
  'projects POST "/:id/snapshots"': { file: "projects/snapshots.ts", event: "SNAPSHOT_CREATED" },
  'projects POST "/:id/snapshots/:snapshotId/restore"': {
    file: "projects/snapshots.ts",
    event: "SNAPSHOT_RESTORED",
  },
  'projects DELETE "/:id/snapshots/:snapshotId"': {
    file: "projects/snapshots.ts",
    event: "SNAPSHOT_DELETED",
  },
  'projects POST "/:id/import"': { file: "projects/archive.ts", event: "PROJECT_IMPORTED" },
  'projects POST "/:id/fork"': { file: "projects/fork.ts", event: "PROJECT_FORKED" },
  'projects POST "/:id/upload"': { file: "files/upload.ts", event: "PROJECT_FILES_UPLOADED" },
  'projects POST "/:id/run"': { file: "execution/pipeline.ts", event: "EXECUTION_STARTED" },
  'admin POST "/backups"': { file: "backup/service.ts", event: "DATABASE_BACKUP_CREATED" },
  'admin DELETE "/backups/:filename"': {
    file: "backup/service.ts",
    event: "DATABASE_BACKUP_DELETED",
  },
  'admin POST "/workspace-backups/:projectId"': {
    file: "backup/workspaceBackup.ts",
    event: "WORKSPACE_BACKUP_CREATED",
  },
  'admin DELETE "/workspace-backups/:projectId/:filename"': {
    file: "backup/workspaceBackup.ts",
    event: "WORKSPACE_BACKUP_DELETED",
  },
  'admin POST "/workspace-backups/:projectId/:filename/restore"': {
    file: "backup/workspaceRestore.ts",
    event: "WORKSPACE_BACKUP_RESTORED",
  },
};

/**
 * M115: mutating-looking routes that deliberately emit no audit event, each with
 * the reason. Stale or newly-audited entries fail the test below.
 */
const EXEMPT = new Map<string, string>([
  [
    'ai POST "/:id/ai/verify"',
    "writes its own ai_verifications journal row (the journal is the record)",
  ],
  [
    'comments PUT "/:id/comments/:commentId/reactions/:emoji"',
    "emoji reaction toggle; low-risk derived state",
  ],
  [
    'comments DELETE "/:id/comments/:commentId/reactions/:emoji"',
    "emoji reaction toggle; low-risk derived state",
  ],
  [
    'comments POST "/:id/comments/:threadId/anchor-status"',
    "recomputes anchor drift; no user-authored change",
  ],
  ['projects POST "/:id/collab/while-away/ack"', "per-user read marker; affects only the caller"],
  ['projects POST "/:id/search"', "read-only search sent as POST for body size"],
  [
    'projects POST "/:id/format"',
    "returns formatted text; the client applies it and saving is audited",
  ],
]);

const KNOWN_UNAUDITED = new Set<string>([]);

function scan(): { audited: string[]; unaudited: string[] } {
  const audited: string[] = [];
  const unaudited: string[] = [];
  for (const dir of ROUTE_FILES) {
    // routes.ts plus the `*Routes.ts` group files it delegates to (projects/ is split by feature).
    const srcDir = join(__dirname, "..", "src", dir);
    const routeFiles = readdirSync(srcDir).filter(
      (f) => f === "routes.ts" || /Routes\.ts$/.test(f),
    );
    for (const file of routeFiles) {
      const src = readFileSync(join(srcDir, file), "utf8");
      const mutating = /(?:router|app)\.(post|put|patch|delete)\(\s*(["'`][^"'`]*["'`])/g;
      const any = /(?:router|app)\.(get|post|put|patch|delete)\(/g;
      const starts: number[] = [];
      for (let m; (m = any.exec(src));) starts.push(m.index);
      for (let m; (m = mutating.exec(src));) {
        const next = starts.find((i) => i > m!.index) ?? src.length;
        const body = src.slice(m.index, next);
        const key = `${dir} ${m[1]!.toUpperCase()} ${m[2]}`;
        (/record\w*Audit|recordAudit|audit/i.test(body) ? audited : unaudited).push(key);
      }
    }
  }
  return { audited, unaudited };
}

describe("M97 — audit coverage ratchet for mutating routes", () => {
  it("M115: newly audited routes are detected as audited inline", () => {
    const keys = [
      'projects POST "/:id/move"',
      'projects POST "/:id/delete"',
      'projects POST "/:id/search/replace"',
      'projects POST "/:id/install"',
    ];
    for (const k of keys) expect(scan().audited).toContain(k);
  });

  const { audited, unaudited } = scan();

  it("finds a plausible number of routes (scanner sanity)", () => {
    expect(audited.length + unaudited.length).toBeGreaterThan(50);
  });

  it("no new mutating route is missing an audit event", () => {
    const fresh = unaudited.filter(
      (k) => !KNOWN_UNAUDITED.has(k) && !(k in SERVICE_AUDITED) && !EXEMPT.has(k),
    );
    expect(fresh, "add recordAuditLog to these routes").toEqual([]);
  });

  it("KNOWN_UNAUDITED has no stale entries", () => {
    const stale = [...KNOWN_UNAUDITED].filter((k) => !unaudited.includes(k));
    expect(stale, "remove these from KNOWN_UNAUDITED").toEqual([]);
  });
});

/**
 * M113 — WS handler ratchet. Each WS handler module that accepts client
 * messages must record an audit event itself, or delegate to a named service
 * module that does. Adding a new `ws/*.ts` handler without choosing one fails.
 * `index.ts` only routes upgrades to these handlers.
 */
describe("M113 — audit coverage for WS handlers", () => {
  const wsDir = join(__dirname, "..", "src", "ws");
  // handler file -> service module (relative to src/) that audits on its behalf
  const DELEGATED: Record<string, string> = { "execution.ts": "execution/pipeline.ts" };
  const ROUTER_ONLY = new Set(["index.ts"]);
  const handlers = readdirSync(wsDir).filter(
    (f) =>
      f.endsWith(".ts") &&
      !ROUTER_ONLY.has(f) &&
      /\.on\(\s*["']message["']/.test(readFileSync(join(wsDir, f), "utf8")),
  );

  it("finds the known handlers (scanner sanity)", () => {
    expect(handlers).toEqual(expect.arrayContaining(["execution.ts", "terminal.ts"]));
  });

  it.each(handlers)("%s audits directly or via its delegate", (file) => {
    const src = readFileSync(join(wsDir, file), "utf8");
    if (/recordAuditLog\(/.test(src)) return;
    const delegate = DELEGATED[file];
    expect(delegate, `${file} has no audit call and no DELEGATED entry`).toBeDefined();
    const delegateSrc = readFileSync(join(__dirname, "..", "src", delegate!), "utf8");
    expect(delegateSrc).toMatch(/recordAuditLog\(/);
    expect(src, `${file} must import its delegate`).toContain(
      delegate!.replace(/\.ts$/, ".js").replace(/^/, "../"),
    );
  });
});

describe("M114: service-audited routes", () => {
  const { unaudited } = scan();

  it.each(Object.entries(SERVICE_AUDITED))(
    "%s is audited in its service",
    (_route, { file, event }) => {
      const src = readFileSync(join(__dirname, "..", "src", file), "utf8");
      expect(src).toMatch(new RegExp(`eventType:\\s*"${event}"`));
    },
  );

  it("every SERVICE_AUDITED route still exists in the scan", () => {
    const missing = Object.keys(SERVICE_AUDITED).filter((k) => !unaudited.includes(k));
    expect(missing, "route removed or now audited inline; drop from SERVICE_AUDITED").toEqual([]);
  });
});

describe("M115: exemptions", () => {
  const { unaudited } = scan();

  it("every EXEMPT route still exists and is still unaudited", () => {
    const stale = [...EXEMPT.keys()].filter((k) => !unaudited.includes(k));
    expect(stale, "route removed or now audited; drop from EXEMPT").toEqual([]);
  });

  it("KNOWN_UNAUDITED is empty: new gaps must be fixed or exempted with a reason", () => {
    expect([...KNOWN_UNAUDITED]).toEqual([]);
  });
});
