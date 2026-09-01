# M60 — Change Attribution & Collaboration History

**Status:** design, approved with final constraints (2026-08-31). Not yet
implemented. Not committed.
**Date:** 2026-08-31
**Milestone type:** new subsystem. Adds a deterministic, metadata-only
collaboration-history layer on top of the existing Yjs collaboration room, plus
a read-side timeline that unions it with already-persisted execution / Git /
snapshot events. **Backend + frontend.** New SQLite tables (migration v11),
one new receive-only `MESSAGE_CUSTOM` wire event, two new REST reads. No LLM.
No change to the Yjs document model, the sync protocol, awareness, or the
typing hot path.

Spec + plan:
`docs/superpowers/specs/2026-08-31-m60-change-attribution-history-design.md`,
`docs/superpowers/plans/2026-08-31-m60-change-attribution-history.md`.

---

## 1. Product intent

M57: *"Rahul is here."* M58: *"Rahul can get my attention around this code."*
M59: *"I can enter Rahul's context and work beside him."* M60:

> "I can see what Rahul changed, what the team did, and what happened while I
> was away."

Concretely, three surfaces:

1. **Live change attribution** — a collaborator's popover / TeamPanel row shows
   their most recent meaningful change (`edited auth/session.ts · 30s ago`).
2. **Team Activity timeline** — a compact, chronological story of the project:
   edit bursts, runs, Git commits, callouts, snapshot/restore. Inside TeamPanel.
3. **While You Were Away** — on reconnect after a real absence, a dismissible
   card summarising the meaningful events since the user was last here, grouped
   by author, each navigable.

Everything is **deterministic** — burst grouping, counts, ranges, ordering.
No AI summarisation anywhere (that is a later milestone, if ever).

---

## 2. Existing architecture (verified against code, 2026-08-31)

### 2.1 Yjs transaction → identity (backend/src/collab/manager.ts)

| Fact | Location | Detail |
|---|---|---|
| Doc update hook | `CollaborationRoom` ctor, `this.doc.on("update", (update, origin) => …)` | arms persistence + queues broadcast. `origin === transaction.origin`. |
| Transaction hook | `this.doc.on("afterTransaction", (tr) => …)` | **already** iterates `tr.changed.keys()` (the changed `AbstractType`s), reverse-maps each to its top-level `doc.share` key (the file path), and calls `markFileDirty(key)`. Already skips `tr.origin === "external_mutation" \|\| "initial_disk_load"` and `tr.changed.size === 0`. |
| Client-edit origin | `handleMessage` → `case MESSAGE_SYNC` → `syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws)` | the 4th arg is the transaction origin. For a genuine client edit, **`tr.origin` is the `WebSocket` instance.** |
| ws → user | `this.clients.get(ws)` → `CollaboratorClientState { userId, username, role, activeFile }` | identity is the **authenticated session**, forced server-side (M55). Reconnect = new `ws`, **same `userId`**. |
| Viewer guard | `handleMessage` `case MESSAGE_SYNC` | edit updates from `role === "viewer"` are dropped before `readSyncMessage`. Every *applied* edit is from an editor/owner. |
| Server-origin transactions | `ensureFileLoaded` → `doc.transact(fn, "initial_disk_load")`; `handleExternalFileMutation` → `doc.transact(fn, "external_mutation")` | string origins, **must be excluded** from attribution. |
| Idempotent re-sync | Yjs 13.6.32 | re-applying already-known structs integrates nothing → `tr.changed.size === 0` → the existing guard returns. A reconnecting client re-sending its state vector / step-2 never produces spurious change events. |

### 2.2 Yjs event order (yjs 13.6.32, `cleanupTransactions`, verified in `dist/yjs.cjs`)

Within one synchronous `f.callAll(fs, [])` pass:

```
beforeObserverCalls
  → type observers  (Y.Text .observe() handlers fire HERE)
  → deep observers
  → afterTransaction        (emitted AFTER observers, same synchronous pass)
  → afterTransactionCleanup
  → update / updateV2        (carries [update, origin, doc, transaction])
```

So a Y.Text `.observe()` handler reliably runs **before** `afterTransaction`
in the same synchronous turn. M60 uses this ONLY to let the observer stash
range info that `afterTransaction` then drains by transaction-object identity —
never as a load-bearing ordering assumption: if the observer did not fire
(bare `AbstractType` for a file the server never `ensureFileLoaded`'d), the
stash is simply empty and the event is recorded file-level with
`line_range = NULL`.

### 2.3 Persistence reference — `TelemetryHistorian` (backend/src/execution/historian.ts)

The pattern M60 mirrors exactly:

- singleton, `init(db, cfg)`, started from `index.ts`;
- bounded in-memory hot state (`RingBuffer` / `Map`);
- `writeQueue: T[]` → `flushQueue()` writes one `BEGIN … COMMIT` batch;
- flush triggers: interval timer (`telemetryFlushIntervalMs`, 5 s), queue size
  (≥ 100), `stop()` (graceful shutdown, step 0 of `performGracefulShutdown`);
- `purgeExpiredSamples()` on a 15-min timer, retention from config
  (`telemetryRetentionHours`), `DELETE … WHERE created_at < datetime('now', '-N …')`;
- `disposeProject(projectId)` frees per-project memory; called from project
  delete and workspace restore (`backup/workspaceRestore.ts:307`).

### 2.4 Execution history — already persisted (backend/src/ws/execution.ts, `runs` table)

Per completed run, one row: `{ id, project_id, user_id, language, file_path,
status, exit_code, signal, duration_ms, peak_memory_bytes, created_at }`.
`status ∈ { success, error, cancelled, timeout, killed }`. **No stdout/stderr
ever touches this table.** M54 `notifyRunStatus` additionally broadcasts live
`running` / terminal state via `MESSAGE_CUSTOM` `run_status`. **M60 adds no
execution persistence — it reads `runs`.**

### 2.5 Git & snapshot history — already audited (backend/src/audit.ts, `audit_logs` table)

- `GIT_COMMIT` — `details = { shortHash, subjectPreview (≤120 chars) }`, plus
  `user_id`, `project_id`, `created_at`. (`git/routes.ts:169`.)
- `SNAPSHOT_CREATED`, `SNAPSHOT_RESTORED` — `user_id`, `project_id`,
  `created_at`, `details` (snapshot name / id).
- `audit_logs.project_id` is `ON DELETE SET NULL` (M33) — history survives
  project deletion at the audit layer; M60's timeline simply stops returning
  rows once the project is gone.
- `recordAuditLog` is a synchronous per-event write with a `REDACTED_KEYS`
  sanitiser. **M60 adds no new audit event types** — it reads a fixed subset.

### 2.6 Transport & client (frontend/src/collab/client.ts)

- `MESSAGE_CUSTOM` switch (both `manager.ts` and `client.ts`) is a plain
  extensible `if (parsed.type === …)` chain. `run_status` / `file_ready` /
  `external_mutation_notice` / `attention_event` are all **receive-only** on
  the client — a peer cannot author them. M60's `collab_change` joins that set.
- `client.on(event, handler)` / `emit(event, …)` event bus; `connection_change`
  emits status strings; M40 reconnect-class logic already distinguishes an
  explicit server dispose (`1001` while `connected`) from a network blip.

### 2.7 Authorization (backend/src/projects/service.ts)

`requireProjectAccess(db, userId, projectId, minRole)` → `{ project, role }` or
throws `ApiError(403|404)`. Owner, collaborator (`project_collaborators`), or
platform admin. Revocation takes effect on the next request. This is the single
gate for every M60 read (`minRole: "viewer"`).

### 2.8 Frontend collab surface

`IDE.tsx` owns `collabClientRef`, `collaborators`, `runStatuses`, `attention`,
`teamPanelOpen`, the M59 follow/anchor state, and `openAndRevealLocation`
(`utils/revealLocation.ts` — open strictly before reveal, closed-file safe).
`TeamPanel.tsx` renders people + context + `WORKING IN` folders.
`runActivity.ts` (`pickRunForUser`, `formatRunText`) is the shared run-phrasing
helper. M60 extends these; it does not add a third collab toolbar panel.

---

## 3. Change-attribution pipeline (highest-risk area)

```
inbound client edit (MESSAGE_SYNC, role ≠ viewer)
  → syncProtocol.readSyncMessage(…, this.doc, ws)         [existing]
  → Y.Doc transaction, origin = ws
  → Y.Text .observe(evt)   [NEW, best-effort]  →  stash { tr, filePath, delta }
  → doc.on("afterTransaction", tr)   [NEW hook in the EXISTING listener]
       if tr.origin is a WebSocket AND clients.get(tr.origin) exists
       AND tr.changed.size > 0:
         author = clients.get(tr.origin)          ← authoritative identity
         for each changed top-level key → filePath:
           rangeInfo = drainStash(tr, filePath)   ← best-effort, may be null
           collaborationHistorian.recordEdit({
             projectId, authorUserId: author.userId, username: author.username,
             filePath, at: Date.now(),
             ops: tr-derived op counts, rangeInfo
           })
  → CollaborationHistorian: extend-or-open the burst for
      key = `${projectId}:${authorUserId}:${filePath}`
```

### 3.1 `afterTransaction` is authoritative for **author** and **file-level change existence**

The new logic lives **inside the existing `afterTransaction` listener**, right
after the current dirty-file mapping loop — one mechanism, not a second
independent one. It reuses the exact same `tr.changed.keys()` → `doc.share`
reverse-lookup the dirty tracking already does.

Attribution rules — all four must hold or the transaction produces **no**
change event (it is still applied to the doc; it is just not attributed):

1. `tr.origin instanceof <ws WebSocket>` — i.e. not a string
   (`"initial_disk_load"`, `"external_mutation"`), not `null`, not the room's
   own doc, not an awareness origin (awareness never runs a doc transaction).
2. `this.clients.get(tr.origin)` resolves to a live `CollaboratorClientState`.
   (Defends the race where the socket was removed between message receipt and
   `afterTransaction`.)
3. `tr.changed.size > 0` — idempotent re-sync of known structs changes nothing.
4. `!this.disposed`.

Multiple files in one transaction: the loop over `tr.changed` produces **one
`recordEdit` per file**, each independently attributed to the same author.
(y-monaco binds one model at a time so this is rare, but a merged catch-up
update or a multi-file programmatic edit is handled correctly.)

### 3.2 Range enrichment is **best-effort only** (`Y.Text.observe`)

An observer is attached to a file's `Y.Text` **once**, inside `ensureFileLoaded`,
immediately after the `safeResolve` + `assertInsideWorkspace` guard passes and
the real `this.doc.getText(filePath)` handle is obtained:

```
if (!this.rangeObservedFiles.has(filePath)) {
  yText.observe(evt => this.stashRange(evt));   // evt.transaction, evt.delta, evt.target
  this.rangeObservedFiles.add(filePath);
}
```

- **Idempotent** — the `Set<string>` guard prevents a second observer when a
  popular file is `file_open`'d many times. (Leak-safe: `doc.destroy()` in
  `dispose()` removes every observer; the room is then discarded.)
- **Never attached to a detached Y.Text** — `ensureFileLoaded` returns a bare
  `new Y.Text()` for a path that escapes the workspace; that branch returns
  *before* the observe block.
- `stashRange(evt)` reverse-maps `evt.target` → filePath, computes the affected
  character span from `evt.delta` (Quill-style `{retain}|{insert}|{delete}`),
  converts offsets → 1-based line numbers against `evt.target.toString()`
  (post-transaction content), and pushes
  `{ startLine, endLine, added, removed, contiguous }` into
  `Map<Y.Transaction, Map<filePath, RangeAccumulator>>`.
- `afterTransaction` calls `drainStash(tr, filePath)` and then deletes the
  `tr` entry from the map (so the map never retains transactions — it is
  populated and drained within one synchronous turn; a `WeakMap` keyed by `tr`
  is the implementation, with an explicit `delete` for promptness).

If the stash has no entry for `(tr, filePath)` (observer never fired), the
`recordEdit` gets `rangeInfo = null` and the burst can still carry file-level
attribution and op counts (op counts come from the observer's delta when
present; when absent the burst still records `updateCount++` and
`lines*` stay 0 — a file-level "changed" event).

### 3.3 Op-count derivation

`linesAdded` / `linesRemoved` per burst are summed from each transaction's
delta: count `\n` in every `{insert}` string (→ added) and, for `{delete: n}`,
the newline count in the *deleted* substring (captured in `stashRange` from
`evt.target` state *before* the change is applied — Yjs `.observe` fires after
apply, so deleted-substring newline counts are derived from
`evt.changes.deleted` items where available, else the deleted char count only
and `linesRemoved` is left approximate-but-bounded; when it cannot be derived
cleanly the burst records `updateCount` only). `updateCount` = number of
transactions folded into the burst. These are advisory human context, never
security-relevant; a slightly conservative count is acceptable, a fabricated
range is not.

---

## 4. Burst grouping semantics (exact)

### 4.1 Burst key

```
burstKey = `${projectId}:${authorUserId}:${filePath}`
```

Author identity is `userId` — **never** `clientId` / `ws`. A reconnect (new
socket, new Yjs clientID, same `userId`) continues the same logical burst if it
is still open and within the idle window.

### 4.2 Extend conditions (ALL must hold)

A `recordEdit` extends the open burst for its `burstKey` iff:

- same `projectId`, same `authorUserId`, same `filePath` (guaranteed by the key), **and**
- `now - burst.lastEditAt ≤ COLLAB_BURST_IDLE_MS` (default `15000`), **and**
- `now - burst.startedAt ≤ COLLAB_BURST_MAX_MS` (default `300000`).

Extend = `burst.lastEditAt = now`, `burst.endedAt = now`, `updateCount++`,
accumulate `lines*`, fold `rangeInfo` (see §5).

If any condition fails, the existing burst is **closed** (enqueued for
persistence) and a **new** burst is opened for the same key from this edit.

### 4.3 Close triggers (a burst is enqueued for persistence when)

| Trigger | Mechanism |
|---|---|
| Idle gap exceeded | detected lazily on the next `recordEdit` for the key, **and** proactively by a sweep timer (`COLLAB_BURST_SWEEP_MS`, default `5000`) so a burst with no follow-up edit still closes ~one idle-window late |
| Max burst age exceeded | same lazy + sweep detection |
| **Different author** edits the same `filePath` | on `recordEdit`, before opening/extending this author's burst, any *other* author's open burst for the same `projectId:*:filePath` is closed and flagged `rangeContaminated = true` (see §5) |
| Persistence / flush-to-disk boundary | `CollaborationRoom.flushToDisk()` and `flushBeforeDestructiveDispose()` call `collaborationHistorian.closeProjectBursts(projectId, "flush")` before/after writing — every open burst for the project is closed so history and disk agree |
| Author disconnects | `CollaborationRoom.removeClient(ws)` → `collaborationHistorian.closeAuthorBursts(projectId, userId, "disconnect")` (only when that user has no other live socket in the room) |
| Room disposes | `CollaborationRoom.dispose()` → `collaborationHistorian.closeProjectBursts(projectId, "dispose")` (synchronous, before `doc.destroy()`) |
| Project disposes / deleted | `service.deleteProject` / `workspaceRestore` → `collaborationHistorian.disposeProject(projectId)` closes+flushes then drops in-memory state; the DB rows then cascade-delete with the project row |
| Graceful shutdown | `collaborationHistorian.stop()` in `performGracefulShutdown` step 0 → close every open burst, drain the write queue synchronously |

### 4.4 Invariants (tested)

- A burst is **never** merged across authors (different `authorUserId` ⇒
  different key ⇒ impossible).
- A burst is **never** merged across files (different `filePath` ⇒ different key).
- A burst **cannot stay open forever** — `COLLAB_BURST_MAX_MS` + the sweep timer
  guarantee closure even with continuous typing.
- One session of continuous work on one file by one author = potentially several
  bursts (each ≤ 5 min), never one giant burst.
- The in-memory open-burst map is bounded by
  `(active rooms) × (collaborators) × (open files)` — realistically dozens;
  a hard cap `COLLAB_OPEN_BURSTS_MAX` (default `5000`) force-closes the oldest
  if ever exceeded (belt-and-suspenders).

---

## 5. Range-derivation semantics (exact)

A closed burst persists `start_line` / `end_line` **only** when ALL hold:

1. Every folded transaction produced a stash entry (no observer miss in the burst).
2. Every transaction's affected span was a **single contiguous region** —
   `evt.delta` had exactly one change cluster (one leading `{retain}` then only
   `{insert}`/`{delete}` with no further `{retain}` gap before end).
3. The union of all transactions' spans across the burst is itself **one
   contiguous line interval** — `max(endLine) - min(startLine)` equals the
   covered set with no gap (tracked as a set of touched line intervals merged
   as we fold; if merge yields >1 interval ⇒ not contiguous).
4. `rangeContaminated === false` — no *other* author edited this file while this
   burst was open (set by the different-author close trigger, §4.3; also set if
   an `external_mutation` / `initial_disk_load` transaction touched the file
   mid-burst).

Otherwise `start_line = end_line = NULL` and the event renders file-level
(`"Rahul changed 8 lines · auth/session.ts"` using `linesAdded+linesRemoved`,
or just `"Rahul edited auth/session.ts"` when counts are unavailable).

**A burst spanning multiple non-contiguous regions is `NULL`, not
`min..max`.** Never claim a range that wasn't a single edited block.

---

## 6. Persistence — migration v11

```sql
CREATE TABLE collaboration_changes (
  id             TEXT PRIMARY KEY,                    -- randomUUID
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path      TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'edit_burst',  -- 'edit_burst' | 'callout'
  started_at     TEXT NOT NULL,                       -- ISO, ms precision
  ended_at       TEXT NOT NULL,
  update_count   INTEGER NOT NULL DEFAULT 0,
  lines_added    INTEGER NOT NULL DEFAULT 0,
  lines_removed  INTEGER NOT NULL DEFAULT 0,
  start_line     INTEGER,                             -- NULL ⇒ file-level only
  end_line       INTEGER,
  detail         TEXT,                                -- JSON, ALLOWLISTED (§7). NULL for plain bursts.
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_collab_changes_project_ended
  ON collaboration_changes(project_id, ended_at DESC, id DESC);

CREATE TABLE collab_last_seen (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,                         -- ISO, ms precision
  PRIMARY KEY (project_id, user_id)
);
```

Migration `version: 11` in `db.ts` `MIGRATIONS[]`, mirroring the inline
`CREATE TABLE IF NOT EXISTS` in `openDb()` (both, per the file's own
convention). Transactional, idempotent.

### 6.1 `CollaborationHistorian` (backend/src/collab/historian.ts)

```
class CollaborationHistorian {
  init(db, cfg)
  recordEdit(input)                     // extend/open burst; pure routing to changeAttribution
  recordCallout(input)                  // enqueue a kind='callout' row directly (no burst)
  closeAuthorBursts(projectId, userId, reason)
  closeProjectBursts(projectId, reason)
  disposeProject(projectId)             // close+flush+drop
  flushQueue()                          // one BEGIN..COMMIT batch
  purgeExpired()                        // retention, on a 15-min timer
  stop()                               // close all + flush; graceful shutdown
  // live push:
  private onBurstClosed(change) -> collaborationManager.broadcastCollabChange(projectId, toWireEvent(change))
}
```

- Open bursts: `Map<burstKey, OpenBurst>`.
- `writeQueue: CollaborationChange[]`; `flushQueue` on `COLLAB_HISTORY_FLUSH_INTERVAL_MS`
  (default `5000`) timer, at queue ≥ 100, and from `stop()`.
- `purgeExpired`: `DELETE FROM collaboration_changes WHERE ended_at < datetime('now','-{COLLAB_HISTORY_RETENTION_DAYS} days')`
  then, per project that got a new row this cycle,
  `DELETE FROM collaboration_changes WHERE project_id = ? AND id NOT IN (SELECT id FROM collaboration_changes WHERE project_id = ? ORDER BY ended_at DESC, id DESC LIMIT {COLLAB_HISTORY_MAX_PER_PROJECT})`.
  Both statements are single, indexed, bounded.
- **No duplicate persistence**: a burst has one identity for its lifetime; it is
  enqueued exactly once (on close) and removed from the open map in the same
  step. `flushQueue` drains and clears atomically (copy-then-clear like
  `TelemetryHistorian`).
- Reconnect cannot duplicate: attribution is by `userId`; a reconnecting
  author's edits extend the still-open burst or open a fresh one — never
  re-emit a closed one.

### 6.2 `changeAttribution.ts` (backend/src/collab/changeAttribution.ts, pure)

`openBurst`, `extendBurst`, `shouldCloseBurst(burst, now, cfg)`,
`foldRange(acc, rangeInfo)`, `resolveBurstRange(acc)` (→ `{startLine,endLine}|null`
per §5), `summarizeBurst(burst)`. No `db`, no `Y.*` runtime imports (types only),
no timers. Fully unit-testable in isolation — this is where every §4/§5 rule
is proven.

---

## 7. Metadata allowlist (explicit)

### 7.1 `collaboration_changes` — MAY persist

`author_user_id`, `project_id`, `file_path`, `kind`, `started_at`, `ended_at`,
`update_count`, `lines_added`, `lines_removed`, `start_line`, `end_line`, and
`detail` limited to:

- `kind='callout'`: `{ messagePreview: string (≤120, already sanitised by M58
  parseAttentionInput), targeted: boolean }`.
- `kind='edit_burst'`: `detail` is `NULL` (all its data is in typed columns).

### 7.2 MUST NOT persist (anywhere in M60)

Full file content, full or partial diff bodies, Yjs updates, Yjs snapshots,
per-edit document state, cursor positions/trails, selection ranges/trails,
keystroke history, terminal contents, stdout, stderr, environment variables,
project secrets, command bodies, arbitrary raw client payloads, IP addresses,
awareness frames. No field outside §7.1 is written. `detail` is built
field-by-field on the server, never `JSON.stringify(clientPayload)`.

### 7.3 Timeline source queries — explicit safe columns only

Never `SELECT *` from `runs` or `audit_logs`. Exact projections:

```sql
-- runs
SELECT id, user_id, language, file_path, status, exit_code, created_at
FROM runs WHERE project_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT ?;

-- git commits
SELECT id, user_id, details, created_at
FROM audit_logs
WHERE project_id = ? AND event_type = 'GIT_COMMIT' AND created_at > ?
ORDER BY created_at DESC, id DESC LIMIT ?;
-- from details JSON, read ONLY: shortHash, subjectPreview

-- snapshots
SELECT id, user_id, event_type, details, created_at
FROM audit_logs
WHERE project_id = ? AND event_type IN ('SNAPSHOT_CREATED','SNAPSHOT_RESTORED') AND created_at > ?
ORDER BY created_at DESC, id DESC LIMIT ?;
-- from details JSON, read ONLY: name (snapshot label)
```

`runs.file_path` is safe (it is a workspace-relative path the user chose to
run, already surfaced in the M54 live run status). `exit_code` / `status` are
safe high-level metadata. `signal`, `peak_memory_bytes`, `duration_ms`,
`stdout*`, `stderr*` are **not selected**.

---

## 8. Transport

### 8.1 Live push — `MESSAGE_CUSTOM` `collab_change` (receive-only)

On burst close (and on callout record), `CollaborationHistorian` →
`collaborationManager.broadcastCollabChange(projectId, ev)` →
`room.broadcastCollabChange(ev)` which JSON-frames
`{ type: "collab_change", ...TimelineEvent }` and sends to every open client
(no exclusions — the author seeing their own change land in the timeline is
correct). Mirrors `broadcastRunStatus` exactly.

Client (`client.ts` `case MESSAGE_CUSTOM`): new branch
`parsed.type === "collab_change"` with a shape guard (`typeof actor.userId ===
"number"`, `typeof filePath === "string" | undefined`, `kind` in a known set) →
`this.emit("collab_change", parsed)`. **Receive-only** — the client never
constructs or sends this type, so a modified peer cannot forge history (same
guarantee as `run_status`). `IDE.tsx` listens, appends to a bounded
`timeline: TimelineEvent[]` state (cap ~200, drop oldest).

### 8.2 Pull — two REST reads (both `requireProjectAccess(…, "viewer")`)

```
GET /api/projects/:id/collab/timeline?limit=&before=
      → { events: TimelineEvent[], nextBefore: string | null }
GET /api/projects/:id/collab/while-away
      → { since: string, events: TimelineEvent[], grouped: {...} }
POST /api/projects/:id/collab/while-away/ack   { upTo: string }
      → { ok: true }   // advances collab_last_seen for the caller
```

Registered in `projects/routes.ts` alongside `/:id/runs` etc. `limit` clamped
`[1, 100]`, default 40. `before` is an opaque cursor `"<ended_at>|<id>"` for
stable pagination (§9.3).

---

## 9. Timeline read model & union (backend/src/collab/timeline.ts)

### 9.1 `TimelineEvent` (normalised, read-side only)

```ts
type TimelineEvent = {
  id: string;                       // "<source>:<sourceId>" — globally unique
  kind: "edit_burst" | "callout" | "run" | "commit" | "snapshot";
  at: string;                       // ISO ms — the sort key (ended_at / created_at)
  actor: { userId: number; username: string };
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  title: string;                    // server-composed, deterministic, safe
  subtitle?: string;
  navigable: boolean;               // true ⇒ has filePath (± lineRange)
};
```

`title` is composed server-side from safe fields
(`"changed 8 lines"`, `"ran main.py — exit 0"`, `'committed "Fix login UI"'`,
`"restored snapshot \"pre-refactor\""`, `"left a callout"`). The client may
re-phrase relative time but never needs raw source rows.

### 9.2 Union

`queryTimeline(db, projectId, { limit, before })`:

1. Run the ≤ 5 source queries (§7.3 + `collaboration_changes`), each with its
   own `LIMIT (limit + 1)` and the `before` cursor translated to a
   `(<field> , <id>) <` predicate.
2. Map each row → `TimelineEvent` (join `users` for `username`; drop rows whose
   user was deleted — `author_user_id`/`user_id` NULL after cascade — or render
   `actor.username = "(removed user)"`, decided: render as removed, keep the
   event).
3. Merge-sort by `(at DESC, id DESC)`, take `limit`, compute `nextBefore` from
   the last returned event.

Callouts: `kind='callout'` rows in `collaboration_changes` are already in the
`collaboration_changes` query — no separate source.

### 9.3 Deterministic ordering & stable pagination

- Primary sort `at` (ISO string, ms precision) **DESC**.
- Tie-break `id` (`"<source>:<sourceId>"`) **DESC** — total order, stable.
- The `before` cursor encodes `(at, id)` of the last item on the previous
  page; the next page is strictly `(at, id) < cursor` under the same total
  order. Two events with identical `at` never straddle a page boundary
  ambiguously and never swap pages between requests (the DB rows are immutable
  once written; retention only deletes from the tail).
- Page size bounded (`≤ 100`). Response is bounded.

### 9.4 Project isolation

Every source query has `WHERE project_id = ?` as its first predicate, backed by
an index (`idx_collab_changes_project_ended`, `idx_runs_project`,
`idx_audit_project`). No query scans another project's rows. No post-filtering
of a broad result set.

---

## 10. While You Were Away

### 10.1 Last-seen semantics (`collab_last_seen`)

**Update points (never per-heartbeat):**

| When | Value |
|---|---|
| `CollaborationRoom.removeClient(ws)` — and that `userId` now has **no** other live socket in the room | `last_seen_at = now` (definitive session-end boundary) |
| `POST /collab/while-away/ack { upTo }` | `last_seen_at = max(current, upTo)` — the user acknowledged the card |
| First ever connect to a project (no row) | insert `last_seen_at = now` on `addClient` **only if the row is absent** — a first-time collaborator has no "away" backlog |

Not updated on `addClient` when a row exists (that would erase the boundary
before the client can read it), not on ws ping/pong, not on awareness updates.

### 10.2 Query

`GET /collab/while-away` for `(projectId, callerUserId)`:

```
since = max( collab_last_seen[projectId][callerUserId] ?? (now - COLLAB_AWAY_MAX_LOOKBACK_MS),
             now - COLLAB_AWAY_MAX_LOOKBACK_MS )          // clamp, default 24h
events = queryTimeline(projectId, { since, limit: COLLAB_AWAY_MAX_EVENTS=50 })
         filtered to kinds that are "meaningful for a returning user":
           edit_burst, callout, run (terminal only), commit, snapshot
         excluding events whose actor.userId === callerUserId
grouped = group events by actor, ordered by author's most-recent event,
          each author's events newest-first, run events collapsed
          ("ran tests — failed → passed" when a fail is followed by a pass
           on the same file within the window)
```

Empty `events` ⇒ the client shows nothing.

### 10.3 Trigger (client)

`client.ts` tracks `disconnectedAt` (set on transition to `disconnected`).
On the transition back to `connected`, if
`now - disconnectedAt > COLLAB_AWAY_THRESHOLD_MS` (default `180000` = 3 min),
emit `reconnected_after_gap`. `IDE.tsx` listens → `GET /collab/while-away` →
if `events.length` mount `<WhileYouWereAway>`. The **client gap** is only the
*trigger*; the **server `last_seen`** is the authoritative content boundary.

### 10.4 No duplicate after repeated refresh/reconnect

- On dismiss (or on an explicit "mark all seen"), the client calls
  `POST /collab/while-away/ack { upTo: <newest shown event.at> }`.
- `last_seen_at` advances past everything shown.
- A refresh 10 s later → reconnect → gap < threshold (or `while-away` returns
  `[]` because `since` is now `> newest event`). Either way: nothing shown twice.
- If the user never dismisses and just navigates away, `removeClient` sets
  `last_seen_at = now`, so the next session starts clean.

---

## 11. Frontend surfaces

### 11.1 `ActivityTimeline.tsx` — inside TeamPanel

A new collapsible section **below** the people roster and the `WORKING IN`
folders in `TeamPanel.tsx` (no new panel, no new toolbar button — TeamPanel
stays the single multiplayer hub: *people + context + activity*).

```
TEAM ACTIVITY
10:41  Rahul   changed auth/session.ts
10:44  Rahul   left a callout · auth/session.ts L40–52
10:46  Priya   committed "Fix login UI"
10:48  Aman    ran tests — passed
        [ Show more ]
```

- Fed by `IDE.tsx` `timeline` state = merge of the initial
  `GET /collab/timeline` (on first TeamPanel open) + live `collab_change`
  events, de-duped by `event.id`, sorted by `(at, id)` desc, bounded ~200.
- `[Show more]` pages via `GET …?before=nextBefore`.
- 1 Hz relative-time ticker local to the mounted panel (same pattern as the
  existing `TeamPanel` `now` state).
- Row click: `navigable ? openAndRevealLocation(handleOpenFile, { filePath,
  line: lineRange?.startLine ?? 1, column: 1 }) : no-op`. Exact path — open
  strictly before reveal, closed-file safe.

### 11.2 `WhileYouWereAway.tsx` — dismissible reconnect card

Compact card (not a dashboard), fixed-position like the M59 `.follow-left-notice`.
Grouped by author (§10.2). Each event row navigable via `openAndRevealLocation`.
`[Dismiss]` → `POST …/ack` + unmount. Auto-dismiss after
`COLLAB_AWAY_NOTICE_MS` (default `20000`) also acks.

### 11.3 Live "last change" on the collaborator popover / TeamPanel row

`IDE.tsx` derives `lastChangeByUser: Map<number, TimelineEvent>` from the
`timeline` state (newest `edit_burst`/`callout` per `actor.userId`). Passed to
`CollaboratorAvatarStack` popover and `TeamPanel` rows:

```
Rahul
Last change: edited auth/session.ts · 30s ago
```

No line attribution shown here unless `lineRange` is present on that event.
Absent entirely when the user has no change in the loaded window.

### 11.4 `frontend/src/collab/timeline.ts` (pure)

`TimelineEvent` type (hand-synced with backend, per repo convention),
`formatTimelineEvent(ev, now)` → `{ time, actor, text, navigable }`,
`groupWhileAway(events)` → author-grouped structure, `mergeTimeline(prev, incoming)`
(de-dupe by id, sort, cap). No React. Unit-tested.

---

## 12. Security / privacy model

| Concern | Mitigation |
|---|---|
| Wrong author on a change | Author is **always** `this.clients.get(tr.origin).userId` — the authenticated WS session (M55-forced). `tr.origin` is the `ws` for real client edits; string origins are excluded; a missing `clients` entry ⇒ no event. Never a client-asserted identity, never a `clientId`. |
| Forged `collab_change` from a peer | Receive-only on the client (like `run_status`); the client has no code path that sends this type. Server only emits from `CollaborationHistorian`. |
| Sensitive content in history | §7 allowlist — typed columns + a 3-field `detail` for callouts. No content, diff, output, secret, cursor, or selection is written. Source queries select explicit safe columns (§7.3), never `SELECT *`. |
| Cross-project leak | Every query is `WHERE project_id = ?` first, indexed; union is per-project; no broad-then-filter. |
| Unauthorized read | `requireProjectAccess(db, callerId, projectId, "viewer")` on all three endpoints; 403/404 for non-members; revoked collaborator loses access on the next request. No frontend-only filtering. |
| Project deletion | `ON DELETE CASCADE` on both new tables; `disposeProject` clears memory; audit-sourced timeline rows stop returning once the project row is gone. |
| Deleted user | `author_user_id` cascades to delete of `collaboration_changes` rows; audit rows keep `user_id` NULL (existing SET NULL) → rendered `"(removed user)"`. |
| Callout → chat creep | callout history is a single immutable metadata row (`messagePreview ≤120`), no reply, no thread, no edit. Persistent comments are M61. |
| Surveillance | Nothing sub-"meaningful engineering event" is recorded. No keystroke/cursor/selection/heartbeat/navigation is a source. Retention is 14 days. |
| Hot-path DB write | `afterTransaction` does **zero** I/O — it routes to an in-memory accumulator. DB writes are batched every 5 s / 100 rows. No per-keystroke, per-transaction, or per-cursor write anywhere. |

---

## 13. Retention & lifecycle

- Time: `DELETE … WHERE ended_at < now - COLLAB_HISTORY_RETENTION_DAYS` (14).
- Count: keep newest `COLLAB_HISTORY_MAX_PER_PROJECT` (2000) per project.
- Cadence: 15-min `purgeExpired` timer (unref'd), plus opportunistic on flush.
- Both statements single + indexed + bounded.
- `runs` / `audit_logs` retention is **unchanged** (M60 owns neither).
- `collab_last_seen` rows cascade with project/user; a stale row is harmless
  (just an old `since` clamped by `COLLAB_AWAY_MAX_LOOKBACK_MS`).

---

## 14. Config knobs (backend/src/config.ts, `overrides.X ?? Number(process.env.X ?? default)`)

| Key | Env | Default |
|---|---|---|
| `collabBurstIdleMs` | `COLLAB_BURST_IDLE_MS` | `15000` |
| `collabBurstMaxMs` | `COLLAB_BURST_MAX_MS` | `300000` |
| `collabBurstSweepMs` | `COLLAB_BURST_SWEEP_MS` | `5000` |
| `collabHistoryFlushIntervalMs` | `COLLAB_HISTORY_FLUSH_INTERVAL_MS` | `5000` |
| `collabHistoryRetentionDays` | `COLLAB_HISTORY_RETENTION_DAYS` | `14` |
| `collabHistoryMaxPerProject` | `COLLAB_HISTORY_MAX_PER_PROJECT` | `2000` |
| `collabAwayThresholdMs` | `COLLAB_AWAY_THRESHOLD_MS` | `180000` |
| `collabAwayMaxLookbackMs` | `COLLAB_AWAY_MAX_LOOKBACK_MS` | `86400000` |
| `collabAwayMaxEvents` | `COLLAB_AWAY_MAX_EVENTS` | `50` |
| `collabAwayNoticeMs` | `COLLAB_AWAY_NOTICE_MS` | `20000` |
| `collabOpenBurstsMax` | `COLLAB_OPEN_BURSTS_MAX` | `5000` |

---

## 15. Non-goals (explicit)

Persistent comments / threads / mentions / reactions / chat (M61). AI / LLM
summarisation of changes. Semantic conflict resolution. Full diff or content
history / time-travel / blame-per-line. Cursor or selection history. Raw
terminal / stdout / stderr persistence. A generic audit-log viewer. Analytics
dashboards. Making M58 callouts themselves persistent. Changing `runs` /
`audit_logs` schema or retention. Any Yjs document-model, sync-protocol, or
awareness change. Any write on the typing hot path.

---

## 16. Edge-case matrix (attribution — constraint #1)

| Scenario | Behaviour |
|---|---|
| Multiple files in one transaction | `tr.changed` loop → one `recordEdit` per file, same author. Each file's burst independent. |
| Concurrent collaborators, different files | Separate `burstKey`s (different file, different author) — fully independent. |
| Concurrent collaborators, same file | Two `burstKey`s (different author). First author's burst is closed with `rangeContaminated=true` when the second author's edit arrives → that burst persists file-level (range NULL). Second author's burst opens fresh. |
| Rapid successive edits (one author, one file) | Fold into one burst until idle gap or max age; `updateCount` counts transactions. |
| Interleaved authors on one file (A,B,A,B…) | Each switch closes the other's open burst (`rangeContaminated`). Result: a sequence of short file-level bursts, correctly attributed, no merged/contaminated ranges. |
| Disconnect mid-burst | `removeClient` (last socket for that user) → `closeAuthorBursts` → burst persists with data so far. |
| Reconnect, same user, within idle window | New socket, same `userId` → next edit finds the still-open burst (if within `COLLAB_BURST_IDLE_MS` of `lastEditAt`) and extends it; else opens a fresh burst. Never duplicates. |
| Reconnect after idle window | Fresh burst. Previous burst already closed by the sweep timer or the disconnect trigger. |
| Document initialization / initial disk load | `doc.transact(fn, "initial_disk_load")` → `tr.origin` is a string → excluded. No event. Also excluded from `rangeContaminated`? No — an `initial_disk_load` mid-session (shouldn't happen; `ensureFileLoaded` only seeds an empty Y.Text once) would still be treated as contamination for safety. |
| External filesystem mutation (REST save, Replace-All, Git checkout, AI apply, snapshot restore) | `doc.transact(fn, "external_mutation")` → excluded from attribution; **sets `rangeContaminated=true`** on any open burst for that file (a bystander's disk write changed the file under the author). The mutation is separately surfaced by the existing M56 `external_mutation_notice` and, if it was a Git checkout / snapshot restore, by the timeline's audit source. |
| Room disposal (idle, forbidden, destructive) | `dispose()` → synchronous `closeProjectBursts(projectId,"dispose")` before `doc.destroy()`. Queue drained on the next flush / shutdown. |
| Project deletion | `disposeProject` closes+flushes+drops; DB rows cascade. |
| Viewer attempts an edit | Blocked in `handleMessage` before `readSyncMessage` — never reaches attribution. |
| Awareness-only update (cursor move, presence) | Not a doc transaction — `afterTransaction` never fires. Zero history impact. |
| `tr.changed.size === 0` (idempotent re-sync) | Existing guard returns early. No event. |

---

## 17. Test strategy (behavioural, defined before implementation)

### 17.1 `changeAttribution.ts` (pure unit — `backend/test/m60-change-attribution.test.ts`)
- correct authenticated author on the burst
- same author + same file within idle window ⇒ one burst; `updateCount` accurate
- idle-gap exceeded ⇒ split into two bursts
- max-age exceeded ⇒ split (even with no idle gap — continuous typing)
- different author on same file ⇒ prior burst closes, `rangeContaminated`
- different file ⇒ separate burst
- multi-region transaction ⇒ range NULL
- contiguous single-region burst ⇒ range `{startLine,endLine}` exact
- burst folding two contiguous adjacent regions ⇒ range spans both; a gap ⇒ NULL
- `external_mutation` / `initial_disk_load` mid-burst ⇒ `rangeContaminated`
- `linesAdded`/`linesRemoved` counts from newline math
- no observer stash for a transaction in the burst ⇒ range NULL, event still valid

### 17.2 `CollaborationHistorian` (`backend/test/m60-historian.test.ts`, in-memory `:memory:` db)
- `recordEdit` routes to burst; close enqueues exactly one row
- batched write: N closes in a window ⇒ one `BEGIN..COMMIT`
- queue ≥ 100 ⇒ immediate flush
- `stop()` closes all open bursts + flushes (no buffered loss)
- `closeProjectBursts` / `closeAuthorBursts` / `disposeProject` semantics
- reconnect (same userId, new "socket") attribution — no duplicate row
- retention: time purge + per-project cap, both bounded; a fresh row survives
- open-burst map bounded; `COLLAB_OPEN_BURSTS_MAX` force-close
- `recordCallout` writes a `kind='callout'` row with only allowlisted `detail`

### 17.3 Room integration (`backend/test/m60-room-attribution.test.ts`, real `CollaborationRoom` + fake sockets)
- two authenticated sockets edit → correct per-user bursts
- viewer edit blocked ⇒ no history
- `external_mutation` ⇒ no attributed event, open burst contaminated
- `flushToDisk` closes open bursts; disk + history agree on file set
- `removeClient` (last socket) closes that author's bursts
- `dispose()` closes all synchronously

### 17.4 `timeline.ts` (`backend/test/m60-timeline.test.ts`)
- union of all five sources, one project
- deterministic `(at DESC, id DESC)` ordering; identical timestamps stable
- pagination: `before` cursor, no entry appears on two pages, none skipped
- page size clamped `[1,100]`
- **safe fields only** — assert the mapper never reads `stdout*`/`stderr*`/
  `signal`/`peak_memory_bytes` / secret columns; assert `SELECT` column lists
- project filtering — a second project's rows never appear
- deleted user ⇒ `"(removed user)"`, event retained

### 17.5 Last-seen + while-away (`backend/test/m60-while-away.test.ts`)
- `last_seen` set on `removeClient` (last socket only), on `ack`, on first connect
- **not** set on `addClient` when a row exists, not on repeated pings
- `while-away` `since` = last_seen, clamped to `COLLAB_AWAY_MAX_LOOKBACK_MS`
- only meaningful kinds; caller's own events excluded
- grouping by author; run fail→pass collapse
- `ack` advances `last_seen`; a second `while-away` returns `[]` — **no dup**
- repeated reconnect within threshold ⇒ no re-trigger

### 17.6 Authorization (`backend/test/m60-authz.test.ts`)
- non-member ⇒ 403/404 on all three endpoints
- viewer ⇒ allowed
- revoked collaborator ⇒ denied on the next call
- project A member cannot read project B timeline
- project delete ⇒ rows gone (cascade), endpoint 404

### 17.7 Wire (`backend/test/m60-wire.test.ts` + `frontend/test/collab.change.client.test.ts`)
- server broadcasts `collab_change` on burst close, shape correct, no content
- client `collab_change` is receive-only — client has no send path; a crafted
  inbound frame with a spoofed author is accepted only as data (server is the
  only writer) and the client renders `actor` verbatim from the server frame
- forged `type:"collab_change"` from a *peer* is impossible (peers can't
  broadcast `MESSAGE_CUSTOM` to the room — only the server fans out)

### 17.8 Frontend (`frontend/test/*`)
- `timeline.ts`: `formatTimelineEvent`, `groupWhileAway`, `mergeTimeline`
  (de-dupe by id, sort, cap), no excessive re-renders
- `ActivityTimeline.test.tsx`: render rows, relative time, `[Show more]` paging,
  row click → `openAndRevealLocation` (open before reveal; file-only when no range)
- `WhileYouWereAway.test.tsx`: renders grouped events, dismiss → `ack` call,
  auto-dismiss, navigable rows
- `TeamPanel` integration: activity section present, does not add a panel
- live "last change" line on popover/row from `timeline` state

### 17.9 Regression gates (must stay green)
`m57-presence`, `m58-attention`, M59 `collab.focus*` / `Editor.viewstate` /
`collab.follow`, `Editor.eol`, `collab-initialization` (M52), external-mutation
conflict tests, `m4-collab`, run-status tests, git tests, snapshot tests;
full backend + full frontend suites; both typechecks; both lints; frontend build.

---

## 18. Browser acceptance (two authenticated sessions)

1. Rahul edits a file → 2. meaningful change appears in Team Activity →
3. rapid edits group into one sensible burst → 4. Ankit edits → separate,
correctly-attributed event → 5. click an event → correct file (± range) opens
via `openAndRevealLocation` → 6. Rahul creates an M58 callout → 7. it appears
live (M58 unchanged) → 8. a historical `callout` row appears in Team Activity →
9. Rahul runs code → 10. a safe `ran … — exit N` event appears → 11. **no
stdout/stderr anywhere in history** → 12. a Git commit appears → 13. a
snapshot create/restore appears (if exercised) → 14. Ankit disconnects > 3 min
(real time) then reconnects → a real `last_seen` boundary is established →
15. **While You Were Away** shows only meaningful events since that boundary,
grouped by author → 16. dismiss, reopen (manual) or reconnect again → **no
duplicate events** → 17. a non-member session cannot read
`/api/projects/:id/collab/timeline` (403) → 18. live multiplayer editing
(M57/M58/M59) works throughout.

If the browser tooling blocks a step (e.g. the ghosted-presence / no-WS-disconnect
limitations seen in the M59 closeout), fall back to the §17.3 / §17.5 real
integration tests and mark that step's **visual** verification PARTIAL with the
concrete blocker — never claim it green.

---

## 19. Self-review (constraint #25 — every challenge answered)

| Challenge | Answer |
|---|---|
| Can the Yjs transaction origin ever be the wrong user? | For a client edit `tr.origin` is the exact `ws` that delivered the `MESSAGE_SYNC`; `clients.get(ws)` is the authenticated session set at upgrade (M55). No client input influences it. String/`null`/absent origins are excluded. The only failure mode is "can't attribute" (skip), never "misattribute". |
| Can one transaction generate an incorrectly attributed range? | Range is attached per `(tr, filePath)` from that file's own observer delta. A multi-file transaction gets per-file ranges. Ambiguity (multi-region, observer miss, contamination) ⇒ NULL, not a guess. |
| Can observers be duplicated / leaked? | `rangeObservedFiles: Set<string>` guard ⇒ one observer per file per room. `doc.destroy()` in `dispose()` removes all; room is then GC'd. The `WeakMap<Y.Transaction, …>` stash is drained + `delete`d synchronously in `afterTransaction`. |
| Can bursts merge separate logical work? | Key is `project:user:file`; max age caps a burst at 5 min; idle gap splits at 15 s. A genuinely separate later edit session opens a new burst. |
| Can two authors merge into one burst? | Impossible — different `authorUserId` ⇒ different key. The different-author close trigger additionally closes the *other* author's open burst on the same file. |
| Can a burst stay open forever? | No — `COLLAB_BURST_MAX_MS` + the `COLLAB_BURST_SWEEP_MS` timer force closure regardless of edit continuity; `dispose`/`shutdown`/`disconnect`/`flush` also close. |
| Can historian queues grow without bound? | `writeQueue` flushed every 5 s / at 100; open-burst map capped at `COLLAB_OPEN_BURSTS_MAX` with oldest-force-close; per-project row cap 2000; time retention 14 d. |
| Can shutdown lose buffered history? | `stop()` in `performGracefulShutdown` step 0 closes every open burst and drains the queue synchronously (node:sqlite `DatabaseSync` is synchronous) before the DB is closed in step 4. |
| Can reconnect duplicate events? | Attribution by `userId`; a closed burst is removed from the open map when enqueued and never re-touched; a reconnecting author extends the open burst or opens a new one. `while-away` dedupe is the `ack` → `last_seen` advance. |
| Can last-seen produce repeated While-You-Were-Away? | `ack` advances `last_seen` past everything shown; `removeClient` sets it on disconnect; the client trigger also requires a > 3-min gap. All three independently prevent repeats. |
| Can a timeline query leak another project's data? | `WHERE project_id = ?` first predicate on every source, indexed; union is per-project; no broad-then-filter. Test 17.4 asserts it. |
| Can sensitive fields leak from `runs` / `audit_logs`? | Explicit column projections (§7.3) — `stdout*`/`stderr*`/`signal`/secrets are never in the `SELECT`. Test 17.4 asserts the column lists and that the mapper cannot read them. |
| Can callout history become persistent chat? | One immutable row, `messagePreview ≤ 120`, no reply/thread/edit surface. M61 owns comments. |
| Can exact line ranges be falsely claimed? | Four AND-conditions (§5); any doubt ⇒ NULL. Multi-region ⇒ NULL (not min..max). Contamination ⇒ NULL. |
| Can timeline pagination be unstable? | Total order `(at DESC, id DESC)`; immutable rows; cursor is `(at,id)`; retention only trims the tail. Test 17.4 asserts no straddle / skip. |
| Can historical navigation bypass open-before-reveal? | All navigation routes through the single `openAndRevealLocation(handleOpenFile, …)` primitive — unchanged, closed-file safe. |
| Can M60 introduce meaningful DB writes into the typing hot path? | `afterTransaction` does zero I/O — pure in-memory routing. All writes batched off-path. |
| Does TeamPanel remain the coherent hub? | Activity is a section *inside* TeamPanel; no third panel, no new toolbar button. |
| Surveillance vs meaningful collaboration? | Sources are edit-bursts / runs / commits / callouts / snapshots only. No keystroke/cursor/selection/heartbeat/navigation is recorded. 14-day retention. |

No challenge is unresolved. Proceed to the implementation plan.

---

## 20. Files

### Added — backend
- `backend/src/collab/changeAttribution.ts` (pure)
- `backend/src/collab/historian.ts` (`CollaborationHistorian`)
- `backend/src/collab/timeline.ts` (read-side union)
- `backend/src/collab/lastSeen.ts` (upsert/read helpers)
- `backend/test/m60-change-attribution.test.ts`
- `backend/test/m60-historian.test.ts`
- `backend/test/m60-room-attribution.test.ts`
- `backend/test/m60-timeline.test.ts`
- `backend/test/m60-while-away.test.ts`
- `backend/test/m60-authz.test.ts`
- `backend/test/m60-wire.test.ts`

### Changed — backend
- `backend/src/db.ts` — migration `version: 11` + inline `CREATE TABLE IF NOT EXISTS`
- `backend/src/config.ts` — 11 config knobs (§14)
- `backend/src/collab/manager.ts` — `afterTransaction` attribution hook;
  `ensureFileLoaded` range observer (idempotent); `broadcastCollabChange`;
  `removeClient` / `flushToDisk` / `flushBeforeDestructiveDispose` / `dispose`
  burst-close calls; `CollaborationManager.broadcastCollabChange`,
  `notifyCollabHistorianInit`
- `backend/src/collab/attention.ts` **or** `manager.ts` `handleAttentionMessage`
  — `kind==="callout"` → `collaborationHistorian.recordCallout(...)` (metadata only)
- `backend/src/ws/index.ts` — `collab_last_seen` first-connect insert on `addClient`
- `backend/src/projects/routes.ts` — `GET /:id/collab/timeline`,
  `GET /:id/collab/while-away`, `POST /:id/collab/while-away/ack`
- `backend/src/index.ts` — `collaborationHistorian.init(db, cfg)` on startup;
  `collaborationHistorian.stop()` in `performGracefulShutdown` step 0
- `backend/src/projects/service.ts` + `backend/src/backup/workspaceRestore.ts`
  — `collaborationHistorian.disposeProject(projectId)` at the existing
  `telemetryHistorian.disposeProject` call sites

### Added — frontend
- `frontend/src/collab/timeline.ts` (pure)
- `frontend/src/components/Collab/ActivityTimeline.tsx`
- `frontend/src/components/Collab/WhileYouWereAway.tsx`
- `frontend/test/collab.timeline.test.ts`
- `frontend/test/collab.change.client.test.ts`
- `frontend/test/ActivityTimeline.test.tsx`
- `frontend/test/WhileYouWereAway.test.tsx`

### Changed — frontend
- `frontend/src/collab/client.ts` — `collab_change` receive branch + `emit`;
  `disconnectedAt` tracking + `reconnected_after_gap` emit
- `frontend/src/types.ts` — `TimelineEvent` (hand-synced)
- `frontend/src/api.ts` — three read helpers
- `frontend/src/components/IDE/IDE.tsx` — `timeline` state, `collab_change` +
  `reconnected_after_gap` listeners, `GET /collab/timeline` on first TeamPanel
  open, `lastChangeByUser` memo, `<WhileYouWereAway>` mount, wiring props
- `frontend/src/components/Collab/TeamPanel.tsx` — `<ActivityTimeline>` section
- `frontend/src/components/Collab/CollaboratorAvatarStack.tsx` — "last change" line
- `frontend/src/styles/collab.css` — timeline + while-away styles

### Changed — docs
- `STATUS.md` — M60 section on completion (not in this step)
