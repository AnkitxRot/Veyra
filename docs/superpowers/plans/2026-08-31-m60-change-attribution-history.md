# M60 — Change Attribution & Collaboration History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every collaborator a deterministic, metadata-only history of
what changed, who changed it, and what happened while they were away — surfaced
as a live "last change" line, a Team Activity timeline inside TeamPanel, and a
dismissible "While You Were Away" card on reconnect.

**Architecture:** A new backend `CollaborationHistorian` singleton (mirroring
the existing `TelemetryHistorian`) accumulates authenticated edit *bursts* in
memory off the Yjs `afterTransaction` hook, batches them to a new
`collaboration_changes` SQLite table, and broadcasts each closed burst over one
new receive-only `MESSAGE_CUSTOM` wire event. A read-side `timeline` module
unions that table with the already-persisted `runs` and `audit_logs` (Git
commits, snapshots) into one ordered, paginated `TimelineEvent[]` behind
`requireProjectAccess(…, "viewer")`. The frontend renders it in TeamPanel and a
reconnect card, navigating via the existing `openAndRevealLocation` primitive.

**Tech Stack:** TypeScript, `node:sqlite` `DatabaseSync` (synchronous), Yjs
13.6.32, `y-protocols` 1.0.7, Express, `ws`, React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-m60-change-attribution-history-design.md`
— read it in full before starting. Every task below argues from a section of it.

## Global Constraints

- **No LLM anywhere.** Burst grouping, counts, ranges, ordering are all deterministic.
- **Metadata only.** Never persist file content, diffs, Yjs updates/snapshots, cursor/selection/keystroke history, terminal contents, stdout, stderr, env vars, secrets, IPs, awareness frames, or any raw client payload. `detail` JSON is built field-by-field on the server, never `JSON.stringify(clientPayload)`. (Spec §7.)
- **`afterTransaction` is authoritative for author + file-level change existence.** Range enrichment via `Y.Text.observe` is best-effort; any ambiguity ⇒ `line_range = NULL`, event still valid. Never fabricate a range. Never build a second attribution mechanism. (Spec §3, §5.)
- **Author identity is always `this.clients.get(tr.origin).userId`** — the authenticated WS session (M55-forced). Never a client-asserted value, never a `clientId`. String origins (`"initial_disk_load"`, `"external_mutation"`) and `null` are excluded. (Spec §3.1, §12.)
- **No DB write on the typing hot path.** `afterTransaction` does zero I/O — pure in-memory routing. Writes are batched every `COLLAB_HISTORY_FLUSH_INTERVAL_MS` (5000) / at queue ≥ 100 / on `stop()`. (Spec §6.1, §12, §20.)
- **All reads server-authorized** via `requireProjectAccess(db, callerUserId, projectId, "viewer")`. No frontend-only filtering. Every source query has `WHERE project_id = ?` first, indexed. Explicit safe column projections — never `SELECT *` from `runs`/`audit_logs`. (Spec §7.3, §9.4, §12.)
- **Receive-only wire event.** The client has no code path that *sends* `collab_change`. Only `CollaborationHistorian` → `CollaborationManager.broadcastCollabChange` emits it. (Spec §8.1.)
- **Config pattern** (backend/src/config.ts): `overrides.X ?? Number(process.env.X ?? default)`.
- **Migration pattern** (backend/src/db.ts): append `{ version: 11, description, up }` to `MIGRATIONS[]` AND mirror the `CREATE TABLE IF NOT EXISTS` in `openDb()`'s inline SQL. Transactional, idempotent.
- **Frontend/backend types are hand-synced** — there is no shared cross-package module. `TimelineEvent` lives in both `backend/src/collab/timeline.ts` and `frontend/src/types.ts`; keep them identical.
- **Do not commit** unless the executor is explicitly told to. Do not start M61.
- **Regression gates** must stay green every task: `m57-presence`, `m58-attention`, M59 `collab.focus*` / `Editor.viewstate` / `collab.follow`, `Editor.eol`, `collab-initialization`, external-mutation conflict tests, `m4-collab`, run-status, git, snapshot; full backend + frontend suites; both typechecks; both lints; frontend build.

---

## File Structure

### Backend — new
| File | Responsibility |
|---|---|
| `backend/src/collab/changeAttribution.ts` | **Pure.** Burst state machine: open/extend/close decisions, range folding, burst summary. No `db`, no `Y.*` runtime imports (types only), no timers. |
| `backend/src/collab/historian.ts` | `CollaborationHistorian` singleton. In-memory open-burst map + write queue → batched SQLite → retention purge → live-broadcast callback → lifecycle (`stop`, `disposeProject`, `closeProjectBursts`, `closeAuthorBursts`). |
| `backend/src/collab/timeline.ts` | **Read-side.** `TimelineEvent` type + `queryTimeline` + `queryWhileAway` — union of `collaboration_changes` + `runs` + `audit_logs` with explicit safe columns, deterministic ordering, stable pagination. |
| `backend/src/collab/lastSeen.ts` | `collab_last_seen` upsert/read helpers: `touchLastSeen`, `getLastSeen`, `insertLastSeenIfAbsent`. |

### Backend — modified
| File | Change |
|---|---|
| `backend/src/db.ts` | Migration v11 + inline schema for `collaboration_changes`, `collab_last_seen`. |
| `backend/src/config.ts` | 11 config knobs (spec §14). |
| `backend/src/collab/manager.ts` | `afterTransaction` attribution hook; idempotent `Y.Text.observe` in `ensureFileLoaded`; `broadcastCollabChange` (room + manager); burst-close calls in `removeClient`/`flushToDisk`/`flushBeforeDestructiveDispose`/`dispose`; callout capture in `handleAttentionMessage`. |
| `backend/src/ws/index.ts` | `insertLastSeenIfAbsent` on collab `addClient`. |
| `backend/src/projects/routes.ts` | `GET /:id/collab/timeline`, `GET /:id/collab/while-away`, `POST /:id/collab/while-away/ack`. |
| `backend/src/index.ts` | `collaborationHistorian.init(db, cfg)` on startup; `collaborationHistorian.stop()` in `performGracefulShutdown` step 0. |
| `backend/src/projects/service.ts`, `backend/src/backup/workspaceRestore.ts` | `collaborationHistorian.disposeProject(projectId)` beside each `telemetryHistorian.disposeProject` call. |

### Frontend — new
| File | Responsibility |
|---|---|
| `frontend/src/collab/timeline.ts` | **Pure.** `formatTimelineEvent`, `groupWhileAway`, `mergeTimeline` (de-dupe by id, sort, cap). No React. |
| `frontend/src/components/Collab/ActivityTimeline.tsx` | Team Activity section rendered inside TeamPanel. |
| `frontend/src/components/Collab/WhileYouWereAway.tsx` | Dismissible reconnect card. |

### Frontend — modified
| File | Change |
|---|---|
| `frontend/src/collab/client.ts` | `collab_change` receive branch + `emit`; `disconnectedAt` + `reconnected_after_gap` emit. |
| `frontend/src/types.ts` | `TimelineEvent` (hand-synced with backend). |
| `frontend/src/api.ts` | `fetchCollabTimeline`, `fetchWhileAway`, `ackWhileAway`. |
| `frontend/src/components/IDE/IDE.tsx` | `timeline` state; `collab_change` + `reconnected_after_gap` listeners; initial fetch on first TeamPanel open; `lastChangeByUser` memo; `<WhileYouWereAway>` mount; prop wiring. |
| `frontend/src/components/Collab/TeamPanel.tsx` | `<ActivityTimeline>` section. |
| `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` | "Last change:" line in the popover. |
| `frontend/src/styles/collab.css` | timeline + while-away styles. |

---

## Task 1: Schema migration v11 + config knobs

**Files:**
- Modify: `backend/src/db.ts` (inline `openDb` SQL + `MIGRATIONS[]`)
- Modify: `backend/src/config.ts` (`AppConfig` interface + `resolveConfig`)
- Test: `backend/test/m60-schema.test.ts`

**Interfaces:**
- Produces: tables `collaboration_changes`, `collab_last_seen` (spec §6). Config keys: `collabBurstIdleMs`, `collabBurstMaxMs`, `collabBurstSweepMs`, `collabHistoryFlushIntervalMs`, `collabHistoryRetentionDays`, `collabHistoryMaxPerProject`, `collabAwayThresholdMs`, `collabAwayMaxLookbackMs`, `collabAwayMaxEvents`, `collabAwayNoticeMs`, `collabOpenBurstsMax` (all `number`).

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/m60-schema.test.ts
import { describe, it, expect } from "vitest";
import { openDb, getSchemaVersion } from "../src/db.js";
import { resolveConfig } from "../src/config.js";

describe("M60 schema + config", () => {
  it("creates collaboration_changes and collab_last_seen at v11", () => {
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(11);
    const cols = (db.prepare("PRAGMA table_info(collaboration_changes)").all() as any[])
      .map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining([
      "id", "project_id", "author_user_id", "file_path", "kind",
      "started_at", "ended_at", "update_count", "lines_added",
      "lines_removed", "start_line", "end_line", "detail", "created_at",
    ]));
    const ls = (db.prepare("PRAGMA table_info(collab_last_seen)").all() as any[])
      .map((r) => r.name);
    expect(ls).toEqual(expect.arrayContaining(["project_id", "user_id", "last_seen_at"]));
    // FK cascade present
    const fks = db.prepare("PRAGMA foreign_key_list(collaboration_changes)").all() as any[];
    expect(fks.find((f) => f.from === "project_id")?.on_delete).toBe("CASCADE");
  });

  it("exposes M60 config knobs with defaults", () => {
    const cfg = resolveConfig();
    expect(cfg.collabBurstIdleMs).toBe(15000);
    expect(cfg.collabBurstMaxMs).toBe(300000);
    expect(cfg.collabHistoryRetentionDays).toBe(14);
    expect(cfg.collabHistoryMaxPerProject).toBe(2000);
    expect(cfg.collabAwayThresholdMs).toBe(180000);
    expect(cfg.collabAwayMaxLookbackMs).toBe(86400000);
    expect(cfg.collabOpenBurstsMax).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (`no such table` / `undefined`)

Run: `cd backend && npx vitest run test/m60-schema.test.ts`

- [ ] **Step 3: Add the migration + inline schema**

In `backend/src/db.ts`, add to the `openDb` inline SQL block (after the `secrets` indexes):

```sql
    CREATE TABLE IF NOT EXISTS collaboration_changes (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path      TEXT NOT NULL,
      kind           TEXT NOT NULL DEFAULT 'edit_burst',
      started_at     TEXT NOT NULL,
      ended_at       TEXT NOT NULL,
      update_count   INTEGER NOT NULL DEFAULT 0,
      lines_added    INTEGER NOT NULL DEFAULT 0,
      lines_removed  INTEGER NOT NULL DEFAULT 0,
      start_line     INTEGER,
      end_line       INTEGER,
      detail         TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_collab_changes_project_ended
      ON collaboration_changes(project_id, ended_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS collab_last_seen (
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
```

Append to `MIGRATIONS[]`:

```ts
  {
    version: 11,
    description:
      "M60: collaboration_changes + collab_last_seen for change attribution & history",
    up(db: Db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS collaboration_changes (
          id             TEXT PRIMARY KEY,
          project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          file_path      TEXT NOT NULL,
          kind           TEXT NOT NULL DEFAULT 'edit_burst',
          started_at     TEXT NOT NULL,
          ended_at       TEXT NOT NULL,
          update_count   INTEGER NOT NULL DEFAULT 0,
          lines_added    INTEGER NOT NULL DEFAULT 0,
          lines_removed  INTEGER NOT NULL DEFAULT 0,
          start_line     INTEGER,
          end_line       INTEGER,
          detail         TEXT,
          created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_collab_changes_project_ended
          ON collaboration_changes(project_id, ended_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS collab_last_seen (
          project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        );
      `);
    },
  },
```

- [ ] **Step 4: Add config knobs**

In `backend/src/config.ts` `AppConfig` interface (near `collabLowWatermarkBytes`):

```ts
  collabBurstIdleMs: number;
  collabBurstMaxMs: number;
  collabBurstSweepMs: number;
  collabHistoryFlushIntervalMs: number;
  collabHistoryRetentionDays: number;
  collabHistoryMaxPerProject: number;
  collabAwayThresholdMs: number;
  collabAwayMaxLookbackMs: number;
  collabAwayMaxEvents: number;
  collabAwayNoticeMs: number;
  collabOpenBurstsMax: number;
```

In `resolveConfig` return object (near `collabLowWatermarkBytes`):

```ts
    collabBurstIdleMs:
      overrides.collabBurstIdleMs ?? Number(process.env.COLLAB_BURST_IDLE_MS ?? 15000),
    collabBurstMaxMs:
      overrides.collabBurstMaxMs ?? Number(process.env.COLLAB_BURST_MAX_MS ?? 300000),
    collabBurstSweepMs:
      overrides.collabBurstSweepMs ?? Number(process.env.COLLAB_BURST_SWEEP_MS ?? 5000),
    collabHistoryFlushIntervalMs:
      overrides.collabHistoryFlushIntervalMs ??
      Number(process.env.COLLAB_HISTORY_FLUSH_INTERVAL_MS ?? 5000),
    collabHistoryRetentionDays:
      overrides.collabHistoryRetentionDays ??
      Number(process.env.COLLAB_HISTORY_RETENTION_DAYS ?? 14),
    collabHistoryMaxPerProject:
      overrides.collabHistoryMaxPerProject ??
      Number(process.env.COLLAB_HISTORY_MAX_PER_PROJECT ?? 2000),
    collabAwayThresholdMs:
      overrides.collabAwayThresholdMs ??
      Number(process.env.COLLAB_AWAY_THRESHOLD_MS ?? 180000),
    collabAwayMaxLookbackMs:
      overrides.collabAwayMaxLookbackMs ??
      Number(process.env.COLLAB_AWAY_MAX_LOOKBACK_MS ?? 86400000),
    collabAwayMaxEvents:
      overrides.collabAwayMaxEvents ?? Number(process.env.COLLAB_AWAY_MAX_EVENTS ?? 50),
    collabAwayNoticeMs:
      overrides.collabAwayNoticeMs ?? Number(process.env.COLLAB_AWAY_NOTICE_MS ?? 20000),
    collabOpenBurstsMax:
      overrides.collabOpenBurstsMax ?? Number(process.env.COLLAB_OPEN_BURSTS_MAX ?? 5000),
```

Check `backend/test/helpers.ts` `makeTestConfig` — if it hard-codes a full `AppConfig` object rather than calling `resolveConfig`, add the 11 keys there too. Otherwise no change.

- [ ] **Step 5: Run test — expect PASS**

Run: `cd backend && npx vitest run test/m60-schema.test.ts`

- [ ] **Step 6: Run schema/migration regression**

Run: `cd backend && npx vitest run test/api.test.ts test/db` (any migration-touching suite)
Expected: PASS. Then `cd backend && npm run typecheck` → 0 errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/db.ts backend/src/config.ts backend/test/m60-schema.test.ts
git commit -m "feat(m60): add collaboration_changes + collab_last_seen schema and config knobs"
```

---

## Task 2: `changeAttribution.ts` — pure burst state machine

**Files:**
- Create: `backend/src/collab/changeAttribution.ts`
- Test: `backend/test/m60-change-attribution.test.ts`

**Interfaces:**
- Consumes: config values `{ idleMs, maxMs }` passed explicitly (no `cfg` import).
- Produces:
  ```ts
  export interface EditInput {
    projectId: string; authorUserId: number; username: string;
    filePath: string; at: number;
    // best-effort, from the Y.Text observer; null when unavailable/ambiguous
    range: { startLine: number; endLine: number; contiguous: boolean } | null;
    linesAdded: number; linesRemoved: number;
  }
  export interface OpenBurst {
    key: string; projectId: string; authorUserId: number; username: string;
    filePath: string; kind: "edit_burst";
    startedAt: number; endedAt: number; lastEditAt: number;
    updateCount: number; linesAdded: number; linesRemoved: number;
    // merged set of touched line intervals, in order; used by resolveBurstRange
    intervals: Array<[number, number]>;
    rangeContaminated: boolean;
    observerMissed: boolean; // true if any folded edit had range === null
  }
  export interface ClosedBurst extends Omit<OpenBurst, "lastEditAt" | "intervals"> {
    startLine: number | null; endLine: number | null;
    closeReason: CloseReason;
  }
  export type CloseReason =
    | "idle" | "max_age" | "author_switch" | "flush"
    | "disconnect" | "dispose" | "shutdown" | "external_mutation" | "cap";
  export function burstKey(projectId: string, authorUserId: number, filePath: string): string;
  export function openBurst(input: EditInput): OpenBurst;
  export function extendBurst(b: OpenBurst, input: EditInput): void; // mutates
  export function shouldCloseForNextEdit(b: OpenBurst, now: number, idleMs: number, maxMs: number): boolean;
  export function isStale(b: OpenBurst, now: number, idleMs: number, maxMs: number): boolean;
  export function markContaminated(b: OpenBurst): void;
  export function closeBurst(b: OpenBurst, reason: CloseReason): ClosedBurst;
  ```
- **Range rule (spec §5):** `closeBurst` sets `startLine/endLine` to the single
  merged interval **iff** `!rangeContaminated && !observerMissed && intervals`
  merges to exactly one interval; otherwise both `null`.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/test/m60-change-attribution.test.ts
import { describe, it, expect } from "vitest";
import {
  burstKey, openBurst, extendBurst, shouldCloseForNextEdit, isStale,
  markContaminated, closeBurst, type EditInput,
} from "../src/collab/changeAttribution.js";

const IDLE = 15000, MAX = 300000;
const mk = (over: Partial<EditInput> = {}): EditInput => ({
  projectId: "p1", authorUserId: 7, username: "rahul", filePath: "a.ts",
  at: 1_000_000, range: { startLine: 10, endLine: 10, contiguous: true },
  linesAdded: 0, linesRemoved: 0, ...over,
});

describe("changeAttribution", () => {
  it("key is project:user:file", () => {
    expect(burstKey("p1", 7, "a.ts")).toBe("p1:7:a.ts");
  });

  it("opens and extends within the idle window; counts transactions", () => {
    const b = openBurst(mk({ at: 1000 }));
    extendBurst(b, mk({ at: 1000 + 5000 }));
    extendBurst(b, mk({ at: 1000 + 9000 }));
    expect(b.updateCount).toBe(3);
    expect(b.startedAt).toBe(1000);
    expect(b.endedAt).toBe(10000);
  });

  it("idle gap closes for the next edit", () => {
    const b = openBurst(mk({ at: 1000 }));
    expect(shouldCloseForNextEdit(b, 1000 + IDLE + 1, IDLE, MAX)).toBe(true);
    expect(shouldCloseForNextEdit(b, 1000 + IDLE - 1, IDLE, MAX)).toBe(false);
  });

  it("max age closes even with continuous typing", () => {
    const b = openBurst(mk({ at: 1000 }));
    // keep extending every 1s
    for (let t = 2000; t < 1000 + MAX; t += 1000) extendBurst(b, mk({ at: t }));
    expect(shouldCloseForNextEdit(b, 1000 + MAX + 1, IDLE, MAX)).toBe(true);
  });

  it("isStale for the sweep timer", () => {
    const b = openBurst(mk({ at: 1000 }));
    expect(isStale(b, 1000 + IDLE + 1, IDLE, MAX)).toBe(true);
    expect(isStale(b, 1000 + 5, IDLE, MAX)).toBe(false);
  });

  it("contiguous single-region burst keeps an exact range", () => {
    const b = openBurst(mk({ at: 1, range: { startLine: 40, endLine: 44, contiguous: true } }));
    extendBurst(b, mk({ at: 2, range: { startLine: 44, endLine: 52, contiguous: true } }));
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBe(40);
    expect(c.endLine).toBe(52);
  });

  it("non-contiguous folded regions ⇒ null range (not min..max)", () => {
    const b = openBurst(mk({ at: 1, range: { startLine: 10, endLine: 12, contiguous: true } }));
    extendBurst(b, mk({ at: 2, range: { startLine: 80, endLine: 82, contiguous: true } }));
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBeNull();
    expect(c.endLine).toBeNull();
  });

  it("a single non-contiguous transaction ⇒ null range", () => {
    const b = openBurst(mk({ at: 1, range: { startLine: 10, endLine: 40, contiguous: false } }));
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBeNull();
  });

  it("observer miss anywhere in the burst ⇒ null range, event still valid", () => {
    const b = openBurst(mk({ at: 1, range: { startLine: 5, endLine: 6, contiguous: true } }));
    extendBurst(b, mk({ at: 2, range: null }));
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBeNull();
    expect(c.updateCount).toBe(2);
    expect(c.authorUserId).toBe(7);
    expect(c.filePath).toBe("a.ts");
  });

  it("contamination ⇒ null range", () => {
    const b = openBurst(mk({ at: 1 }));
    markContaminated(b);
    extendBurst(b, mk({ at: 2 }));
    const c = closeBurst(b, "author_switch");
    expect(c.startLine).toBeNull();
    expect(c.rangeContaminated).toBe(true);
  });

  it("aggregates line counts", () => {
    const b = openBurst(mk({ at: 1, linesAdded: 3, linesRemoved: 1 }));
    extendBurst(b, mk({ at: 2, linesAdded: 5, linesRemoved: 0 }));
    const c = closeBurst(b, "idle");
    expect(c.linesAdded).toBe(8);
    expect(c.linesRemoved).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `cd backend && npx vitest run test/m60-change-attribution.test.ts`

- [ ] **Step 3: Implement `changeAttribution.ts`**

```ts
// backend/src/collab/changeAttribution.ts
// PURE. No db, no Y.* runtime imports, no timers. Every burst rule from
// spec §4/§5 is proven by backend/test/m60-change-attribution.test.ts.

export interface EditInput {
  projectId: string; authorUserId: number; username: string;
  filePath: string; at: number;
  range: { startLine: number; endLine: number; contiguous: boolean } | null;
  linesAdded: number; linesRemoved: number;
}
export interface OpenBurst {
  key: string; projectId: string; authorUserId: number; username: string;
  filePath: string; kind: "edit_burst";
  startedAt: number; endedAt: number; lastEditAt: number;
  updateCount: number; linesAdded: number; linesRemoved: number;
  intervals: Array<[number, number]>;
  rangeContaminated: boolean; observerMissed: boolean;
}
export type CloseReason =
  | "idle" | "max_age" | "author_switch" | "flush" | "disconnect"
  | "dispose" | "shutdown" | "external_mutation" | "cap";
export interface ClosedBurst {
  key: string; projectId: string; authorUserId: number; username: string;
  filePath: string; kind: "edit_burst";
  startedAt: number; endedAt: number;
  updateCount: number; linesAdded: number; linesRemoved: number;
  rangeContaminated: boolean; observerMissed: boolean;
  startLine: number | null; endLine: number | null;
  closeReason: CloseReason;
}

export function burstKey(projectId: string, authorUserId: number, filePath: string): string {
  return `${projectId}:${authorUserId}:${filePath}`;
}

function foldInterval(intervals: Array<[number, number]>, next: [number, number]): void {
  intervals.push(next);
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  intervals.length = 0;
  intervals.push(...merged);
}

export function openBurst(input: EditInput): OpenBurst {
  const b: OpenBurst = {
    key: burstKey(input.projectId, input.authorUserId, input.filePath),
    projectId: input.projectId, authorUserId: input.authorUserId,
    username: input.username, filePath: input.filePath, kind: "edit_burst",
    startedAt: input.at, endedAt: input.at, lastEditAt: input.at,
    updateCount: 1, linesAdded: input.linesAdded, linesRemoved: input.linesRemoved,
    intervals: [], rangeContaminated: false, observerMissed: false,
  };
  applyRange(b, input);
  return b;
}

function applyRange(b: OpenBurst, input: EditInput): void {
  if (!input.range || !input.range.contiguous) {
    b.observerMissed = true; // an unusable range is treated like a miss for §5
    return;
  }
  foldInterval(b.intervals, [input.range.startLine, input.range.endLine]);
}

export function extendBurst(b: OpenBurst, input: EditInput): void {
  b.updateCount += 1;
  b.endedAt = input.at;
  b.lastEditAt = input.at;
  b.linesAdded += input.linesAdded;
  b.linesRemoved += input.linesRemoved;
  applyRange(b, input);
}

export function shouldCloseForNextEdit(
  b: OpenBurst, now: number, idleMs: number, maxMs: number,
): boolean {
  return now - b.lastEditAt > idleMs || now - b.startedAt > maxMs;
}

export function isStale(
  b: OpenBurst, now: number, idleMs: number, maxMs: number,
): boolean {
  return now - b.lastEditAt > idleMs || now - b.startedAt > maxMs;
}

export function markContaminated(b: OpenBurst): void {
  b.rangeContaminated = true;
}

export function closeBurst(b: OpenBurst, reason: CloseReason): ClosedBurst {
  const rangeOk =
    !b.rangeContaminated && !b.observerMissed && b.intervals.length === 1;
  return {
    key: b.key, projectId: b.projectId, authorUserId: b.authorUserId,
    username: b.username, filePath: b.filePath, kind: b.kind,
    startedAt: b.startedAt, endedAt: b.endedAt,
    updateCount: b.updateCount, linesAdded: b.linesAdded,
    linesRemoved: b.linesRemoved, rangeContaminated: b.rangeContaminated,
    observerMissed: b.observerMissed,
    startLine: rangeOk ? b.intervals[0][0] : null,
    endLine: rangeOk ? b.intervals[0][1] : null,
    closeReason: reason,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && npx vitest run test/m60-change-attribution.test.ts`

- [ ] **Step 5: Typecheck + lint**

Run: `cd backend && npm run typecheck && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add backend/src/collab/changeAttribution.ts backend/test/m60-change-attribution.test.ts
git commit -m "feat(m60): pure burst state machine (changeAttribution)"
```

---

## Task 3: `lastSeen.ts` helpers

**Files:**
- Create: `backend/src/collab/lastSeen.ts`
- Test: `backend/test/m60-last-seen.test.ts`

**Interfaces:**
- Consumes: `Db` from `../db.js`.
- Produces:
  ```ts
  export function touchLastSeen(db: Db, projectId: string, userId: number, atIso?: string): void;
  export function getLastSeen(db: Db, projectId: string, userId: number): string | null;
  export function insertLastSeenIfAbsent(db: Db, projectId: string, userId: number): void;
  ```
- `touchLastSeen` upserts `last_seen_at = max(existing, atIso ?? now)`.
- `insertLastSeenIfAbsent` inserts `now` only when no row exists (first-ever connect).

- [ ] **Step 1: Failing test**

```ts
// backend/test/m60-last-seen.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { touchLastSeen, getLastSeen, insertLastSeenIfAbsent } from "../src/collab/lastSeen.js";

function seed(db: any) {
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'u','h')").run();
  db.prepare("INSERT INTO projects (id, owner_id, name) VALUES ('p',1,'P')").run();
}

describe("collab_last_seen helpers", () => {
  let db: any;
  beforeEach(() => { db = openDb(":memory:"); seed(db); });

  it("getLastSeen is null before any write", () => {
    expect(getLastSeen(db, "p", 1)).toBeNull();
  });

  it("insertLastSeenIfAbsent inserts once, then is a no-op", () => {
    insertLastSeenIfAbsent(db, "p", 1);
    const first = getLastSeen(db, "p", 1);
    expect(first).not.toBeNull();
    insertLastSeenIfAbsent(db, "p", 1);
    expect(getLastSeen(db, "p", 1)).toBe(first); // unchanged
  });

  it("touchLastSeen never moves the timestamp backwards", () => {
    touchLastSeen(db, "p", 1, "2026-08-31T12:00:00.000Z");
    touchLastSeen(db, "p", 1, "2026-08-31T11:00:00.000Z");
    expect(getLastSeen(db, "p", 1)).toBe("2026-08-31T12:00:00.000Z");
    touchLastSeen(db, "p", 1, "2026-08-31T13:00:00.000Z");
    expect(getLastSeen(db, "p", 1)).toBe("2026-08-31T13:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd backend && npx vitest run test/m60-last-seen.test.ts`

- [ ] **Step 3: Implement**

```ts
// backend/src/collab/lastSeen.ts
import type { Db } from "../db.js";

export function getLastSeen(db: Db, projectId: string, userId: number): string | null {
  const row = db
    .prepare("SELECT last_seen_at FROM collab_last_seen WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as { last_seen_at: string } | undefined;
  return row?.last_seen_at ?? null;
}

export function touchLastSeen(
  db: Db, projectId: string, userId: number, atIso?: string,
): void {
  const at = atIso ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO collab_last_seen (project_id, user_id, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET
      last_seen_at = CASE WHEN excluded.last_seen_at > last_seen_at
                          THEN excluded.last_seen_at ELSE last_seen_at END
  `).run(projectId, userId, at);
}

export function insertLastSeenIfAbsent(db: Db, projectId: string, userId: number): void {
  db.prepare(`
    INSERT INTO collab_last_seen (project_id, user_id, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, user_id) DO NOTHING
  `).run(projectId, userId, new Date().toISOString());
}
```

- [ ] **Step 4: Run — expect PASS.** Then `npm run typecheck && npm run lint` in `backend/`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collab/lastSeen.ts backend/test/m60-last-seen.test.ts
git commit -m "feat(m60): collab_last_seen upsert/read helpers"
```

---

## Task 4: `CollaborationHistorian` — accumulation, batching, retention, lifecycle

**Files:**
- Create: `backend/src/collab/historian.ts`
- Test: `backend/test/m60-historian.test.ts`

**Interfaces:**
- Consumes: `Db`, `AppConfig`, everything from `changeAttribution.ts`, the
  `TimelineEvent` type from `timeline.ts` (Task 6 — but only the *type*;
  declare a local structural type here and swap the import in Task 6 if
  ordering forces it — simpler: do Task 6's type file first, see note below).
- Produces:
  ```ts
  export class CollaborationHistorian {
    static getInstance(): CollaborationHistorian;
    init(db: Db, cfg: AppConfig): void;
    setBroadcaster(fn: (projectId: string, ev: CollabChangeWire) => void): void;
    recordEdit(input: EditInput): void;
    recordCallout(input: {
      projectId: string; authorUserId: number; username: string;
      filePath: string; startLine: number | null; endLine: number | null;
      messagePreview: string; targeted: boolean; at: number;
    }): void;
    closeAuthorBursts(projectId: string, userId: number, reason: CloseReason): void;
    closeProjectBursts(projectId: string, reason: CloseReason): void;
    contaminateFile(projectId: string, filePath: string): void; // mark every open burst for this file+project contaminated (called on external_mutation / initial_disk_load mid-session — spec §5, §16)
    disposeProject(projectId: string): void;
    flushQueue(): void;
    purgeExpired(): void;
    stop(): void;
    // test hooks:
    _openBurstCount(): number;
    _queueLength(): number;
  }
  export interface CollabChangeWire {  // the shape sent over MESSAGE_CUSTOM + returned by REST
    id: string; kind: "edit_burst" | "callout"; at: string;
    actor: { userId: number; username: string };
    filePath: string;
    lineRange: { startLine: number; endLine: number } | null;
    updateCount: number; linesAdded: number; linesRemoved: number;
    calloutPreview?: string;
  }
  export const collaborationHistorian: CollaborationHistorian; // singleton
  ```
- **Note on Task ordering:** create `timeline.ts`'s `TimelineEvent` type stub
  first (Task 6 Step 3 defines it fully). Here, import only `CollabChangeWire`
  which this file *owns*. `timeline.ts` maps a stored row → `TimelineEvent`;
  the wire event is a sibling shape. Keep them distinct.

- [ ] **Step 1: Failing tests**

```ts
// backend/test/m60-historian.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationHistorian } from "../src/collab/historian.js";

function seed(db: any) {
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (7,'rahul','h'),(8,'ankit','h')").run();
  db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',7,'P')").run();
}
const edit = (over = {}) => ({
  projectId: "p", authorUserId: 7, username: "rahul", filePath: "a.ts",
  at: Date.now(), range: { startLine: 10, endLine: 10, contiguous: true },
  linesAdded: 1, linesRemoved: 0, ...over,
});

describe("CollaborationHistorian", () => {
  let db: any, h: CollaborationHistorian;
  beforeEach(() => {
    db = openDb(":memory:"); seed(db);
    h = new (CollaborationHistorian as any)();
    h.init(db, resolveConfig());
  });
  afterEach(() => h.stop());

  it("a closed burst produces exactly one row", () => {
    const t = 1_000_000;
    h.recordEdit(edit({ at: t }));
    h.recordEdit(edit({ at: t + 5000 }));
    h.recordEdit(edit({ at: t + 100000, filePath: "b.ts" })); // different file → prior key still open; force close:
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const rows = db.prepare("SELECT * FROM collaboration_changes WHERE project_id='p'").all() as any[];
    expect(rows.filter((r) => r.file_path === "a.ts")).toHaveLength(1);
    expect(rows.find((r) => r.file_path === "a.ts").update_count).toBe(2);
  });

  it("different author closes the first author's open burst (contaminated → null range)", () => {
    const t = 2_000_000;
    h.recordEdit(edit({ at: t, authorUserId: 7, username: "rahul" }));
    h.recordEdit(edit({ at: t + 1000, authorUserId: 8, username: "ankit" }));
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const rahul = db.prepare(
      "SELECT * FROM collaboration_changes WHERE author_user_id=7 AND file_path='a.ts'"
    ).get() as any;
    expect(rahul.start_line).toBeNull();
  });

  it("batches: N closes → one transaction (spy on db.exec BEGIN)", () => {
    const execSpy = vi.spyOn(db, "exec");
    for (let i = 0; i < 10; i++) {
      h.recordEdit(edit({ at: 3_000_000 + i * 1000, filePath: `f${i}.ts` }));
    }
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const begins = execSpy.mock.calls.filter((c) => String(c[0]).includes("BEGIN"));
    expect(begins.length).toBe(1);
  });

  it("stop() closes all open bursts and flushes (no buffered loss)", () => {
    h.recordEdit(edit({ at: 4_000_000 }));
    expect(h._openBurstCount()).toBe(1);
    h.stop();
    const rows = db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as any;
    expect(rows.c).toBe(1);
    expect(h._openBurstCount()).toBe(0);
  });

  it("disposeProject closes+flushes+drops that project only", () => {
    h.recordEdit(edit({ at: 5_000_000, projectId: "p" }));
    h.disposeProject("p");
    expect(h._openBurstCount()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as any).c).toBe(1);
  });

  it("recordCallout writes a kind='callout' row with only allowlisted detail", () => {
    h.recordCallout({
      projectId: "p", authorUserId: 7, username: "rahul", filePath: "a.ts",
      startLine: 40, endLine: 52, messagePreview: "look here", targeted: false, at: 6_000_000,
    });
    h.flushQueue();
    const row = db.prepare("SELECT * FROM collaboration_changes WHERE kind='callout'").get() as any;
    expect(row.file_path).toBe("a.ts");
    expect(row.start_line).toBe(40);
    const detail = JSON.parse(row.detail);
    expect(Object.keys(detail).sort()).toEqual(["messagePreview", "targeted"]);
  });

  it("retention: time purge + per-project cap", () => {
    // insert 5 old + 5 fresh; retention 0 days, cap 3
    const cfg = { ...resolveConfig(), collabHistoryRetentionDays: 0, collabHistoryMaxPerProject: 3 };
    h.stop(); h = new (CollaborationHistorian as any)(); h.init(db, cfg);
    const old = "2000-01-01T00:00:00.000Z";
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO collaboration_changes
        (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
        VALUES (?,?,?,?,?,?,?)`).run(`old${i}`, "p", 7, "a.ts", "edit_burst", old, old);
    }
    for (let i = 0; i < 5; i++) {
      h.recordEdit(edit({ at: 7_000_000 + i * 20000, filePath: `n${i}.ts` }));
    }
    h.closeProjectBursts("p", "flush"); h.flushQueue();
    h.purgeExpired();
    const rows = db.prepare("SELECT id FROM collaboration_changes").all() as any[];
    expect(rows.every((r) => !r.id.startsWith("old"))).toBe(true); // time purge
    expect(rows.length).toBeLessThanOrEqual(3);                    // cap
  });

  it("open-burst map is capped (oldest force-closed)", () => {
    const cfg = { ...resolveConfig(), collabOpenBurstsMax: 3 };
    h.stop(); h = new (CollaborationHistorian as any)(); h.init(db, cfg);
    for (let i = 0; i < 5; i++) h.recordEdit(edit({ at: 8_000_000 + i, filePath: `c${i}.ts` }));
    expect(h._openBurstCount()).toBeLessThanOrEqual(3);
  });

  it("reconnect (same userId) does not duplicate — extends or reopens, never re-emits", () => {
    const t = 9_000_000;
    h.recordEdit(edit({ at: t }));
    h.closeAuthorBursts("p", 7, "disconnect");
    h.recordEdit(edit({ at: t + 2000 }));       // "reconnected", new edit
    h.closeProjectBursts("p", "flush"); h.flushQueue();
    expect((db.prepare("SELECT COUNT(*) c FROM collaboration_changes WHERE file_path='a.ts'").get() as any).c).toBe(2);
  });

  it("broadcasts each closed burst once", () => {
    const bc = vi.fn();
    h.setBroadcaster(bc);
    h.recordEdit(edit({ at: 10_000_000 }));
    h.closeProjectBursts("p", "flush");
    expect(bc).toHaveBeenCalledTimes(1);
    expect(bc.mock.calls[0][0]).toBe("p");
    expect(bc.mock.calls[0][1].actor.userId).toBe(7);
  });

  it("contaminateFile forces null range on the matching open burst", () => {
    const t = 11_000_000;
    h.recordEdit(edit({ at: t, filePath: "x.ts", range: { startLine: 3, endLine: 3, contiguous: true } }));
    h.contaminateFile("p", "x.ts");
    h.recordEdit(edit({ at: t + 500, filePath: "x.ts", range: { startLine: 4, endLine: 4, contiguous: true } }));
    h.closeProjectBursts("p", "flush"); h.flushQueue();
    const row = db.prepare("SELECT * FROM collaboration_changes WHERE file_path='x.ts'").get() as any;
    expect(row.start_line).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd backend && npx vitest run test/m60-historian.test.ts`

- [ ] **Step 3: Implement `historian.ts`**

Key implementation points (full code — spec §6.1):

```ts
// backend/src/collab/historian.ts
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import {
  burstKey, openBurst, extendBurst, shouldCloseForNextEdit, isStale,
  markContaminated, closeBurst,
  type EditInput, type OpenBurst, type ClosedBurst, type CloseReason,
} from "./changeAttribution.js";

export interface CollabChangeWire {
  id: string; kind: "edit_burst" | "callout"; at: string;
  actor: { userId: number; username: string };
  filePath: string;
  lineRange: { startLine: number; endLine: number } | null;
  updateCount: number; linesAdded: number; linesRemoved: number;
  calloutPreview?: string;
}

type StoredRow = {
  id: string; project_id: string; author_user_id: number; file_path: string;
  kind: "edit_burst" | "callout"; started_at: string; ended_at: string;
  update_count: number; lines_added: number; lines_removed: number;
  start_line: number | null; end_line: number | null; detail: string | null;
};

export class CollaborationHistorian {
  private static instance: CollaborationHistorian;
  private db: Db | null = null;
  private cfg: AppConfig | null = null;
  private open = new Map<string, OpenBurst>();
  private queue: StoredRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private broadcaster: ((p: string, ev: CollabChangeWire) => void) | null = null;
  private projectsTouchedSinceLastPurge = new Set<string>();

  static getInstance(): CollaborationHistorian {
    if (!CollaborationHistorian.instance) {
      CollaborationHistorian.instance = new CollaborationHistorian();
    }
    return CollaborationHistorian.instance;
  }

  init(db: Db, cfg: AppConfig): void {
    this.db = db; this.cfg = cfg;
    this.flushTimer = setInterval(() => this.flushQueue(), cfg.collabHistoryFlushIntervalMs);
    this.flushTimer.unref?.();
    this.sweepTimer = setInterval(() => this.sweep(), cfg.collabBurstSweepMs);
    this.sweepTimer.unref?.();
    this.purgeTimer = setInterval(() => this.purgeExpired(), 15 * 60 * 1000);
    this.purgeTimer.unref?.();
  }

  setBroadcaster(fn: (p: string, ev: CollabChangeWire) => void): void {
    this.broadcaster = fn;
  }

  recordEdit(input: EditInput): void {
    if (!this.cfg) return;
    const { collabBurstIdleMs: idle, collabBurstMaxMs: max, collabOpenBurstsMax: cap } = this.cfg;
    // different-author contamination: close any OTHER author's open burst for this file
    for (const [k, b] of this.open) {
      if (b.projectId === input.projectId && b.filePath === input.filePath
          && b.authorUserId !== input.authorUserId) {
        markContaminated(b);
        this.enqueueClose(closeBurst(b, "author_switch"));
        this.open.delete(k);
      }
    }
    const key = burstKey(input.projectId, input.authorUserId, input.filePath);
    const existing = this.open.get(key);
    if (existing && !shouldCloseForNextEdit(existing, input.at, idle, max)) {
      extendBurst(existing, input);
    } else {
      if (existing) { this.enqueueClose(closeBurst(existing, "idle")); this.open.delete(key); }
      this.open.set(key, openBurst(input));
    }
    if (this.open.size > cap) this.forceCloseOldest(cap);
  }

  recordCallout(i: {
    projectId: string; authorUserId: number; username: string; filePath: string;
    startLine: number | null; endLine: number | null;
    messagePreview: string; targeted: boolean; at: number;
  }): void {
    const iso = new Date(i.at).toISOString();
    const row: StoredRow = {
      id: randomUUID(), project_id: i.projectId, author_user_id: i.authorUserId,
      file_path: i.filePath, kind: "callout", started_at: iso, ended_at: iso,
      update_count: 0, lines_added: 0, lines_removed: 0,
      start_line: i.startLine, end_line: i.endLine,
      detail: JSON.stringify({ messagePreview: i.messagePreview.slice(0, 120), targeted: !!i.targeted }),
    };
    this.queue.push(row);
    this.projectsTouchedSinceLastPurge.add(i.projectId);
    this.emitWire(row, i.username);
    if (this.queue.length >= 100) this.flushQueue();
  }

  private sweep(): void {
    if (!this.cfg) return;
    const now = Date.now();
    const { collabBurstIdleMs: idle, collabBurstMaxMs: max } = this.cfg;
    for (const [k, b] of this.open) {
      if (isStale(b, now, idle, max)) {
        this.enqueueClose(closeBurst(b, now - b.startedAt > max ? "max_age" : "idle"));
        this.open.delete(k);
      }
    }
  }

  closeAuthorBursts(projectId: string, userId: number, reason: CloseReason): void {
    for (const [k, b] of this.open) {
      if (b.projectId === projectId && b.authorUserId === userId) {
        this.enqueueClose(closeBurst(b, reason)); this.open.delete(k);
      }
    }
  }
  closeProjectBursts(projectId: string, reason: CloseReason): void {
    for (const [k, b] of this.open) {
      if (b.projectId === projectId) { this.enqueueClose(closeBurst(b, reason)); this.open.delete(k); }
    }
  }
  contaminateFile(projectId: string, filePath: string): void {
    for (const b of this.open.values()) {
      if (b.projectId === projectId && b.filePath === filePath) markContaminated(b);
    }
  }
  disposeProject(projectId: string): void {
    this.closeProjectBursts(projectId, "dispose");
    this.flushQueue();
  }

  private forceCloseOldest(cap: number): void {
    const sorted = [...this.open.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (this.open.size > cap && sorted.length) {
      const b = sorted.shift()!;
      this.enqueueClose(closeBurst(b, "cap")); this.open.delete(b.key);
    }
  }

  private enqueueClose(c: ClosedBurst): void {
    const iso = (n: number) => new Date(n).toISOString();
    const row: StoredRow = {
      id: randomUUID(), project_id: c.projectId, author_user_id: c.authorUserId,
      file_path: c.filePath, kind: "edit_burst",
      started_at: iso(c.startedAt), ended_at: iso(c.endedAt),
      update_count: c.updateCount, lines_added: c.linesAdded, lines_removed: c.linesRemoved,
      start_line: c.startLine, end_line: c.endLine, detail: null,
    };
    this.queue.push(row);
    this.projectsTouchedSinceLastPurge.add(c.projectId);
    this.emitWire(row, c.username);
    if (this.queue.length >= 100) this.flushQueue();
  }

  private emitWire(row: StoredRow, username: string): void {
    if (!this.broadcaster) return;
    const detail = row.detail ? JSON.parse(row.detail) : null;
    const ev: CollabChangeWire = {
      id: `collab:${row.id}`, kind: row.kind, at: row.ended_at,
      actor: { userId: row.author_user_id, username },
      filePath: row.file_path,
      lineRange: row.start_line != null && row.end_line != null
        ? { startLine: row.start_line, endLine: row.end_line } : null,
      updateCount: row.update_count, linesAdded: row.lines_added, linesRemoved: row.lines_removed,
      calloutPreview: detail?.messagePreview,
    };
    try { this.broadcaster(row.project_id, ev); } catch { /* never throw into a room */ }
  }

  flushQueue(): void {
    if (!this.db || this.queue.length === 0) return;
    const rows = this.queue; this.queue = [];
    try {
      this.db.exec("BEGIN TRANSACTION;");
      const stmt = this.db.prepare(`INSERT INTO collaboration_changes
        (id,project_id,author_user_id,file_path,kind,started_at,ended_at,
         update_count,lines_added,lines_removed,start_line,end_line,detail)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        stmt.run(r.id, r.project_id, r.author_user_id, r.file_path, r.kind,
          r.started_at, r.ended_at, r.update_count, r.lines_added, r.lines_removed,
          r.start_line, r.end_line, r.detail);
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      try { this.db.exec("ROLLBACK;"); } catch { /* */ }
      console.error("[CollabHistorian] flush failed:", err);
    }
    this.maybePurgeCaps();
  }

  private maybePurgeCaps(): void {
    if (!this.db || !this.cfg) return;
    const cap = this.cfg.collabHistoryMaxPerProject;
    for (const pid of this.projectsTouchedSinceLastPurge) {
      this.db.prepare(`DELETE FROM collaboration_changes
        WHERE project_id = ? AND id NOT IN (
          SELECT id FROM collaboration_changes WHERE project_id = ?
          ORDER BY ended_at DESC, id DESC LIMIT ?)`).run(pid, pid, cap);
    }
    this.projectsTouchedSinceLastPurge.clear();
  }

  purgeExpired(): void {
    if (!this.db || !this.cfg) return;
    const days = this.cfg.collabHistoryRetentionDays;
    try {
      this.db.prepare(
        `DELETE FROM collaboration_changes WHERE ended_at < datetime('now', ?)`
      ).run(`-${days} days`);
    } catch (err) {
      console.warn("[CollabHistorian] purge warning:", err);
    }
    this.maybePurgeCaps();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.flushTimer = this.sweepTimer = this.purgeTimer = null;
    for (const [k, b] of this.open) { this.enqueueClose(closeBurst(b, "shutdown")); this.open.delete(k); }
    this.flushQueue();
  }

  _openBurstCount(): number { return this.open.size; }
  _queueLength(): number { return this.queue.length; }
}

export const collaborationHistorian = CollaborationHistorian.getInstance();
```

**Note:** `datetime('now', ?)` with a bound `'-14 days'` string — verify
`node:sqlite` binds the modifier param correctly; if not, interpolate the
integer `days` into the SQL string (it is a config number, not user input):
`` `DELETE ... WHERE ended_at < datetime('now','-${Number(days)} days')` ``.
Add a test asserting the delete removes an old row.

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && npx vitest run test/m60-historian.test.ts`

- [ ] **Step 5: Typecheck + lint**

Run: `cd backend && npm run typecheck && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add backend/src/collab/historian.ts backend/test/m60-historian.test.ts
git commit -m "feat(m60): CollaborationHistorian — batched, bounded, retained change store"
```

---

## Task 5: Room wiring — `afterTransaction` attribution + range observer + burst-close hooks

**Files:**
- Modify: `backend/src/collab/manager.ts` (ctor `afterTransaction` listener; `ensureFileLoaded`; `removeClient`; `flushToDisk`; `flushBeforeDestructiveDispose`; `dispose`; `handleAttentionMessage`; `CollaborationManager.broadcastCollabChange` + `notifyRunStatus`-style plumbing)
- Test: `backend/test/m60-room-attribution.test.ts`

**Interfaces:**
- Consumes: `collaborationHistorian` from `./historian.js`; `changeAttribution` types.
- Produces: `CollaborationManager.broadcastCollabChange(projectId, ev)` (fans out `MESSAGE_CUSTOM` `{type:"collab_change", ...ev}`); `CollaborationRoom.broadcastCollabChange(ev)`.

- [ ] **Step 1: Failing tests** (real `CollaborationRoom` + `makeWs()` fake sockets — pattern from `m58-attention.test.ts`)

```ts
// backend/test/m60-room-attribution.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationRoom } from "../src/collab/manager.js";
import { CollaborationHistorian } from "../src/collab/historian.js";

// helper: build a MESSAGE_SYNC update frame from a local doc edit
function editFrame(mutate: (d: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  mutate(doc);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}
function makeWs() {
  const sent: Uint8Array[] = [];
  return { readyState: 1, send: (d: Uint8Array) => sent.push(d), close: () => {}, sent }
    as unknown as WebSocket & { sent: Uint8Array[] };
}

describe("M60 room attribution", () => {
  let db: any, cfg: any, tmp: string, room: CollaborationRoom, h: CollaborationHistorian;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "m60-"));
    db = openDb(":memory:");
    db.prepare("INSERT INTO users (id,username,password_hash) VALUES (7,'rahul','h'),(8,'ankit','h'),(9,'viewer','h')").run();
    db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',7,'P')").run();
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    h = new (CollaborationHistorian as any)(); h.init(db, cfg);
    room = new CollaborationRoom("p", cfg, db, () => {}, {}, h); // NEW: historian injected
  });
  afterEach(() => { room.dispose(); h.stop(); rmSync(tmp, { recursive: true, force: true }); });

  it("attributes an edit to the authenticated user", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });
    room.handleMessage(ws, editFrame((d) => d.getText("a.ts").insert(0, "line1\nline2\n")));
    room.dispose();          // closes bursts synchronously
    h.flushQueue();
    const row = db.prepare("SELECT * FROM collaboration_changes WHERE file_path='a.ts'").get() as any;
    expect(row.author_user_id).toBe(7);
    expect(row.update_count).toBeGreaterThanOrEqual(1);
  });

  it("a viewer edit produces no history", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 9, username: "viewer", role: "viewer" });
    room.handleMessage(ws, editFrame((d) => d.getText("a.ts").insert(0, "x")));
    room.dispose(); h.flushQueue();
    expect((db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as any).c).toBe(0);
  });

  it("external_mutation does not attribute and contaminates an open burst", async () => {
    const ws = makeWs();
    await room.addClient(ws, { userId: 7, username: "rahul", role: "editor" });
    writeFileSync(join(tmp, "projects", "p", "a.ts"), "disk\n"); // path per projectDir layout
    room.handleMessage(ws, editFrame((d) => d.getText("a.ts").insert(0, "typed\n")));
    await room.handleExternalFileMutation("a.ts", "external replace\n");
    room.dispose(); h.flushQueue();
    const rows = db.prepare("SELECT * FROM collaboration_changes").all() as any[];
    // rahul's burst is present, file-level (range null), no row attributed to a mutation
    expect(rows).toHaveLength(1);
    expect(rows[0].author_user_id).toBe(7);
    expect(rows[0].start_line).toBeNull();
  });

  it("removeClient closes that author's bursts; dispose closes all", async () => {
    const a = makeWs(), b = makeWs();
    await room.addClient(a, { userId: 7, username: "rahul", role: "editor" });
    await room.addClient(b, { userId: 8, username: "ankit", role: "editor" });
    room.handleMessage(a, editFrame((d) => d.getText("a.ts").insert(0, "a\n")));
    room.handleMessage(b, editFrame((d) => d.getText("b.ts").insert(0, "b\n")));
    room.removeClient(a); h.flushQueue();
    expect((db.prepare("SELECT COUNT(*) c FROM collaboration_changes WHERE author_user_id=7").get() as any).c).toBe(1);
    room.dispose(); h.flushQueue();
    expect((db.prepare("SELECT COUNT(*) c FROM collaboration_changes WHERE author_user_id=8").get() as any).c).toBe(1);
  });

  it("broadcasts collab_change to other clients", async () => {
    const a = makeWs(), b = makeWs();
    await room.addClient(a, { userId: 7, username: "rahul", role: "editor" });
    await room.addClient(b, { userId: 8, username: "ankit", role: "editor" });
    room.handleMessage(a, editFrame((d) => d.getText("a.ts").insert(0, "a\n")));
    room.removeClient(a); h.flushQueue();
    const customMsgs = b.sent
      .map((buf) => { try { const d = require("lib0/decoding").createDecoder(buf);
        if (require("lib0/decoding").readVarUint(d) !== 3) return null;
        return JSON.parse(require("lib0/decoding").readVarString(d)); } catch { return null; } })
      .filter(Boolean);
    expect(customMsgs.some((m: any) => m.type === "collab_change" && m.actor.userId === 7)).toBe(true);
  });
});
```

*(Adjust the `projects/p/a.ts` path in the `external_mutation` test to whatever
`projectDir(cfg, "p")` resolves to — mkdir it in `beforeEach`.)*

- [ ] **Step 2: Run — expect FAIL** (ctor arity, no attribution)

Run: `cd backend && npx vitest run test/m60-room-attribution.test.ts`

- [ ] **Step 3: Wire the room**

**3a. Constructor signature** — add an optional injected historian (default the
singleton) so tests can pass an isolated instance:

```ts
import { collaborationHistorian, type CollaborationHistorian } from "./historian.js";
// ...
constructor(
  projectId: string, cfg: AppConfig, db: Db,
  onDispose: (projectId: string) => void,
  options: CollaborationRoomOptions = {},
  private readonly historian: CollaborationHistorian = collaborationHistorian,
) { /* ...existing... */ }
```

Update `CollaborationManager.getOrCreateRoom` — no change needed (uses the
5-arg form; the 6th defaults).

**3b. Range observer stash** — add fields + a `WeakMap` keyed by transaction:

```ts
private rangeObservedFiles = new Set<string>();
private rangeStash = new WeakMap<Y.Transaction, Map<string, {
  startLine: number; endLine: number; contiguous: boolean;
  linesAdded: number; linesRemoved: number;
}>>();
```

In `ensureFileLoaded`, **after** the `safeResolve`/`assertInsideWorkspace`
guard passes and `const yText = this.doc.getText(filePath);`:

```ts
if (!this.rangeObservedFiles.has(filePath)) {
  yText.observe((evt) => this.stashRange(filePath, evt));
  this.rangeObservedFiles.add(filePath);
}
```

`stashRange` — compute the affected span from `evt.delta` (Quill ops), convert
char offsets → 1-based lines against `evt.target.toString()`:

```ts
private stashRange(filePath: string, evt: Y.YTextEvent): void {
  const tr = evt.transaction;
  if (tr.origin === "external_mutation" || tr.origin === "initial_disk_load") return;
  let offset = 0, changeStart = -1, changeEnd = -1, clusters = 0, inCluster = false;
  let added = 0, removed = 0;
  for (const op of evt.delta as Array<any>) {
    if (typeof op.retain === "number") {
      if (inCluster) { inCluster = false; }
      offset += op.retain;
    } else {
      if (!inCluster) { clusters++; inCluster = true; if (changeStart < 0) changeStart = offset; }
      if (typeof op.insert === "string") { added += (op.insert.match(/\n/g) || []).length; offset += op.insert.length; changeEnd = offset; }
      if (typeof op.delete === "number") { changeEnd = offset + op.delete; /* removed lines approx below */ }
    }
  }
  const text = evt.target.toString();
  const lineAt = (o: number) => text.slice(0, Math.max(0, Math.min(o, text.length))).split("\n").length;
  const entry = {
    startLine: changeStart < 0 ? 1 : lineAt(changeStart),
    endLine: changeEnd < 0 ? 1 : lineAt(changeEnd),
    contiguous: clusters <= 1,
    linesAdded: added, linesRemoved: removed,
  };
  let m = this.rangeStash.get(tr);
  if (!m) { m = new Map(); this.rangeStash.set(tr, m); }
  const prev = m.get(filePath);
  m.set(filePath, prev ? {
    startLine: Math.min(prev.startLine, entry.startLine),
    endLine: Math.max(prev.endLine, entry.endLine),
    contiguous: prev.contiguous && entry.contiguous,
    linesAdded: prev.linesAdded + entry.linesAdded,
    linesRemoved: prev.linesRemoved + entry.linesRemoved,
  } : entry);
}
```

*(Deleted-line counting is best-effort — leaving `removed` at 0 is acceptable
per spec §3.3; if `evt.changes.deleted` items expose the removed text, count
its newlines there. Do not block the task on perfect deletion counts.)*

**3c. `afterTransaction` attribution** — inside the **existing** listener, after
the current dirty-file mapping loop:

```ts
this.doc.on("afterTransaction", (tr: Y.Transaction) => {
  // ...existing dirty-file mapping (UNCHANGED) ...

  // --- M60: change attribution ---
  if (this.disposed) return;
  const origin = tr.origin;
  const isWs = origin && typeof origin === "object" && this.clients.has(origin as WebSocket);
  if (origin === "external_mutation" || origin === "initial_disk_load") {
    // contaminate any open burst for the touched files
    for (const changedType of tr.changed.keys()) {
      for (const [key, type] of (this.doc.share as Map<string, unknown>).entries()) {
        if (type === changedType) { this.historian.contaminateFile?.(this.projectId, key); break; }
      }
    }
    this.rangeStash.delete(tr);
    return;
  }
  if (!isWs) { this.rangeStash.delete(tr); return; }
  const cs = this.clients.get(origin as WebSocket);
  if (!cs || tr.changed.size === 0) { this.rangeStash.delete(tr); return; }

  const stash = this.rangeStash.get(tr);
  const now = Date.now();
  for (const changedType of tr.changed.keys()) {
    let filePath: string | null = null;
    for (const [key, type] of (this.doc.share as Map<string, unknown>).entries()) {
      if (type === changedType) { filePath = key; break; }
    }
    if (!filePath || !this.isPersistablePath(filePath)) continue;
    const r = stash?.get(filePath) ?? null;
    this.historian.recordEdit({
      projectId: this.projectId, authorUserId: cs.userId, username: cs.username,
      filePath, at: now,
      range: r ? { startLine: r.startLine, endLine: r.endLine, contiguous: r.contiguous } : null,
      linesAdded: r?.linesAdded ?? 0, linesRemoved: r?.linesRemoved ?? 0,
    });
  }
  this.rangeStash.delete(tr);
});
```

Add `CollaborationHistorian.contaminateFile(projectId, filePath)` (Task 4
follow-up — a 4-line method: for each open burst matching `projectId` +
`filePath`, `markContaminated(b)`). Add a test for it in `m60-historian.test.ts`.

**3d. Burst-close hooks:**

- `removeClient(ws)` — after `this.clients.delete(ws)` and the awareness
  cleanup, before `scheduleIdleDisposal`:
  ```ts
  if (clientState && !this.hasOtherSocketForUser(clientState.userId)) {
    this.historian.closeAuthorBursts(this.projectId, clientState.userId, "disconnect");
  }
  ```
  where `hasOtherSocketForUser` iterates `this.clients.values()` for a matching `userId`.
- `flushToDisk()` — at the **top**, after the `disposed` guard:
  `this.historian.closeProjectBursts(this.projectId, "flush");`
- `flushBeforeDestructiveDispose()` — inside the async IIFE before
  `this.flushToDisk()`: `this.historian.closeProjectBursts(this.projectId, "flush");`
- `dispose()` — **first line after `this.disposed = true;`**:
  `this.historian.closeProjectBursts(this.projectId, "dispose");`

**3e. `broadcastCollabChange`:**

```ts
// CollaborationRoom
public broadcastCollabChange(ev: Record<string, unknown>): void {
  if (this.disposed) return;
  const frame = this.encodeCustom({ type: "collab_change", ...ev });
  for (const [client] of this.clients.entries()) {
    if (client.readyState !== 1) continue;
    try { client.send(frame); } catch { /* */ }
  }
}
```

```ts
// CollaborationManager
public broadcastCollabChange(projectId: string, ev: Record<string, unknown>): void {
  this.rooms.get(projectId)?.broadcastCollabChange(ev);
}
```

Wire the broadcaster once, where the manager is initialised (`index.ts`, Task 8):
`collaborationHistorian.setBroadcaster((pid, ev) => collaborationManager.broadcastCollabChange(pid, ev));`

**3f. Callout capture** — in `handleAttentionMessage`, in the
`input.kind === "callout"` branch, right after `this.broadcastAttention(event, ws)`:

```ts
this.historian.recordCallout({
  projectId: this.projectId, authorUserId: clientState.userId,
  username: clientState.username, filePath: activeFileRef, // the callout's file
  startLine: event.range.startLine, endLine: event.range.endLine,
  messagePreview: (event.message ?? "").slice(0, 120),
  targeted: false, at: now,
});
```
*(For a targeted `request`, `targeted: true` and use `input.file`.)*

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && npx vitest run test/m60-room-attribution.test.ts test/m60-historian.test.ts`

- [ ] **Step 5: Run the full collab regression**

Run: `cd backend && npx vitest run test/m4-collab test/m57-presence test/m58-attention test/collab test/m52 test/api.test.ts`
Expected: all PASS (no attribution logic changes any existing behavior — it only *reads* transactions). Then `npm run typecheck && npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/collab/manager.ts backend/src/collab/historian.ts backend/test/m60-room-attribution.test.ts backend/test/m60-historian.test.ts
git commit -m "feat(m60): attribute Yjs edit bursts + capture callouts in the room"
```

---

## Task 6: `timeline.ts` — read-side union

**Files:**
- Create: `backend/src/collab/timeline.ts`
- Test: `backend/test/m60-timeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TimelineEvent {
    id: string;                    // "<source>:<sourceId>"
    kind: "edit_burst" | "callout" | "run" | "commit" | "snapshot";
    at: string;                    // ISO ms — the sort key
    actor: { userId: number | null; username: string };
    filePath?: string;
    lineRange?: { startLine: number; endLine: number };
    title: string;
    subtitle?: string;
    navigable: boolean;
  }
  export interface TimelinePage { events: TimelineEvent[]; nextBefore: string | null; }
  export function queryTimeline(
    db: Db, projectId: string, opts: { limit?: number; before?: string | null; since?: string | null }
  ): TimelinePage;
  export function queryWhileAway(
    db: Db, projectId: string, callerUserId: number, since: string, maxEvents: number
  ): { since: string; events: TimelineEvent[] };
  export function encodeCursor(at: string, id: string): string;   // "<at>|<id>"
  export function decodeCursor(c: string): { at: string; id: string } | null;
  ```
- **Ordering:** `(at DESC, id DESC)` total order. **Pagination:** `before`
  cursor is strictly `(at,id) < cursor`. **Safe columns only** (spec §7.3).

- [ ] **Step 1: Failing tests**

```ts
// backend/test/m60-timeline.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { queryTimeline, queryWhileAway, encodeCursor, decodeCursor } from "../src/collab/timeline.js";

function seed(db: any) {
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (7,'rahul','h'),(8,'ankit','h')").run();
  db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',7,'P'),('q',8,'Q')").run();
  const cc = (id: string, at: string, kind = "edit_burst", uid = 7, file = "a.ts", proj = "p") =>
    db.prepare(`INSERT INTO collaboration_changes
      (id,project_id,author_user_id,file_path,kind,started_at,ended_at,update_count,lines_added,start_line,end_line,detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, proj, uid, file, kind, at, at, 3, 8,
           kind === "edit_burst" ? 40 : null, kind === "edit_burst" ? 48 : null,
           kind === "callout" ? JSON.stringify({ messagePreview: "look", targeted: false }) : null);
  cc("c1", "2026-08-31T10:00:00.000Z");
  cc("c2", "2026-08-31T10:05:00.000Z", "callout");
  cc("cX", "2026-08-31T10:99:00.000Z", "edit_burst", 8, "z.ts", "q"); // other project
  db.prepare(`INSERT INTO runs (id,project_id,user_id,language,file_path,status,exit_code,duration_ms,created_at)
    VALUES ('r1','p',7,'python','main.py','success',0,120,'2026-08-31T10:02:00.000Z')`).run();
  db.prepare(`INSERT INTO audit_logs (user_id,project_id,event_type,details,created_at)
    VALUES (7,'p','GIT_COMMIT','${JSON.stringify({ shortHash: 'abc123', subjectPreview: 'Fix login UI' }).replace(/'/g, "''")}','2026-08-31T10:03:00.000Z')`).run();
  db.prepare(`INSERT INTO audit_logs (user_id,project_id,event_type,details,created_at)
    VALUES (8,'p','SNAPSHOT_RESTORED','${JSON.stringify({ name: 'pre-refactor' })}','2026-08-31T10:04:00.000Z')`).run();
}

describe("timeline union", () => {
  let db: any;
  beforeEach(() => { db = openDb(":memory:"); seed(db); });

  it("unions all five sources for one project, newest first", () => {
    const { events } = queryTimeline(db, "p", { limit: 50 });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["edit_burst", "callout", "run", "commit", "snapshot"]));
    // strictly descending by at
    const ats = events.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it("never returns another project's rows", () => {
    const { events } = queryTimeline(db, "p", { limit: 50 });
    expect(events.every((e) => !e.id.includes("cX"))).toBe(true);
  });

  it("stable pagination — no entry on two pages, none skipped", () => {
    const page1 = queryTimeline(db, "p", { limit: 2 });
    const page2 = queryTimeline(db, "p", { limit: 2, before: page1.nextBefore });
    const ids = new Set(page1.events.map((e) => e.id));
    expect(page2.events.every((e) => !ids.has(e.id))).toBe(true);
    const all = queryTimeline(db, "p", { limit: 50 }).events.map((e) => e.id);
    expect([...page1.events, ...page2.events].map((e) => e.id)).toEqual(all.slice(0, 4));
  });

  it("run events carry only safe fields (no stdout/stderr/signal keys)", () => {
    const run = queryTimeline(db, "p", { limit: 50 }).events.find((e) => e.kind === "run")!;
    expect(run.title).toMatch(/main\.py/);
    expect(JSON.stringify(run)).not.toMatch(/stdout|stderr|signal|peak_memory/);
  });

  it("commit title uses subjectPreview", () => {
    const c = queryTimeline(db, "p", { limit: 50 }).events.find((e) => e.kind === "commit")!;
    expect(c.title).toContain("Fix login UI");
    expect(c.navigable).toBe(false);
  });

  it("limit is clamped to [1,100]", () => {
    expect(queryTimeline(db, "p", { limit: 9999 }).events.length).toBeLessThanOrEqual(100);
    expect(() => queryTimeline(db, "p", { limit: 0 })).not.toThrow();
  });

  it("while-away excludes the caller's own events and honours since", () => {
    const r = queryWhileAway(db, "p", 7, "2026-08-31T10:02:30.000Z", 50);
    expect(r.events.every((e) => e.actor.userId !== 7)).toBe(true);
    expect(r.events.every((e) => e.at > "2026-08-31T10:02:30.000Z")).toBe(true);
  });

  it("cursor round-trips", () => {
    const c = encodeCursor("2026-08-31T10:00:00.000Z", "collab:c1");
    expect(decodeCursor(c)).toEqual({ at: "2026-08-31T10:00:00.000Z", id: "collab:c1" });
    expect(decodeCursor("garbage")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd backend && npx vitest run test/m60-timeline.test.ts`

- [ ] **Step 3: Implement `timeline.ts`**

Full implementation — 5 explicitly-columned queries, map to `TimelineEvent`,
merge-sort, paginate. Key points:

```ts
// backend/src/collab/timeline.ts
import type { Db } from "../db.js";

export interface TimelineEvent {
  id: string;
  kind: "edit_burst" | "callout" | "run" | "commit" | "snapshot";
  at: string;
  actor: { userId: number | null; username: string };
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  title: string;
  subtitle?: string;
  navigable: boolean;
}
export interface TimelinePage { events: TimelineEvent[]; nextBefore: string | null; }

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number) =>
  Math.max(lo, Math.min(hi, Number.isFinite(n as number) ? (n as number) : dflt));

export function encodeCursor(at: string, id: string): string { return `${at}|${id}`; }
export function decodeCursor(c: string): { at: string; id: string } | null {
  const i = c.indexOf("|");
  if (i < 0) return null;
  return { at: c.slice(0, i), id: c.slice(i + 1) };
}
// total order: at DESC, id DESC
function cmp(a: TimelineEvent, b: TimelineEvent): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
function beforePredicate(cur: { at: string; id: string } | null) {
  return (e: TimelineEvent) => !cur || (e.at < cur.at || (e.at === cur.at && e.id < cur.id));
}

function relFile(p: string): string { return p.split("/").pop() || p; }

export function queryTimeline(
  db: Db, projectId: string,
  opts: { limit?: number; before?: string | null; since?: string | null },
): TimelinePage {
  const limit = clamp(opts.limit, 1, 100, 40);
  const cur = opts.before ? decodeCursor(opts.before) : null;
  const since = opts.since ?? "0000-01-01T00:00:00.000Z";
  const fetch = limit + 1;
  const out: TimelineEvent[] = [];

  // 1. collaboration_changes
  for (const r of db.prepare(`
    SELECT cc.id, cc.author_user_id, cc.file_path, cc.kind, cc.ended_at,
           cc.update_count, cc.lines_added, cc.lines_removed, cc.start_line, cc.end_line, cc.detail,
           u.username
    FROM collaboration_changes cc LEFT JOIN users u ON u.id = cc.author_user_id
    WHERE cc.project_id = ? AND cc.ended_at > ?
    ORDER BY cc.ended_at DESC, cc.id DESC LIMIT ?
  `).all(projectId, since, fetch) as any[]) {
    const id = `collab:${r.id}`;
    const lineRange = r.start_line != null && r.end_line != null
      ? { startLine: r.start_line, endLine: r.end_line } : undefined;
    const detail = r.detail ? safeParse(r.detail) : null;
    out.push({
      id, kind: r.kind, at: r.ended_at,
      actor: { userId: r.author_user_id ?? null, username: r.username ?? "(removed user)" },
      filePath: r.file_path, lineRange,
      title: r.kind === "callout"
        ? "left a callout"
        : lineRange
          ? `changed lines ${lineRange.startLine}–${lineRange.endLine}`
          : `changed ${relFile(r.file_path)}` +
            (r.lines_added + r.lines_removed > 0 ? ` (~${r.lines_added + r.lines_removed} lines)` : ""),
      subtitle: r.kind === "callout" ? String(detail?.messagePreview ?? "") : undefined,
      navigable: true,
    });
  }

  // 2. runs (SAFE COLUMNS ONLY)
  for (const r of db.prepare(`
    SELECT r.id, r.user_id, r.language, r.file_path, r.status, r.exit_code, r.created_at, u.username
    FROM runs r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.project_id = ? AND r.created_at > ?
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?
  `).all(projectId, since, fetch) as any[]) {
    const ok = r.status === "success" && (r.exit_code === 0 || r.exit_code == null);
    out.push({
      id: `run:${r.id}`, kind: "run", at: r.created_at,
      actor: { userId: r.user_id ?? null, username: r.username ?? "(removed user)" },
      filePath: r.file_path,
      title: `ran ${relFile(r.file_path)} — ${
        r.status === "success" ? `exit ${r.exit_code ?? 0}`
        : r.status === "cancelled" ? "cancelled"
        : r.status === "timeout" ? "timed out"
        : r.status === "killed" ? "killed" : "failed"}`,
      navigable: true, // opens the file
    });
  }

  // 3. GIT_COMMIT
  for (const r of db.prepare(`
    SELECT a.id, a.user_id, a.details, a.created_at, u.username
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.project_id = ? AND a.event_type = 'GIT_COMMIT' AND a.created_at > ?
    ORDER BY a.created_at DESC, a.id DESC LIMIT ?
  `).all(projectId, since, fetch) as any[]) {
    const d = safeParse(r.details) ?? {};
    out.push({
      id: `commit:${r.id}`, kind: "commit", at: r.created_at,
      actor: { userId: r.user_id ?? null, username: r.username ?? "(removed user)" },
      title: `committed "${String(d.subjectPreview ?? "").slice(0, 120)}"`,
      subtitle: d.shortHash ? String(d.shortHash) : undefined,
      navigable: false,
    });
  }

  // 4. SNAPSHOT_CREATED / SNAPSHOT_RESTORED
  for (const r of db.prepare(`
    SELECT a.id, a.user_id, a.event_type, a.details, a.created_at, u.username
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.project_id = ? AND a.event_type IN ('SNAPSHOT_CREATED','SNAPSHOT_RESTORED') AND a.created_at > ?
    ORDER BY a.created_at DESC, a.id DESC LIMIT ?
  `).all(projectId, since, fetch) as any[]) {
    const d = safeParse(r.details) ?? {};
    const restored = r.event_type === "SNAPSHOT_RESTORED";
    out.push({
      id: `snap:${r.id}`, kind: "snapshot", at: r.created_at,
      actor: { userId: r.user_id ?? null, username: r.username ?? "(removed user)" },
      title: `${restored ? "restored" : "created"} snapshot${d.name ? ` "${String(d.name).slice(0, 80)}"` : ""}`,
      navigable: false,
    });
  }

  out.sort(cmp);
  const filtered = out.filter(beforePredicate(cur));
  const page = filtered.slice(0, limit);
  const nextBefore = filtered.length > limit && page.length > 0
    ? encodeCursor(page[page.length - 1].at, page[page.length - 1].id) : null;
  return { events: page, nextBefore };
}

export function queryWhileAway(
  db: Db, projectId: string, callerUserId: number, since: string, maxEvents: number,
): { since: string; events: TimelineEvent[] } {
  const { events } = queryTimeline(db, projectId, { limit: Math.min(maxEvents, 100), since });
  const meaningful = new Set(["edit_burst", "callout", "run", "commit", "snapshot"]);
  return {
    since,
    events: events.filter((e) => e.actor.userId !== callerUserId && meaningful.has(e.kind)),
  };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && npx vitest run test/m60-timeline.test.ts`

- [ ] **Step 5: Typecheck + lint**

- [ ] **Step 6: Commit**

```bash
git add backend/src/collab/timeline.ts backend/test/m60-timeline.test.ts
git commit -m "feat(m60): timeline read-model — safe-column union of 5 sources"
```

---

## Task 7: REST endpoints + authorization

**Files:**
- Modify: `backend/src/projects/routes.ts` (3 routes)
- Test: `backend/test/m60-timeline-api.test.ts` (use `startTestApi` from `test/helpers.ts`)

**Interfaces:**
- Consumes: `queryTimeline`, `queryWhileAway` (Task 6); `getLastSeen`,
  `touchLastSeen` (Task 3); `requireProjectAccess` (existing).
- Produces:
  - `GET /api/projects/:id/collab/timeline?limit=&before=` → `TimelinePage`
  - `GET /api/projects/:id/collab/while-away` → `{ since, events, groupedByAuthor }`
  - `POST /api/projects/:id/collab/while-away/ack` `{ upTo }` → `{ ok: true }`

- [ ] **Step 1: Failing tests**

```ts
// backend/test/m60-timeline-api.test.ts — sketch; follow api.test.ts patterns
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApi, type TestApi } from "./helpers.js";

describe("M60 timeline API", () => {
  let api: TestApi;
  beforeAll(async () => { api = await startTestApi(); });
  afterAll(async () => { await api.close(); });

  it("timeline requires viewer access; non-member gets 403/404", async () => {
    const owner = await api.registerAndLogin("owner");
    const stranger = await api.registerAndLogin("stranger");
    const proj = await api.createProject(owner, "P");
    const r = await api.fetch(`/api/projects/${proj.id}/collab/timeline`, { token: stranger.token });
    expect([403, 404]).toContain(r.status);
    const ok = await api.fetch(`/api/projects/${proj.id}/collab/timeline`, { token: owner.token });
    expect(ok.status).toBe(200);
    expect(Array.isArray((await ok.json()).events)).toBe(true);
  });

  it("a collaborator (viewer) can read; revoked cannot", async () => {
    const owner = await api.registerAndLogin("o2");
    const collab = await api.registerAndLogin("c2");
    const proj = await api.createProject(owner, "P2");
    await api.addCollaborator(owner, proj.id, "c2", "viewer");
    let r = await api.fetch(`/api/projects/${proj.id}/collab/timeline`, { token: collab.token });
    expect(r.status).toBe(200);
    await api.removeCollaborator(owner, proj.id, "c2");
    r = await api.fetch(`/api/projects/${proj.id}/collab/timeline`, { token: collab.token });
    expect([403, 404]).toContain(r.status);
  });

  it("while-away ack advances last_seen so a second call returns []", async () => {
    const owner = await api.registerAndLogin("o3");
    const proj = await api.createProject(owner, "P3");
    // ... insert a collaboration_changes row via api.db for another user ...
    const first = await api.fetch(`/api/projects/${proj.id}/collab/while-away`, { token: owner.token });
    const body = await first.json();
    if (body.events.length) {
      await api.fetch(`/api/projects/${proj.id}/collab/while-away/ack`, {
        method: "POST", token: owner.token, body: { upTo: body.events[0].at },
      });
      const second = await (await api.fetch(`/api/projects/${proj.id}/collab/while-away`, { token: owner.token })).json();
      expect(second.events.length).toBe(0);
    }
  });

  it("cross-project isolation", async () => {
    const u = await api.registerAndLogin("o4");
    const a = await api.createProject(u, "A");
    const b = await api.createProject(u, "B");
    // insert a change for project B, assert A's timeline never shows it
    // ... via api.db ...
  });
});
```

*(Extend `test/helpers.ts` with `addCollaborator` / `removeCollaborator` /
`db` accessor helpers if not present — small, fold into this task.)*

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement the routes** (in `projects/routes.ts`, near `/:id/runs`)

```ts
import { queryTimeline, queryWhileAway } from "../collab/timeline.js";
import { getLastSeen, touchLastSeen } from "../collab/lastSeen.js";
// ...
router.get("/:id/collab/timeline", (req, res, next) => {
  try {
    requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
    const limit = parseInt(String(req.query.limit ?? ""), 10);
    const before = typeof req.query.before === "string" ? req.query.before : null;
    res.json(queryTimeline(db, req.params.id, { limit, before }));
  } catch (err) { next(err); }
});

router.get("/:id/collab/while-away", (req, res, next) => {
  try {
    const user = userOf(req);
    requireProjectAccess(db, user.id, req.params.id, "viewer");
    const stored = getLastSeen(db, req.params.id, user.id);
    const clampBoundary = new Date(Date.now() - cfg.collabAwayMaxLookbackMs).toISOString();
    const since = stored && stored > clampBoundary ? stored : clampBoundary;
    const { events } = queryWhileAway(db, req.params.id, user.id, since, cfg.collabAwayMaxEvents);
    // group by author, most-recent-author first
    const byAuthor = new Map<number, typeof events>();
    for (const e of events) {
      const k = e.actor.userId ?? -1;
      (byAuthor.get(k) ?? byAuthor.set(k, []).get(k)!).push(e);
    }
    const groupedByAuthor = [...byAuthor.entries()]
      .map(([userId, evs]) => ({ userId, username: evs[0].actor.username, events: evs }))
      .sort((a, b) => (b.events[0]?.at ?? "").localeCompare(a.events[0]?.at ?? ""));
    res.json({ since, events, groupedByAuthor });
  } catch (err) { next(err); }
});

router.post("/:id/collab/while-away/ack", (req, res, next) => {
  try {
    const user = userOf(req);
    requireProjectAccess(db, user.id, req.params.id, "viewer");
    const upTo = typeof req.body?.upTo === "string" ? req.body.upTo : new Date().toISOString();
    touchLastSeen(db, req.params.id, user.id, upTo);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
```

*(Confirm `cfg` is in scope in this router factory — `projectRoutes(cfg, db)`
signature; if not, thread it.)*

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Full API regression** — `cd backend && npx vitest run test/api.test.ts test/m60-timeline-api.test.ts` + `npm run typecheck && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add backend/src/projects/routes.ts backend/test/m60-timeline-api.test.ts backend/test/helpers.ts
git commit -m "feat(m60): collab timeline + while-away REST endpoints (viewer-authorized)"
```

---

## Task 8: Lifecycle wiring — startup init, graceful shutdown, disposeProject

**Files:**
- Modify: `backend/src/index.ts` (startup + `performGracefulShutdown`)
- Modify: `backend/src/projects/service.ts` (`deleteProject`)
- Modify: `backend/src/backup/workspaceRestore.ts` (beside `telemetryHistorian.disposeProject`)
- Test: `backend/test/m60-lifecycle.test.ts`

**Interfaces:**
- Consumes: `collaborationHistorian`, `collaborationManager`.

- [ ] **Step 1: Failing test**

```ts
// backend/test/m60-lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { performGracefulShutdown } from "../src/index.js";
import { collaborationHistorian } from "../src/collab/historian.js";
// ... spin a minimal server via the test harness used by index tests ...

describe("M60 lifecycle", () => {
  it("graceful shutdown flushes buffered bursts", async () => {
    // arrange: init historian, record an edit (open burst), do NOT flush
    // act: performGracefulShutdown(...)
    // assert: the row is in collaboration_changes
  });
  it("deleteProject disposes historian project state and cascades rows", async () => {
    // insert a change row + open burst for project p; deleteProject(p);
    // assert: row gone (cascade), open burst count for p is 0
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Wire startup** — in `backend/src/index.ts` where `telemetryHistorian.init(db, config)` is called:

```ts
import { collaborationHistorian } from "./collab/historian.js";
import { collaborationManager } from "./collab/manager.js";
// ...after collaborationManager.init(config, db):
collaborationHistorian.init(db, config);
collaborationHistorian.setBroadcaster((pid, ev) =>
  collaborationManager.broadcastCollabChange(pid, ev as Record<string, unknown>));
```

- [ ] **Step 4: Wire shutdown** — in `performGracefulShutdown` step 0, next to `telemetryHistorian.stop()`:

```ts
try { collaborationHistorian.stop(); }
catch (err) { console.error("[shutdown] collaboration historian stop failed:", err); }
```

- [ ] **Step 5: Wire disposeProject** — in `backend/src/projects/service.ts`
`deleteProject`, next to the existing sandbox teardown (and any
`telemetryHistorian.disposeProject` call):

```ts
import { collaborationHistorian } from "../collab/historian.js";
// ...
collaborationHistorian.disposeProject(id);
```

And in `backend/src/backup/workspaceRestore.ts:307` beside
`telemetryHistorian.disposeProject(projectId)`:

```ts
collaborationHistorian.disposeProject(projectId);
```

**Also wire first-connect last-seen** — in `backend/src/ws/index.ts`, inside the
`/ws/collab` `wss.handleUpgrade` callback, immediately after
`room.addClient(ws, { userId: row.id, username: row.username, role: accessRole });`:

```ts
import { insertLastSeenIfAbsent } from "../collab/lastSeen.js";
// ...
insertLastSeenIfAbsent(db, projectId, row.id);
```

Add to the Task 8 test: a first-time collaborator connecting to `/ws/collab`
gets exactly one `collab_last_seen` row (and a second connect does not add another).

- [ ] **Step 6: Run — expect PASS.** Then `cd backend && npx vitest run` (full backend suite) + `npm run typecheck && npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.ts backend/src/projects/service.ts backend/src/backup/workspaceRestore.ts backend/test/m60-lifecycle.test.ts
git commit -m "feat(m60): historian startup init, graceful-shutdown flush, disposeProject wiring"
```

---

## Task 9: Frontend — `client.ts` receive branch + reconnect-gap signal + types + api

**Files:**
- Modify: `frontend/src/collab/client.ts`
- Modify: `frontend/src/types.ts` (`TimelineEvent`, `CollabChangeWire`)
- Modify: `frontend/src/api.ts` (3 helpers)
- Test: `frontend/test/collab.change.client.test.ts`

**Interfaces:**
- Produces: `client.on("collab_change", (ev: CollabChangeWire) => …)`,
  `client.on("reconnected_after_gap", (info: { offlineMs: number }) => …)`.
  `fetchCollabTimeline(projectId, { limit?, before? })`,
  `fetchWhileAway(projectId)`, `ackWhileAway(projectId, upTo)`.

- [ ] **Step 1: Failing test**

```ts
// frontend/test/collab.change.client.test.ts
import { describe, it, expect, vi } from "vitest";
import * as encoding from "lib0/encoding";
import { CollaborationClient } from "../src/collab/client";

const MESSAGE_CUSTOM = 3;
function customFrame(obj: unknown): ArrayBuffer {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_CUSTOM);
  encoding.writeVarString(e, JSON.stringify(obj));
  return encoding.toUint8Array(e).buffer;
}

describe("client collab_change", () => {
  it("emits collab_change on a well-formed frame; ignores malformed", () => {
    const c = new (CollaborationClient as any)("proj", { id: 1, name: "me", color: "#fff" });
    const spy = vi.fn();
    c.on("collab_change", spy);
    (c as any).handleMessage(new Uint8Array(customFrame({
      type: "collab_change", id: "collab:x", kind: "edit_burst",
      at: "2026-08-31T10:00:00.000Z", actor: { userId: 7, username: "rahul" },
      filePath: "a.ts", lineRange: null, updateCount: 2, linesAdded: 3, linesRemoved: 0,
    })));
    expect(spy).toHaveBeenCalledOnce();
    (c as any).handleMessage(new Uint8Array(customFrame({ type: "collab_change", actor: 123 })));
    expect(spy).toHaveBeenCalledOnce(); // malformed ignored
  });

  it("client has no method that SENDS a collab_change frame", () => {
    const src = CollaborationClient.toString();
    expect(src).not.toMatch(/type:\s*["']collab_change["']/); // never authored
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`frontend/src/types.ts` — add (identical to backend `timeline.ts`):

```ts
export interface TimelineEvent {
  id: string;
  kind: "edit_burst" | "callout" | "run" | "commit" | "snapshot";
  at: string;
  actor: { userId: number | null; username: string };
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  title: string;
  subtitle?: string;
  navigable: boolean;
}
export interface CollabChangeWire {
  type: "collab_change";
  id: string; kind: "edit_burst" | "callout"; at: string;
  actor: { userId: number; username: string };
  filePath: string;
  lineRange: { startLine: number; endLine: number } | null;
  updateCount: number; linesAdded: number; linesRemoved: number;
  calloutPreview?: string;
}
```

`frontend/src/collab/client.ts`:
- In `case MESSAGE_CUSTOM`, add a branch (after the `attention_rate_limited` one):
  ```ts
  } else if (
    parsed && parsed.type === "collab_change" &&
    typeof parsed.id === "string" &&
    parsed.actor && typeof parsed.actor.userId === "number" &&
    typeof parsed.filePath === "string" &&
    (parsed.kind === "edit_burst" || parsed.kind === "callout")
  ) {
    this.emit("collab_change", parsed);
  }
  ```
- Add `private disconnectedAt: number | null = null;`
- In `this.ws.onclose`, after `this.setStatus("disconnected")`:
  `if (this.disconnectedAt === null) this.disconnectedAt = Date.now();`
- In `this.ws.onopen`, at the very top:
  ```ts
  if (this.disconnectedAt !== null) {
    const offlineMs = Date.now() - this.disconnectedAt;
    this.disconnectedAt = null;
    this.emit("reconnected_after_gap", { offlineMs });
  }
  ```

`frontend/src/api.ts` — add:

```ts
export async function fetchCollabTimeline(
  projectId: string, opts: { limit?: number; before?: string | null } = {},
): Promise<{ events: TimelineEvent[]; nextBefore: string | null }> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  return apiFetch(`/api/projects/${projectId}/collab/timeline?${q}`);
}
export async function fetchWhileAway(projectId: string): Promise<{
  since: string; events: TimelineEvent[];
  groupedByAuthor: { userId: number; username: string; events: TimelineEvent[] }[];
}> {
  return apiFetch(`/api/projects/${projectId}/collab/while-away`);
}
export async function ackWhileAway(projectId: string, upTo: string): Promise<void> {
  await apiFetch(`/api/projects/${projectId}/collab/while-away/ack`, {
    method: "POST", body: JSON.stringify({ upTo }),
  });
}
```
*(match the existing `apiFetch` wrapper signature in `api.ts`.)*

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Frontend typecheck** — `cd frontend && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/collab/client.ts frontend/src/types.ts frontend/src/api.ts frontend/test/collab.change.client.test.ts
git commit -m "feat(m60): client collab_change receive + reconnect-gap signal + api helpers"
```

---

## Task 10: Frontend — pure `timeline.ts` helpers

**Files:**
- Create: `frontend/src/collab/timeline.ts`
- Test: `frontend/test/collab.timeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function formatTimelineEvent(ev: TimelineEvent, now: number):
    { time: string; actor: string; text: string; navigable: boolean };
  export function mergeTimeline(prev: TimelineEvent[], incoming: TimelineEvent[], cap?: number): TimelineEvent[];
  export function groupWhileAway(events: TimelineEvent[]):
    { username: string; userId: number | null; lines: string[]; events: TimelineEvent[] }[];
  export function whileAwayLine(ev: TimelineEvent): string; // per-event line used inside a group ("edited auth/session.ts"); the run fail→pass collapse is done in groupWhileAway
  export function wireToTimelineEvent(w: CollabChangeWire): TimelineEvent;
  ```

- [ ] **Step 1: Failing tests**

```ts
// frontend/test/collab.timeline.test.ts
import { describe, it, expect } from "vitest";
import { formatTimelineEvent, mergeTimeline, groupWhileAway, wireToTimelineEvent } from "../src/collab/timeline";
import type { TimelineEvent } from "../src/types";

const ev = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "collab:1", kind: "edit_burst", at: "2026-08-31T10:00:00.000Z",
  actor: { userId: 7, username: "rahul" }, filePath: "src/auth/session.ts",
  title: "changed lines 40–52", navigable: true, ...over,
});

describe("frontend timeline helpers", () => {
  it("mergeTimeline de-dupes by id, sorts desc, caps", () => {
    const merged = mergeTimeline([ev({ id: "a", at: "2026-08-31T10:00:00.000Z" })],
      [ev({ id: "a", at: "2026-08-31T10:00:00.000Z" }), ev({ id: "b", at: "2026-08-31T11:00:00.000Z" })], 10);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("mergeTimeline cap drops oldest", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      ev({ id: `e${i}`, at: `2026-08-31T1${i}:00:00.000Z` }));
    expect(mergeTimeline([], many, 3).map((e) => e.id)).toEqual(["e4", "e3", "e2"]);
  });

  it("formatTimelineEvent produces relative time + safe text", () => {
    const f = formatTimelineEvent(ev(), Date.parse("2026-08-31T10:00:30.000Z"));
    expect(f.actor).toBe("rahul");
    expect(f.text).toContain("changed lines 40");
    expect(f.time).toMatch(/30s|just now/);
  });

  it("groupWhileAway groups by author, newest author first, collapses run fail→pass", () => {
    const events = [
      ev({ id: "1", actor: { userId: 7, username: "rahul" }, at: "2026-08-31T10:10:00.000Z" }),
      ev({ id: "2", kind: "run", actor: { userId: 8, username: "aman" }, at: "2026-08-31T10:05:00.000Z", title: "ran main.py — failed", filePath: "main.py" }),
      ev({ id: "3", kind: "run", actor: { userId: 8, username: "aman" }, at: "2026-08-31T10:06:00.000Z", title: "ran main.py — exit 0", filePath: "main.py" }),
    ];
    const g = groupWhileAway(events);
    expect(g[0].username).toBe("rahul"); // most recent event
    const aman = g.find((x) => x.username === "aman")!;
    expect(aman.lines.some((l) => /failed.*passed|→ passed/.test(l))).toBe(true);
  });

  it("wireToTimelineEvent maps a wire frame", () => {
    const t = wireToTimelineEvent({
      type: "collab_change", id: "collab:9", kind: "edit_burst", at: "2026-08-31T10:00:00.000Z",
      actor: { userId: 7, username: "rahul" }, filePath: "a.ts", lineRange: null,
      updateCount: 4, linesAdded: 8, linesRemoved: 2,
    });
    expect(t.navigable).toBe(true);
    expect(t.title).toMatch(/changed/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** `frontend/src/collab/timeline.ts` — pure functions, reuse `formatRelativeTime` from `collab/presence.ts` if present, else a small local one. Implement `groupWhileAway` with the fail→pass collapse (same-file, consecutive run events by the same author within the group).

- [ ] **Step 4: Run — expect PASS.** Then `cd frontend && npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/collab/timeline.ts frontend/test/collab.timeline.test.ts
git commit -m "feat(m60): pure frontend timeline helpers (format, merge, group)"
```

---

## Task 11: Frontend — `ActivityTimeline.tsx` + TeamPanel integration

**Files:**
- Create: `frontend/src/components/Collab/ActivityTimeline.tsx`
- Modify: `frontend/src/components/Collab/TeamPanel.tsx`
- Modify: `frontend/src/styles/collab.css`
- Test: `frontend/test/ActivityTimeline.test.tsx`, extend `frontend/test/TeamPanel.test.tsx`

**Interfaces:**
- Consumes: `TimelineEvent[]`, `formatTimelineEvent`.
- Produces: `<ActivityTimeline events onLoadMore hasMore onNavigate />`.
  `TeamPanel` gains props `timeline: TimelineEvent[]`, `timelineHasMore: boolean`,
  `onTimelineLoadMore: () => void`, `onTimelineNavigate: (ev: TimelineEvent) => void`.

- [ ] **Step 1: Failing test**

```tsx
// frontend/test/ActivityTimeline.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as React from "react";
import ActivityTimeline from "../src/components/Collab/ActivityTimeline";
import type { TimelineEvent } from "../src/types";

const ev = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "collab:1", kind: "edit_burst", at: new Date().toISOString(),
  actor: { userId: 7, username: "rahul" }, filePath: "src/auth/session.ts",
  title: "changed lines 40–52", navigable: true, ...o,
});

afterEach(cleanup);

describe("ActivityTimeline", () => {
  it("renders rows with actor + title", () => {
    render(<ActivityTimeline events={[ev(), ev({ id: "collab:2", kind: "commit", title: 'committed "Fix"', navigable: false, filePath: undefined })]}
      hasMore={false} onLoadMore={() => {}} onNavigate={() => {}} />);
    expect(screen.getByText(/rahul/)).toBeTruthy();
    expect(screen.getByText(/changed lines 40/)).toBeTruthy();
    expect(screen.getByText(/committed "Fix"/)).toBeTruthy();
  });

  it("clicking a navigable row calls onNavigate; non-navigable does not", () => {
    const nav = vi.fn();
    render(<ActivityTimeline events={[ev({ id: "n1" }), ev({ id: "n2", navigable: false, filePath: undefined, kind: "commit", title: "committed" })]}
      hasMore={false} onLoadMore={() => {}} onNavigate={nav} />);
    fireEvent.click(screen.getByText(/changed lines 40/));
    expect(nav).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/committed/));
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it("[Show more] calls onLoadMore when hasMore", () => {
    const more = vi.fn();
    render(<ActivityTimeline events={[ev()]} hasMore onLoadMore={more} onNavigate={() => {}} />);
    fireEvent.click(screen.getByText(/show more/i));
    expect(more).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `ActivityTimeline.tsx`** — a `<div className="team-activity-timeline">` with a `TEAM ACTIVITY` header, mapped rows (`formatTimelineEvent`), a 1 Hz `now` ticker local to the component, `[Show more]` button gated on `hasMore`, row `onClick={() => ev.navigable && onNavigate(ev)}`, `role="button"` on navigable rows.

- [ ] **Step 4: Integrate into `TeamPanel.tsx`** — add the four props, render `<ActivityTimeline …/>` **after** the `team-folders` block. Update `TeamPanelProps`.

- [ ] **Step 5: CSS** — add `.team-activity-timeline`, `.tat-row`, `.tat-time`, `.tat-actor`, `.tat-text`, `.tat-more` to `collab.css` (compact, matching existing `.team-*` styling).

- [ ] **Step 6: Run** — `cd frontend && npx vitest run test/ActivityTimeline.test.tsx test/TeamPanel.test.tsx` + `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Collab/ActivityTimeline.tsx frontend/src/components/Collab/TeamPanel.tsx frontend/src/styles/collab.css frontend/test/ActivityTimeline.test.tsx frontend/test/TeamPanel.test.tsx
git commit -m "feat(m60): ActivityTimeline section inside TeamPanel"
```

---

## Task 12: Frontend — `WhileYouWereAway.tsx`

**Files:**
- Create: `frontend/src/components/Collab/WhileYouWereAway.tsx`
- Modify: `frontend/src/styles/collab.css`
- Test: `frontend/test/WhileYouWereAway.test.tsx`

**Interfaces:**
- Produces: `<WhileYouWereAway groups onNavigate onDismiss autoDismissMs />`
  where `groups` is `groupWhileAway`'s output.

- [ ] **Step 1: Failing test**

```tsx
// frontend/test/WhileYouWereAway.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import * as React from "react";
import WhileYouWereAway from "../src/components/Collab/WhileYouWereAway";

const groups = [
  { username: "rahul", userId: 7, lines: ["edited auth/session.ts"], events: [
    { id: "collab:1", kind: "edit_burst", at: new Date().toISOString(),
      actor: { userId: 7, username: "rahul" }, filePath: "auth/session.ts",
      title: "changed auth/session.ts", navigable: true } as any ] },
];

afterEach(cleanup);

describe("WhileYouWereAway", () => {
  it("renders grouped events and a header", () => {
    render(<WhileYouWereAway groups={groups} onNavigate={() => {}} onDismiss={() => {}} autoDismissMs={99999} />);
    expect(screen.getByText(/while you were away/i)).toBeTruthy();
    expect(screen.getByText(/rahul/)).toBeTruthy();
    expect(screen.getByText(/edited auth\/session\.ts/)).toBeTruthy();
  });

  it("Dismiss calls onDismiss", () => {
    const d = vi.fn();
    render(<WhileYouWereAway groups={groups} onNavigate={() => {}} onDismiss={d} autoDismissMs={99999} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(d).toHaveBeenCalled();
  });

  it("navigable row click calls onNavigate", () => {
    const nav = vi.fn();
    render(<WhileYouWereAway groups={groups} onNavigate={nav} onDismiss={() => {}} autoDismissMs={99999} />);
    fireEvent.click(screen.getByText(/changed auth\/session\.ts/));
    expect(nav).toHaveBeenCalled();
  });

  it("auto-dismisses after autoDismissMs", () => {
    vi.useFakeTimers();
    const d = vi.fn();
    render(<WhileYouWereAway groups={groups} onNavigate={() => {}} onDismiss={d} autoDismissMs={1000} />);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(d).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — compact fixed-position card (`.while-away-card`, styled like `.follow-left-notice`), a `WHILE YOU WERE AWAY` header, per-group blocks (color dot + username + `lines`), each event row navigable, `[Dismiss]` button, a `useEffect` auto-dismiss timer.

- [ ] **Step 4: Run + typecheck**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Collab/WhileYouWereAway.tsx frontend/src/styles/collab.css frontend/test/WhileYouWereAway.test.tsx
git commit -m "feat(m60): WhileYouWereAway reconnect card"
```

---

## Task 13: Frontend — IDE.tsx wiring (state, listeners, fetch, mounts)

**Files:**
- Modify: `frontend/src/components/IDE/IDE.tsx`
- Modify: `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` ("Last change:" line)
- Test: `frontend/test/IDE.timeline.test.tsx`, extend `frontend/test/CollaboratorAvatarStack.*`

**Interfaces:**
- Consumes: `fetchCollabTimeline`, `fetchWhileAway`, `ackWhileAway`,
  `mergeTimeline`, `wireToTimelineEvent`, `groupWhileAway`, `openAndRevealLocation`.

- [ ] **Step 1: Failing test**

```tsx
// frontend/test/IDE.timeline.test.tsx — follow the existing IDE.*.test.tsx source-slice + render conventions
import { describe, it, expect, vi } from "vitest";
// mock api.ts fetchCollabTimeline / fetchWhileAway / ackWhileAway
// mock revealLocation.openAndRevealLocation

describe("IDE M60 wiring", () => {
  it("fetches the timeline the first time the TeamPanel opens", async () => {
    // render IDE with a collab client stub, click the TeamPanel toggle,
    // assert fetchCollabTimeline called once with the project id
  });

  it("a collab_change event from the client is merged into the timeline", async () => {
    // emit "collab_change" on the stub client, assert the new row appears in TeamPanel activity
  });

  it("reconnected_after_gap over threshold fetches while-away and mounts the card", async () => {
    // emit "reconnected_after_gap" { offlineMs: 200000 }, mock fetchWhileAway → 1 group
    // assert <WhileYouWereAway> rendered
  });

  it("reconnected_after_gap under threshold does nothing", async () => {
    // emit { offlineMs: 5000 } → fetchWhileAway NOT called
  });

  it("dismissing while-away calls ackWhileAway with the newest event's at", async () => {});

  it("clicking a timeline row routes through openAndRevealLocation (open before reveal)", async () => {});
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement in `IDE.tsx`:**

- State: `const [timeline, setTimeline] = useState<TimelineEvent[]>([]);`
  `const [timelineNextBefore, setTimelineNextBefore] = useState<string | null>(null);`
  `const [timelineLoaded, setTimelineLoaded] = useState(false);`
  `const [whileAwayGroups, setWhileAwayGroups] = useState<…[] | null>(null);`
- Effect: when `teamPanelOpen` first becomes true and `!timelineLoaded`,
  `fetchCollabTimeline(project.id, { limit: 40 })` → `setTimeline`,
  `setTimelineNextBefore`, `setTimelineLoaded(true)`.
- `collabClient.on("collab_change", (w) => setTimeline((prev) =>
  mergeTimeline(prev, [wireToTimelineEvent(w)], 200)))` — in the existing
  collab-subscription effect; return the unsubscribe.
- `collabClient.on("reconnected_after_gap", async ({ offlineMs }) => {
    if (offlineMs < COLLAB_AWAY_THRESHOLD_MS_CLIENT) return;
    const r = await fetchWhileAway(project.id);
    if (r.events.length) setWhileAwayGroups(r.groupedByAuthor.map(g => ({
      username: g.username, userId: g.userId, events: g.events,
      lines: g.events.map(formatWhileAwayLine),
    })));
  })` — client threshold const mirrors the server default (180000); acceptable
  duplication (one number, documented).
- `handleTimelineLoadMore`: `fetchCollabTimeline(project.id, { limit: 40, before: timelineNextBefore })` → `setTimeline((p) => mergeTimeline(p, r.events, 400))`, update `nextBefore`.
- `handleTimelineNavigate(ev)`: `if (!ev.navigable || !ev.filePath) return;
  openAndRevealLocation(handleOpenFile, { filePath: ev.filePath,
  line: ev.lineRange?.startLine ?? 1, column: 1 });`
- `lastChangeByUser` memo: `useMemo(() => { const m = new Map<number, TimelineEvent>();
  for (const e of timeline) { if ((e.kind === "edit_burst" || e.kind === "callout")
  && e.actor.userId != null && !m.has(e.actor.userId)) m.set(e.actor.userId, e); } return m; }, [timeline])`
  (timeline is sorted desc so first-seen = newest).
- Pass `timeline`, `timelineNextBefore != null`, `handleTimelineLoadMore`,
  `handleTimelineNavigate` into `<TeamPanel …/>`.
- Pass `lastChangeByUser` into `<CollaboratorAvatarStack …/>`.
- Render `{whileAwayGroups && <WhileYouWereAway groups={whileAwayGroups}
  autoDismissMs={20000}
  onNavigate={handleTimelineNavigate}
  onDismiss={async () => {
    const newest = whileAwayGroups.flatMap(g => g.events)
      .reduce((a, b) => (a && a.at > b.at ? a : b), null as TimelineEvent | null);
    if (newest) await ackWhileAway(project.id, newest.at);
    setWhileAwayGroups(null);
  }} />}` near the other collab overlays.

`CollaboratorAvatarStack.tsx` — accept `lastChangeByUser?: Map<number, TimelineEvent>`;
in the popover, below the activity line, when an entry exists:
`<div className="collab-last-change">Last change: {formatTimelineEvent(entry, now).text} · {rel}</div>`.

- [ ] **Step 4: Run** — `cd frontend && npx vitest run test/IDE.timeline.test.tsx test/CollaboratorAvatarStack` + `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/IDE/IDE.tsx frontend/src/components/Collab/CollaboratorAvatarStack.tsx frontend/test/IDE.timeline.test.tsx frontend/test/CollaboratorAvatarStack.attention.test.tsx
git commit -m "feat(m60): IDE wiring — timeline state, live merge, while-away, last-change line"
```

---

## Task 14: Full regression + browser acceptance + STATUS.md

**Files:**
- Modify: `STATUS.md`
- Test: all

- [ ] **Step 1: Backend full suite + typecheck + lint**

Run:
```bash
cd backend && npx vitest run && npm run typecheck && npm run lint
```
Expected: all pass. Record counts. Investigate any failure; a Docker-skipped
test is not a pass — report it as skipped.

- [ ] **Step 2: Frontend full suite + typecheck + lint + build**

Run:
```bash
cd frontend && npx vitest run && npx tsc --noEmit && npx eslint src/ && npm run build
```
Expected: all pass. Record counts.

- [ ] **Step 3: `git diff --check`; review `git diff` and `git diff --cached`**

Run: `git diff --check && git status --short`
Expected: clean (LF/CRLF advisories only).

- [ ] **Step 4: Browser acceptance (two authenticated sessions)** — run the spec §18 checklist (18 steps). Seed a fresh project + 2 collaborators via the REST API (pattern from the M59 closeout). For each step, capture evidence. Where the browser tooling blocks a step (ghosted presence / no controlled WS-disconnect, per the M59 closeout notes), fall back to the backend integration test that covers it and mark that step's **visual** verification PARTIAL with the concrete blocker — never claim green.

- [ ] **Step 5: Update `STATUS.md`**

Add a `## Milestone 60 — Change Attribution & Collaboration History` section:
objective, what M60 added (per-file list), the attribution mechanism summary,
burst semantics, schema, retention, timeline sources, while-away semantics, the
verification table (every gate + result), the acceptance matrix (every spec §17
category → PROVEN / PARTIAL + evidence), known limitations (deleted-line count
is approximate; range is best-effort; marathon-session while-away clamped to
24h; browser step N PARTIAL if applicable), and the M61 pointer (persistent
comments/threads). Do not rewrite M57/M58/M59 history.

- [ ] **Step 6: Commit**

```bash
git add STATUS.md
git commit -m "docs(m60): STATUS.md — M60 change attribution & collaboration history closeout"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §3 attribution pipeline | 2 (pure rules), 5 (`afterTransaction` hook + observer) |
| §4 burst grouping + close triggers | 2, 4 (historian close methods), 5 (room hooks) |
| §5 range derivation | 2 (`closeBurst` rule), 5 (`stashRange` contiguity) |
| §6 schema + historian | 1 (schema), 4 (historian) |
| §7 metadata allowlist | 4 (`recordCallout` detail), 6 (safe-column queries) |
| §8 transport (wire + REST) | 5 (`broadcastCollabChange`), 7 (REST), 9 (client receive) |
| §9 timeline read model + ordering + pagination | 6 |
| §10 while-away + last-seen | 3 (helpers), 7 (endpoints), 9 (reconnect signal), 13 (mount) |
| §11 frontend surfaces | 10 (pure), 11 (timeline), 12 (while-away), 13 (IDE + last-change) |
| §12 security/privacy/authz | 5, 6, 7 (all enforce it); tests in 6, 7 |
| §13 retention | 4 (`purgeExpired` + cap) |
| §14 config knobs | 1 |
| §16 edge-case matrix | 2 + 5 tests cover each row |
| §17 test strategy | every task is TDD; §17.9 regression = Task 5 Step 5 + Task 14 |
| §18 browser acceptance | Task 14 Step 4 |
| §20 files | matches the File Structure section above |

No gap.

**2. Placeholder scan** — the sketch-only test bodies in Tasks 7, 8, 13 contain
`// ...` comments describing setup that depends on `test/helpers.ts` internals
not visible here. These are marked as sketches with the exact assertions
spelled out; the executor fills the harness plumbing following the sibling
`api.test.ts` / `IDE.*.test.tsx` patterns. Every *behavioural assertion* is
concrete. Acceptable for tasks whose test harness is an existing shared helper.
No "TODO"/"implement later"/"add error handling" placeholders in implementation
code.

**3. Type consistency** — checked:
- `EditInput` / `OpenBurst` / `ClosedBurst` / `CloseReason` identical between
  Task 2 (defined) and Tasks 4, 5 (consumed).
- `CollabChangeWire` defined in Task 4 (`historian.ts`), re-declared identically
  in Task 9 (`frontend/src/types.ts`) with an added `type: "collab_change"`
  discriminant on the frontend copy — deliberate (the wire frame carries it;
  the backend builds it in `broadcastCollabChange`). Consistent.
- `TimelineEvent` identical in Task 6 (`backend/src/collab/timeline.ts`) and
  Task 9 (`frontend/src/types.ts`).
- `queryTimeline` / `queryWhileAway` / `encodeCursor` / `decodeCursor` — Task 6
  defines, Task 7 consumes with matching signatures.
- `touchLastSeen` / `getLastSeen` / `insertLastSeenIfAbsent` — Task 3 defines,
  Task 7 + `ws/index.ts` (Task references it; add to Task 8 or a note) consume.
  **Fix:** `insertLastSeenIfAbsent` is called from `ws/index.ts` `addClient` —
  that wiring is not in a task. **Added** to Task 8 Step 5 scope below.
- `collaborationHistorian.contaminateFile` — referenced in Task 5 Step 3c,
  defined as a "Task 4 follow-up" in the same step. **Fix:** move it into Task 4
  Step 3 explicitly (add the method + a unit test). Noted inline.
- `formatWhileAwayLine` — referenced in Task 13 Step 3, not defined. **Fix:**
  it is `groupWhileAway`'s per-event line formatting; expose it from
  `frontend/src/collab/timeline.ts` (Task 10) as
  `export function whileAwayLine(ev: TimelineEvent): string` and use that name
  in Task 13. Noted.

**Fixes applied inline:**
- Task 4 Step 3: add `contaminateFile(projectId, filePath)` + a test in
  `m60-historian.test.ts` ("external mutation contaminates the matching open burst").
- Task 8 Step 5: also add `insertLastSeenIfAbsent(db, projectId, row.id)` in
  `backend/src/ws/index.ts` inside the `/ws/collab` `handleUpgrade` callback,
  right after `room.addClient(...)`; add a line to the Task 8 test asserting a
  first-time collaborator gets a `collab_last_seen` row on connect.
- Task 10 Interfaces + Step 3: add `export function whileAwayLine(ev: TimelineEvent): string`;
  Task 13 uses `whileAwayLine` (not `formatWhileAwayLine`).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-31-m60-change-attribution-history.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?** — but per your instruction, **do not start implementation in this step.** Report first (below).
