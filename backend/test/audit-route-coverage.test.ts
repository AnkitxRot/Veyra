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

const KNOWN_UNAUDITED = new Set<string>([
  'admin POST "/backups"',
  'admin DELETE "/backups/:filename"',
  'admin POST "/workspace-backups/:projectId"',
  'admin DELETE "/workspace-backups/:projectId/:filename"',
  'admin POST "/workspace-backups/:projectId/:filename/restore"',
  'ai POST "/:id/ai/action"',
  'ai POST "/:id/ai/apply-patch"',
  'ai POST "/:id/ai/verify"',
  'comments POST "/:id/comments/:threadId/replies"',
  'comments PATCH "/:id/comments/:commentId"',
  'comments DELETE "/:id/comments/:commentId"',
  'comments POST "/:id/comments/:threadId/reopen"',
  'comments PUT "/:id/comments/:commentId/reactions/:emoji"',
  'comments DELETE "/:id/comments/:commentId/reactions/:emoji"',
  'comments POST "/:id/comments/:threadId/anchor-status"',
  'projects POST "/"',
  'projects POST "/from-template"',
  'projects POST "/import"',
  'projects DELETE "/:id"',
  'projects POST "/:id/collab/while-away/ack"',
  'projects POST "/:id/snapshots"',
  'projects POST "/:id/snapshots/:snapshotId/restore"',
  'projects DELETE "/:id/snapshots/:snapshotId"',
  'projects POST "/:id/import"',
  'projects POST "/:id/fork"',
  'projects POST "/:id/upload"',
  'projects POST "/:id/move"',
  'projects POST "/:id/delete"',
  'projects POST "/:id/search"',
  'projects POST "/:id/search/replace"',
  'projects POST "/:id/format"',
  'projects POST "/:id/run"',
  'projects POST "/:id/install"',
]);

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
  const { audited, unaudited } = scan();

  it("finds a plausible number of routes (scanner sanity)", () => {
    expect(audited.length + unaudited.length).toBeGreaterThan(50);
  });

  it("no new mutating route is missing an audit event", () => {
    const fresh = unaudited.filter((k) => !KNOWN_UNAUDITED.has(k));
    expect(fresh, "add recordAuditLog to these routes").toEqual([]);
  });

  it("KNOWN_UNAUDITED has no stale entries", () => {
    const stale = [...KNOWN_UNAUDITED].filter((k) => !unaudited.includes(k));
    expect(stale, "remove these from KNOWN_UNAUDITED").toEqual([]);
  });
});
