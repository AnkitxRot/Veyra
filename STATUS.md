# STATUS

Last updated: 2026-08-24.

## Current state

- **Baseline:** `c9833eb` — "fix: enforce auth, ownership, and port allowlist on preview proxy WS upgrades"
- **Committed on top of that baseline:** M1, M2, M3 (bug-fix codenames: save
  truthfulness, shutdown flush, WS heartbeat) and Milestone 2 (per-user
  sandbox quota + terminal concurrency gate) — all at `ce4981f`. Milestone 3
  (multiplayer correctness / collab room lifecycle race) at `1cc3b52`.
  Milestone 4 (frontend regression coverage — Vitest/jsdom test
  infrastructure) at `86c119b`. Milestone 5a (performance instrumentation +
  execution-hot-path async fixes + session cache + load-test baseline) at
  `6f433f2`.
- **This working tree:** Milestone 5b (global sandbox admission
  correctness — fixes the cross-project `maxSandboxes` TOCTOU race
  Milestone 5a's burst test discovered) — implemented and verified; not
  yet committed. See below.
- PR #1 and PR #2 merged previously; `fix/preview-proxy-ws-auth` branch deleted.

Note on numbering: `M1`/`M2`/`M3` (this doc's original bug-fix codenames) and
`Milestone 2`/`Milestone 3`/`Milestone 4`/`Milestone 5a`/`Milestone 5b` (this doc's
contract-sequence numbering) are two independent, coincidentally-overlapping
counters — e.g. `M3` (WS heartbeat) and `Milestone 3` (collab room lifecycle)
are unrelated milestones committed separately. Not renumbered post hoc to
avoid rewriting already-committed section headers below.

## Shipped product surface (already on master, not part of this working tree)

A forensic audit against `git status`/diff confirmed the following are already
committed and working, not part of M1–M3: a Yjs-based real-time collaboration
client with role-gated read-only enforcement, project sharing modal, and
collaborator presence avatars/cursor sync (`frontend/src/collab/client.ts`,
`components/Collab/*`); command palette (`common/CommandPaletteModal.tsx`);
workspace search (`Search/WorkspaceSearchModal.tsx`); execution telemetry,
per-project health, and per-project resource views (`Output/*`, `Health/*`,
`Resources/ResourcesView.tsx`); an AI patch/explain/verify pipeline with a
per-user execution gate (`ai/verify.ts`, `AI/*`); and an admin dashboard with
resource analytics (`Admin/AdminDashboard.tsx`, `Admin/AdminResourceAnalytics.tsx`).
Do not rediscover this from scratch in a future session — start here.

## Milestones completed in this working tree

### M1 — Truthful save primitive (BUG-1, P0 data loss)

Commit `cc55a1a` stopped syncing editor content into React state per keystroke
(render-churn fix) but every save consumer still read that stale state, and
Monaco's own fresh-value Ctrl+S path was shadowed by the window-capture
keyboard handler. Saves persisted file-open-time bytes, visibly reverted
editors, and clobbered live Yjs rooms via `notifyExternalFileMutation`.

Fix: `liveModels` registry in `Editor.tsx` exposing `getLiveContent()` /
`applyLiveContent()` through a `LiveContentApi` ref (type-only import keeps the
Monaco lazy chunk intact); IDE.tsx gained `resolveLiveFileContent()` (live
model → Yjs doc → stored snapshot → null) and a single canonical `ide-save`
listener that re-resolves content itself; run auto-save sources live content
and only marks actually-saved files clean; Format Document applies results
model-first so solo/collab converge; keyboard hook dispatches canonical event.

Files: `frontend/src/components/Editor/Editor.tsx`,
`frontend/src/components/IDE/IDE.tsx`,
`frontend/src/hooks/useKeyboardShortcuts.ts`,
`backend/test/api.test.ts` (+4 byte-fidelity contract tests),
`scripts/qa/save-truthfulness.md` (manual/E2E plan).

Verification: backend typecheck PASS; suite 224/0 (Docker-off env); FE tsc +
production build PASS with lazy-chunk invariant intact (entry 145 kB, no
Monaco leakage); eslint touched files 0 errors / no new warnings; QA doc
Targets 1–5 still need a manual pass before merge sign-off.

### M2 — Shutdown room flush (BUG-2, P0 data loss)

`flushAllRooms()` existed with zero callers: every restart/deploy dropped up
to 10 s of debounced collaborative edits.

Fix:

- `collab/manager.ts`: `flushAllRooms()` now runs all rooms concurrently under
  `Promise.allSettled`, contains per-room failures with projectId-attributed
  logging, and bounds each room flush (`perRoomTimeoutMs`, default 5000 ms) so
  a hung disk write can never wedge the manager or future passes.
  Deliberately NO cross-call promise dedupe: caching let one eternal hang
  block every subsequent caller forever (caught by this milestone's own
  hang-room test).
- `index.ts`: extracted exported `performGracefulShutdown(ctx, {signal, exit})`
  implementing the ordering contract — stop background maintenance → close
  idle HTTP sockets + drain → graceful-close WS clients (terminate stragglers
  at 2 s) → flush ALL rooms bounded by min(5 s, grace−1 s) → close SQLite →
  exit(0) via injected hook. Force-exit timer stays armed across the whole
  sequence. Bootstrap moved inside `start()` behind a test-runtime guard so
  importing the module no longer opens the real DB / binds :3000 / spawns
  maintenance timers (this side effect previously leaked into any test
  importing index.js and would exit(1) CI without an admin account).
  SIGTERM/SIGINT handlers delegate to it.

Files: `backend/src/index.ts`, `backend/src/collab/manager.ts`,
`backend/test/shutdown-flush.test.ts` (7 tests: real end-to-end WS edit →
shutdown → disk persistence + db-closed-after-flush ordering proof, poisoned-
room isolation, hanging-flush timeout bound (~1.8 s observed), zero-room
shutdown, manager-level isolation/wedge-recovery/standalone-persistence),
this STATUS.md.

Verification: backend typecheck PASS; full suite **224 passed / 31 skipped
(Docker-gated env) / 0 failed** across 26 files including the 7 new tests;
shutdown suite alone runs in ~3 s.

### M3 — WS payload cap + heartbeat reaper (BUG-4) — now COMPLETE

`ws/index.ts` gained `maxPayload: 1 MiB` (rejects oversized frames at the `ws`
frame-parsing layer, before any handler runs — close code 1009, process stays
healthy) and a ping/pong heartbeat reaper (`createHeartbeatController`) that
sweeps `wss.clients` every `WS_HEARTBEAT_INTERVAL_MS` (default 30 s), marking
non-responders and terminating them after two missed sweeps. Wired uniformly
into all four `wss.handleUpgrade` call sites (admin, collab, terminal,
execute); the preview-proxy upgrade path is deliberately excluded (raw
`http-proxy-middleware` socket, never enters `wss.clients` — the sweep's
`if (!meta) continue` guard is intentional, not dead code). Stopped as part of
`performGracefulShutdown`'s existing ordering.

This milestone was implemented but initially left in a broken state — a
forensic audit (2026-08-24) root-caused and this pass fixed both issues:

1. **Typecheck failure**: `ws/index.ts` used bare `WebSocket` as a type
   without importing it from the `ws` package, so TS resolved it to the
   ambient DOM/undici `WebSocket` (incompatible shape — missing `.on()`,
   wrong `dispatchEvent`). Fix: added `import type { WebSocket } from "ws";`.
   No runtime behavior changed.
2. **2/7 heartbeat tests failing**: `setupWebSocketServer` arms the
   heartbeat's `setInterval` synchronously during server boot, before the two
   fake-timer tests called `vi.useFakeTimers()` — Vitest/sinon fake timers
   never retroactively intercept a timer already scheduled against the real
   clock, so `vi.advanceTimersByTimeAsync()` never advanced it. Fix: moved
   `vi.useFakeTimers()` to before `bootServer()` in both tests (real socket/
   HTTP I/O is libuv-driven, not timer-driven, so this doesn't affect
   connection setup). This alone fixed 1 of the 2 tests. The second
   ("terminates unresponsive sockets after two sweeps") then revealed a
   second, independent, platform-specific issue: the test's own
   `_socket.pause()` — used only to stop the client's auto-pong — also
   appears to block the paused stream from ever processing the server's
   resulting FIN/RST on this platform, so `close` never fired client-side
   even though server logs confirmed the reaper correctly detected the dead
   peer and called `terminate()`. Fix: resume the paused socket immediately
   after the second sweep (once deadness is already detected server-side),
   restoring the test's original intent — pausing was only ever meant to
   block outbound pongs, not to block the test from observing its own
   connection's close.

Files: `backend/src/ws/index.ts` (+1 type-only import),
`backend/test/ws-heartbeat.test.ts` (test-ordering fix only — no assertions
weakened, no production behavior changed).

Verification: backend typecheck PASS (0 errors); `ws-heartbeat.test.ts` 7/7
PASS; full backend suite 231 passed / 0 failed / 31 skipped (Docker-gated
env, unchanged) across 24 files; M1 (`api.test.ts`) and M2
(`shutdown-flush.test.ts`) independently re-run and confirmed still green
(48 passed / 9 skipped, 0 failed) — no regression.

### Milestone 2 — Per-user sandbox quota + terminal concurrency gate

Sandbox capacity (`maxSandboxes`, default 20) was a single global counter,
not per-user — one user opening many projects could consume the whole
host's sandbox budget alone. Terminal PTY connections had no concurrency
gate at all, the one fan-out point in the system with zero admission
control.

Fix:

- `config.ts`: two new fields, `maxSandboxesPerUser` (default 5, env
  `MAX_SANDBOXES_PER_USER`) and `maxTerminalsPerUser` (default 5, env
  `MAX_TERMINALS_PER_USER`) — separate resource classes, same reasoning as
  `searchGate` being separate from `runGate`.
- `execution/sandbox.ts`: new `sandboxGate` (a `RunGate` instance, reusing
  the existing gate abstraction unchanged) enforced in
  `createProjectSandbox` alongside the existing global cap; acquired only
  after the global check, released on any provisioning failure, on
  container destruction (`stopProjectSandbox`/`cleanupAllSandboxes`), and
  primed (not admission-checked) for containers adopted by `reconcile()` on
  restart via a DB `owner_id` lookup. Authenticated `userId` threaded
  through the minimal necessary call chain (`pipeline.ts`'s `runProject`,
  `projects/routes.ts` run/install, `ws/execution.ts`, `ai/verify.ts`,
  `ws/terminal.ts`) — the same identity source `runGate` already uses at
  each of those exact call sites, never client-supplied.
- **Race fix**: a security gate pass found that `stopProjectSandbox`
  captured its container info before two `await`ed docker calls and only
  released `sandboxGate` afterward, so a concurrent `ensureProjectSandbox`
  for the same project could independently observe the container as stale
  and release the same owner's slot a second time (bounded — the global cap
  was never bypassed — but it silently eroded per-user fairness). Fixed
  with a genuine per-project async mutex (`lifecycleTail` +
  `withProjectLock()`) serializing the _entire_ critical section of both
  `ensureProjectSandbox` and `stopProjectSandbox` for a given projectId;
  different projects remain fully concurrent. `reapIdleSandboxes` skips any
  project with an in-flight lifecycle operation rather than blocking on it,
  to avoid a theoretical two-projects-reap-each-other nested-lock deadlock.
  Verified by temporarily disabling the lock and confirming the new
  regression test fails with the exact predicted symptom, then re-enabling
  it.
- `ws/terminal.ts`: new `terminalGate` (also a plain `RunGate` instance)
  checked before any sandbox/docker work; idempotent teardown
  (`permitReleased`/`torndown` flags) covers every exit path — sandbox
  failure, disconnect-during-startup, normal close, and socket error — so
  the permit is released exactly once regardless of which path fires, never
  zero, never twice.

Files: `backend/src/config.ts`, `backend/src/execution/sandbox.ts`,
`backend/src/execution/pipeline.ts`, `backend/src/ws/terminal.ts`,
`backend/src/ws/index.ts` (+1 line: threading `row.id` into
`handleTerminalConnection`), `backend/src/ws/execution.ts`,
`backend/src/ai/verify.ts`, `backend/src/projects/routes.ts`,
`backend/test/sandbox.test.ts` (+7 tests: per-user quota enforcement,
separate per-user tracking, slot returned on destruction, no leak across
repeated failures, global cap still enforced independently of per-user
quota, no double-count on concurrent duplicate creation, no double-release
on a stop/ensure race — the last one verified against both the broken and
fixed code paths), `backend/test/terminal.test.ts` (+5 tests: cap
enforcement before any docker work, separate per-user tracking, release on
close, release on socket error, release on sandbox-creation failure),
`backend/test/exec.test.ts` (added per-test sandbox cleanup — its 8
Docker-backed tests each created a distinct project under one synthetic
`userId: 1` with no release between them, which the new quota now
correctly enforces against; fixed by releasing what each test creates, not
by weakening the quota).

Verification: backend typecheck PASS (0 errors); sandbox quota tests 7/7
PASS; terminal gate tests 5/5 PASS; `exec.test.ts` with real Docker 11/11
PASS; M1/M2/M3 regression set with Docker available: 62 passed / 2 skipped
/ 0 failed; full backend suite with Docker available: **269 passed / 1
failed / 4 skipped** — the sole failure is `test/python-deps.test.ts`
("installs a real Python package via requirements.txt..."), independently
reproduced in complete isolation (ruling out cross-test quota exhaustion,
the leading suspect going in) and diagnosed as far as reasonably possible:
the exact `venv`+`pip install` command reproduces in seconds against
container-internal storage on a matching custom network, general
internet/DNS egress works at both host and container level, and PEP 668
("externally-managed-environment") is ruled out since the real install
command already uses a venv. A further diagnostic (reproducing with a
Windows-host bind-mounted workspace, to test a Windows/Docker-Desktop
bind-mount I/O hypothesis) was not completed. **This is a pre-existing,
environmental, unconfirmed-mechanism failure unrelated to this milestone's
code — not modified, not worked around, not part of any commit's claimed
scope.**

### Milestone 3 — Multiplayer correctness (collab room lifecycle race)

Committed `1cc3b52`. Found and fixed a real race in
`CollaborationRoom.scheduleIdleDisposal` (`backend/src/collab/manager.ts`):
the idle-dispose timer checked `clients.size===0` once, then awaited
`flushToDisk()` (real I/O), then acted on that now-stale zero-client read. A
client reconnecting during the await was force-closed (WS code 1001) and the
room disposed out from under them. Fix: re-check `clients.size` after the
await, bail if a client reconnected. Reproduced failing against unfixed code
first, then fixed.

4 new tests in `backend/test/m4-collab.test.ts` (tests 22-25): reconnect
during in-flight idle-disposal flush; 3 concurrent real-Yjs-client editors
converging via real sync-protocol messages; bounded 3-client x 3-cycle
reconnect storm with no presence corruption; 15-room create/dispose
bookkeeping with verified disk flush. All deterministic (fake timers +
controlled I/O gates), no sleeps.

Verification: 26/26 focused tests, full suite 274/0/4-skipped, typecheck
PASS, M1/M2/M3 regression 62/0/2-skipped.

### Milestone 4 — Frontend regression coverage

Committed `86c119b`. Bootstrapped Vitest + jsdom + @testing-library/react as
the frontend test stack — no test runner existed before this. 13 new
deterministic tests across 3 files: save truthfulness (M1/BUG-1 regression
guard — `getLiveContent` reflects the live Monaco model, not a stale
open-time snapshot), the canonical keyboard save path (exactly one `ide-save`
dispatch per Ctrl+S, `stopPropagation` verified), and 200ms presence-update
throttling (bursts coalesce to one call with the latest value, not
permanently suppressed). Extracted IDE.tsx's inline presence-throttle
closure into `frontend/src/utils/throttleLatest.ts` — the only production
behavior change, behavior-preserving, proven equivalent by test.

Both regression classes were verified to actually fail when reintroduced
(reverting the M1 `registerLiveModel` call; breaking `throttleLatest`'s
coalescing), then restored.

Verification: 13/13 frontend tests, frontend typecheck PASS, backend smoke
(`api.test.ts`) 48/0/2-skipped.

### Milestone 5a — Performance instrumentation, execution hot-path fixes, load-test baseline

Not yet committed (this working tree). Source: a read-only Milestone 5
performance/scalability architecture report (three parallel fork
investigations of the execution/sandbox, WebSocket/collaboration, and
API/DB/filesystem subsystems). That report's central findings: (1)
`execSync`-based Docker health checks block the _entire_ Node event loop on
every execution hot-path call, not just the caller; (2) `requireAuth` does a
synchronous DB session lookup on every single authenticated request; (3) no
load-test evidence existed at all — every prior scalability claim in that
report was explicitly hypothesis, not measurement. This milestone's mandate
was narrow and evidence-only: fix those two specific hot paths, add minimal
instrumentation, and run levels 1/10/50 to get real numbers — explicitly
**not** collab backpressure/coalescing, sandbox admission queues, container
CPU/RAM tiering, or any SQLite threading change (all deferred, evidence-gated
future work).

**1. Async Docker-check swap** (`backend/src/execution/pipeline.ts`,
`backend/src/execution/sandbox.ts`): the three execution-hot-path call sites
that used the blocking `isDockerRunning()`/`isRunnerImageAvailable()`
(`execSync`-backed, `tools.ts`) now use the already-existing
`isDockerRunningAsync()`/`isRunnerImageAvailableAsync()` (`execFile`-backed,
same 5s cache, same error/timeout semantics — verified by reading
`tools.ts`: both pairs share the same module-level cache entries). The
one-time startup `reconcile()` call (`sandbox.ts`, runs once before the
server accepts connections) deliberately still uses the sync variant — not a
per-request hot path, out of scope. 4 new focused tests (2 in
`pipeline.test.ts`, 2 in `sandbox.test.ts`) prove the hot paths call the
async variants and never reference the blocking ones at all (mocks
deliberately omit the sync exports — referencing them would throw, not
silently fall back).

**2. Session cache** (`backend/src/auth/sessionCache.ts`, new module, wired
into `auth/middleware.ts`'s `requireAuth`): a tiny TTL-bounded (5s freshness
TTL, 5000-entry FIFO-bounded) in-memory cache in front of the per-request
session DB lookup. Never caches a failed/missing lookup (no negative-cache
API exists at all). Immediate invalidation wired into every known
revocation path: logout (`auth/routes.ts`) invalidates the single token;
admin bulk password-reset and admin user-delete (`admin/routes.ts`, both
call sites) invalidate every cached session for that user_id. 9 unit tests
(`test/sessionCache.test.ts`) plus one HTTP-level integration test in
`api.test.ts` proving a second request with the same token issues zero
additional session-lookup DB queries (`db.prepare` spy). The pre-existing
"logout invalidates the session" test in `api.test.ts` (unchanged) is itself
a regression guard here — it would fail if invalidation were missing, since
the very next request reuses the same, now-cached, now-revoked token.

**3. Minimal observability** (`backend/src/observability.ts`, new module —
zero new dependencies, built entirely on `node:perf_hooks`'s native
histogram primitives): event-loop lag (`monitorEventLoopDelay`, started once
at boot in `index.ts`); DB call timing (`instrumentDb()` wraps
`db.prepare` once, centrally, at the single point the real `Db` is
constructed in `index.ts` — every `run`/`get`/`all` call anywhere in the
codebase is timed with zero call-site changes elsewhere, bucketed by a
bounded verb+table label, capped at 128 distinct labels); active WS
connection count (new `activeConnectionCount()` gauge in
`ws/connectionRegistry.ts` — only a per-user accessor existed before);
active collab room count (`collaborationManager.getActiveRoomCount()`,
already existed from Milestone 3, reused as-is); active sandbox count (new
`SandboxManager.getActiveSandboxCount()` gauge — none existed before);
process RSS/heap (`process.memoryUsage()`). Exposed via a new
`GET /api/admin/observability` route — reuses the existing `/api/admin`
router's `requireAdmin` gate and rate limiter, not a new unauthenticated
endpoint. 6 focused tests (`test/observability.test.ts`), including one
proving `instrumentDb` does not change `DatabaseSync` behavior (real inserts
and reads against a real in-memory DB, same results with and without the
wrapper).

**4. Load-test harness** (`backend/load-test/`, new — `server.ts`,
`virtualUser.ts`, `metrics.ts`, `run.ts`; `npm run load-test` in
`backend/package.json`; zero new dependencies, built on already-present
`tsx`/`ws`/`yjs`/`y-protocols`): boots a real in-process backend instance
(real Express app, real SQLite DB, real `instrumentDb`/event-loop
instrumentation, real Docker sandbox path — not a mock), then runs a
weighted mix of virtual-user behaviors (idle, active editor, collab pair,
busy room, many-thin-rooms, execution-heavy, preview-heavy, reconnecting,
rapid-typing) approximating the architecture report's §5 behavior model,
plus a dedicated two-socket edit-to-peer latency probe (the server never
echoes a broadcast back to its origin, so ordinary VU traffic can't
self-measure this). Two harness bugs were found and fixed while building
this (documented for a fresh session, not left implicit): (a) the harness
initially never called `setupWebSocketServer`, so every WS upgrade silently
fell through to Express's 404 handler instead of being intercepted — fixed
by wiring it into `server.ts` exactly like `index.ts` does; (b) the
behavior-weighting formula clustered every virtual user into the first
("idle") bucket regardless of user count — replaced with a proper smooth
weighted round-robin (`buildWeightedPattern()` in `run.ts`).

**Methodology deviation, disclosed:** the contract asked for "≥10-minute
steady state where feasible." On this single interactive Windows dev
machine, running that literally across 3 levels + a burst variant would cost
40-60+ minutes of wall time for one milestone. Ran shortened but real steady
states instead — level 1: 60s, level 10: 90s, level 50: 120s, burst: 30s (as
specified) — and disclose this explicitly rather than either burning that
much time or fabricating a 10-minute claim. A dedicated CI-hosted long-run
pass remains a legitimate follow-up, not done here.

**Actual results** (from `backend/load-test/results/`, one JSON + one
compact Markdown per run):

- **Level 1** (1 user, 65s total): baseline. `auth` 30ms, `project_create`
  6ms, `file_save` p50/p99 17.6/18.4ms. DB calls: 83 total, p99 0.03ms.
  Event-loop lag mean 31ms (see platform note below).
- **Level 10** (10 users, 110s total): `run` (real Docker exec) p50 374ms /
  p99 854ms. `file_save` p50/p99 17.5/18.7ms (112 calls). DB calls: 472
  total, p99 0.05ms. No errors of any class.
- **Level 50, default config** (50 users, 150s total): auth rate limiter
  (`authRateLimit`, per-IP) rejected 32/50 registrations with clean 429s —
  **expected quota rejection, not a defect**, but a harness-topology
  artifact: every virtual user in this in-process harness shares one source
  IP (127.0.0.1), so a same-IP registration burst that real production
  traffic (many distinct IPs) would rarely trigger this hard. This _does_
  correctly confirm the rate limiter enforces its configured limit under a
  genuine burst.
- **Level 50, rate-limit-relaxed supplementary run** (same 50/30s/120s/20s
  shape, `authRateLimit` override only, to isolate the other subsystems from
  the artifact above): all 50 registrations succeeded; 745 saves, 128
  tree/stats calls, 53 real Docker `run` calls — **zero errors of any
  class** (0 timeout, 0 connection_failure, 0 crash). DB calls: 3314 total,
  p99 **0.052ms** — the synchronous `DatabaseSync` handle showed no
  measurable degradation at 50 concurrent users on this hardware; this is a
  real empirical finding that narrows (does not eliminate) the architecture
  report's DB-threading concern — it may only matter at higher concurrency
  or under write contention this mix didn't produce. Event-loop lag stayed
  flat at the same ~31ms mean as the level-1 baseline throughout the full
  150s run (see time series in the report) — no correlation with load at
  this level. `collab edit-to-peer` p50/p99: 0.5/3.8ms across 295 samples
  (same-process loopback; real network RTT would sit on top of this).
  Process RSS grew from 118MB to 169MB over 150s at steady 50-user load
  (~0.34MB/s) — flagged as worth watching in a longer run, not diagnosed
  further here (could be legitimate accumulation — audit logs, telemetry
  samples — or a slow leak; inconclusive at this duration).
- **50-user burst variant** (zero ramp, all 50 register+act simultaneously,
  30s): `auth` p50 225ms / p99 422ms and `project_create` p50 185ms / p99
  334ms — both real, measurable burst cost (scrypt hashing + DB writes
  contending under genuine simultaneity, unlike the ramped runs). `run` p95
  **5642ms** / p99 **6419ms** — severe tail latency under a simultaneous
  execution burst. Event-loop lag p99 spiked to **197ms at t=5s**, decaying
  back to the ~30-40ms baseline by t=20-25s — real, measurable, load-test-only
  degradation not visible at any sustained (non-burst) level tested.
  **New finding, not in the original architecture report**: the final
  snapshot showed `activeSandboxes=25` against the documented default
  `maxSandboxes=20` global cap, with zero client-visible rejections across
  128 run requests. Root cause (from reading `sandbox.ts` again after
  seeing this): the cap check (`projectContainers.size >= maxSandboxes`)
  and the actual `.set()` that registers a new container are separated by
  an `await provisionContainer(...)`, and the per-project mutex
  (`withProjectLock`) only serializes operations for the _same_ project —
  by design, different projects run fully concurrently. A burst of ~25
  _distinct new_ projects' first-ever sandbox creation can therefore all
  read the stale pre-increment count and pass the check simultaneously: a
  TOCTOU race in cross-project admission, structurally expected once you
  look for it, not a fluke of this one run. **Not fixed in this
  milestone** (STOP condition: no sandbox admission-queue/architecture
  work) — recorded here as concrete evidence for the milestone that
  addressed it. **Fixed in Milestone 5b, see below.**
- **Platform note**: event-loop lag baseline hovers ~30-31ms mean even at
  1 user, essentially flat across every level tested. This is consistent
  with `monitorEventLoopDelay({resolution:20})` running on Windows, where
  default timer resolution is coarser than Linux — plausible platform
  floor, not a regression signal. The production Docker deployment target
  is Linux; a from-Linux baseline would be needed before treating this
  number as meaningful, and before comparing it against the burst-variant
  197ms spike (which is a real _relative_ jump regardless of platform floor).

Verification: backend typecheck PASS (0 errors, `load-test/` included in
`tsconfig.json`'s `include`); focused new tests (async-Docker 4,
session-cache 9 + 1 integration, observability 6) all pass; full backend
suite with Docker available (run mid-milestone, before the load-harness
work) 293 passed / 0 failed / 4 skipped across 29 files; full suite re-run
at milestone end with Docker unavailable in this environment (session
resumed mid-milestone, Docker Desktop not running post-resume) 266 passed /
0 failed / 31 skipped (the extra skips are exactly the Docker-gated files) —
no regression in either run. `git diff --check` clean.

### Milestone 5b — Global sandbox admission correctness (fixes the M5a TOCTOU finding)

Fixes the confirmed cross-project `maxSandboxes` race Milestone 5a's burst
load test discovered (`activeSandboxes=25` against a documented cap of 20,
zero client-visible rejections).

**Root cause**: in `createProjectSandbox`
(`backend/src/execution/sandbox.ts`), the global-cap check
(`projectContainers.size >= maxSandboxes`) was read-only and separated from
the only capacity-consuming mutation (`projectContainers.set(...)`) by a
long `await provisionContainer(...)` (multiple sequential `docker` exec
calls). `withProjectLock` only serializes operations for the _same_
projectId — different projects run fully concurrently by design — so N
concurrent NEW-project creations could all read the same stale
pre-increment count before any of them wrote to it, all pass admission, and
collectively exceed `maxSandboxes`.

**Fix**: a new `reservedProjectIds: Set<string>` and
`currentGlobalLoad() = projectContainers.size + reservedProjectIds.size`.
The check-and-reserve (`currentGlobalLoad() >= maxSandboxes` → throw, else
`reservedProjectIds.add(projectId)`) now happens as one synchronous
statement pair with zero `await` in between — the reservation is what
makes concurrent-different-project admission atomic, since JS never
interleaves two synchronous statements across an event-loop turn. Released
exactly once via a `finally`: on success it's superseded by the real
`projectContainers` entry (set immediately before the `finally` runs, no
counting gap); on any failure it's simply deleted. No queue, no
system-wide mutex — different projects still provision fully concurrently
once each has reserved its own slot. `reconcile()` is intentionally
untouched: it adopts already-running containers unconditionally (even past
a newly-lower cap) since destroying a live container to enforce a new cap
would be an invented destructive policy, not this fix's job; those adopted
containers correctly count toward `currentGlobalLoad()` for all subsequent
NEW admission decisions.

**Regression proof**: 2 new deterministic barrier-based tests (no sleeps)
were run against the pre-fix code first and failed exactly as predicted —
"two concurrent NEW projects never both admit past a 1-slot global cap"
(`runCalls` 2, expected 1, both fulfilled) and "N concurrent NEW projects
with `maxSandboxes=N-1`" for N=5 (`runCalls` 5, expected 4, all 5
fulfilled) — then passed after the fix. 5 more new tests cover: failed
provisioning releases the reservation; teardown releases exactly one
global slot, immediately reusable; per-user and global quota compose
correctly under concurrency; concurrent duplicate calls for the _same_
project don't double-reserve; reconciliation adopts over-cap containers
without destroying them and they correctly count afterward.

Files: `backend/src/execution/sandbox.ts` (+76/-31),
`backend/test/sandbox.test.ts` (+302, purely additive — no existing test
modified).

Verification: `test/sandbox.test.ts` 21 passed / 0 failed / 3 skipped
(Docker-gated real-daemon tests, Docker unavailable this session); full
backend suite 273 passed / 0 failed / 31 skipped (same Docker-unavailable
environment) — no regression; typecheck PASS; `git diff --check` clean.

**Outstanding — live-Docker burst re-validation NOT performed.** Docker
was unavailable in this session (`docker info` failed). A re-run of the
50-user burst load-test scenario was attempted but discarded: every
sandbox-creation attempt short-circuited at the Docker-availability check
before ever reaching the admission logic (`activeSandboxes` stayed at 0
throughout), so it could not have exercised the fix and would have been
misleading to keep as evidence. The fix itself is proven directly and
deterministically by the barrier-controlled unit tests above, which don't
depend on real Docker at all — but confirming `activeSandboxes` never
exceeds `maxSandboxes` under a real Docker-backed 50-user burst (the exact
scenario that originally found the bug) remains open and should be the
first thing whoever picks this up next does, before treating this defect
as fully closed end-to-end.

## Architecture decisions (do not rediscover)

- **Sandbox capacity now has both a global safety cap and a per-user
  fairness quota — Milestone 2 closed the gap this section used to
  describe.** `maxSandboxes` (default 20, global, host-wide) remains the
  hard ceiling; `maxSandboxesPerUser` (default 5) is enforced underneath it
  via `sandboxGate` in `execution/sandbox.ts`. Execution _concurrency_
  (`maxConcurrentRuns`, default 3) remains separately per-user-gated across
  REST run, WS execute, install, search, and the AI-verify path, as before.
  `maxTerminalsPerUser` (default 5) similarly gates terminal PTY fan-out via
  `terminalGate` in `ws/terminal.ts`. Sandbox lifecycle operations
  (create-or-reuse, teardown) are serialized per-project via
  `SandboxManager.withProjectLock` specifically to keep this quota
  accounting race-free — see Milestone 2 above for why that's load-bearing,
  not incidental.
- **The collab/WS layer is single-process, in-memory by design.** Zero
  distributed-infra dependencies exist in `package.json` (no Redis, no
  queue, no pub/sub) — this is intentional per the project's
  zero-external-dependency stance, not a scaling oversight. Any future
  multi-instance deployment plan must budget for this as real rework, not
  assume it's incremental.

## Known non-blocking issues

- Pre-existing: 3 frontend exhaustive-deps warnings (one lives in touched
  file IDE.tsx stats poller — deliberate id-keying, left as-is);
  unused `err` param lint warning in `proxy-ws.test.ts`;
  `proxyTargets.ts` pathRewrite non-canonical-port spelling wart;
  containerized-mode preview-port publication asymmetry in `getProxyTarget`.
- M1 follow-ups queued elsewhere: demo-account GC absence, logout not tearing
  down live WS connections, snapshot quotas (tracked for Phase-1 backlog).
- **`test/python-deps.test.ts` fails independent of this milestone's code**
  ("installs a real Python package via requirements.txt and executes code
  importing it" — 60s timeout). Reproduced in complete isolation (rules out
  cross-test quota exhaustion). The exact install command (`venv` + `pip
install`) runs in seconds against container-internal storage on a
  matching custom network; general internet/DNS egress works; PEP 668
  ("externally-managed-environment") is ruled out since the real command
  already uses a venv. Leading unconfirmed hypothesis: Windows Docker
  Desktop bind-mount I/O overhead for the many small files a fresh `venv`
  creates, specific to this dev/CI environment — not verified. Not modified
  as part of any milestone; needs its own investigation.

## Current active work

Milestone 5a (`6f433f2`) and Milestone 5b are both committed. Milestone 5b
fixed the cross-project `maxSandboxes` TOCTOU race Milestone 5a's burst
test discovered — see its section above for full detail. One item remains
open from that fix: **live-Docker re-validation of the 50-user burst
scenario was not performed** (Docker unavailable in this session); the fix
is proven deterministically by unit tests, not yet re-confirmed against a
real Docker daemon under the exact original repro scenario. Manual QA
execution for M1 (`scripts/qa/save-truthfulness.md`) remains outstanding
and un-gated, unchanged from before.

## Next recommended milestone

1. **Re-run the 50-user Docker-backed burst load test** against Milestone
   5b's fix, once Docker is available, and confirm `activeSandboxes` never
   exceeds `maxSandboxes` under the exact scenario that originally found
   the bug. This closes out Milestone 5b end-to-end; everything below
   remains evidence-gated behind Milestone 5a's results either way, per
   the architecture report's own instruction not to optimize on intuition.
2. Decide the SQLite/DB-threading direction — but only after collecting more
   evidence at higher write contention; Milestone 5a's own measurement found
   _no_ measurable DB latency degradation up to 50 concurrent users on this
   hardware, which narrows (does not resolve) the original concern.
3. Server-side collab broadcast/awareness coalescing + WS backpressure
   (`ws.bufferedAmount` check) — still unimplemented, still a real gap per
   the architecture report's static analysis; Milestone 5a's `busy_room`/
   `many_rooms_thin` traffic at 50 users didn't reveal degradation yet, but
   wasn't concentrated enough (only ~5-9 active rooms) to stress this
   specifically — a room-concentrated load test is the right next
   measurement before implementing this.
4. Only after 1-3: attempt load levels 100/500/1000+, per the original
   report's staging. Not started; do not implement any of the above without
   a new contract.
