# STATUS

Last updated: 2026-08-25.

## Current state

- **Baseline:** `c9833eb` — "fix: enforce auth, ownership, and port allowlist on preview proxy WS upgrades"
- **Committed on top of that baseline:**
  - M1, M2, M3 (save truthfulness, shutdown flush, WS heartbeat) and Milestone 2 (per-user sandbox quota + terminal concurrency gate) at `ce4981f`.
  - Milestone 3 (multiplayer correctness / collab room lifecycle race) at `1cc3b52`.
  - Milestone 4 (frontend regression coverage — Vitest/jsdom test infrastructure) at `86c119b`.
  - Milestone 5a (performance instrumentation + execution-hot-path async fixes + session cache + load-test baseline) at `6f433f2`.
  - Milestone 5b (global sandbox admission correctness) at `2083f47`, with live-Docker burst re-validation at `6db6bc9`.
  - Milestone 5c (SQLite write-contention characterization — measurement only; decision: DB-threading not justified) at `1bf264a`.
  - Milestone 6 (collaboration broadcast coalescing and WS backpressure) at `f5d65ae`.
  - Milestone 7 (memory-attribution investigation — 100-user RSS/event-loop root-causing, no production behavior change; decision: no production memory-optimization milestone justified) at `61b3fcb`.
  - Milestone 7b (load-test harness hygiene — releases simulated collaboration clients' `Y.Doc`/WebSocket/listener resources) at `3911f47`.
- **Current uncommitted work:** Milestone 8 (coalescing-window characterization — measurement only; decision: KEEP the fixed 25ms window, no adaptivity justified).
- PR #1 and PR #2 merged previously; `fix/preview-proxy-ws-auth` branch deleted.

Note on numbering: `M1`/`M2`/`M3` (this doc's original bug-fix codenames) and
`Milestone 2`/`Milestone 3`/`Milestone 4`/`Milestone 5a`/`Milestone 5b`/`Milestone 5c` (this doc's
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

Committed at `6f433f2`. Source: a read-only Milestone 5
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

**Live-Docker burst re-validation: COMPLETE.** In a later session Docker
became available and the exact original triggering scenario was re-run
(50 users, zero ramp, 30s steady, 15s rampdown, auth rate limit relaxed —
identical to the run that originally found the bug). Peak managed
containers reached exactly **20 / 20** (`maxSandboxes`) and never exceeded
it, confirmed by two independent measurements agreeing exactly: the
application's own `getActiveSandboxCount()` gauge (final snapshot: 20) and
100 one-second external `docker ps -a -f label=cloudeeeide.managed=true`
samples taken throughout and for 130+s after the run (peak: 20, same
number, no discrepancy). Container count returned to 0 by t=38s and
stayed at 0 for the remainder of the observation window; a direct
post-run `docker ps -a` / `docker network ls` check confirmed zero
leftover managed containers and zero leftover `ide-net-` networks. This
directly reproduces and closes the original finding (`activeSandboxes=25`
against a cap of 20, pre-fix) under the real Docker daemon, not just the
deterministic unit tests. Evidence:
`backend/load-test/results/level-50-burst-m5b-live2-2026-08-24T17-26-08-495Z.{json,md}`.
This confirms the fix holds for the exact tested workload (50 users, this
behavior mix, this host) — it is not a claim about capacity or correctness
at higher concurrency, different workload shapes, or other environments,
which remain evidence-gated future work like everything else in this
document.

### Milestone 5c — SQLite write-contention characterization (measurement only)

Committed at `1bf264a`. Answers the primary open question
from the architecture report and Milestone 5a: does the synchronous
`DatabaseSync` architecture need a threading redesign? **Measurement only —
no DB architecture, SQLite config, or WAL-mode change was made.**

**Workload**: `backend/load-test/` gained a second, deliberately
write-heavy behavior mix (`CONTENTION_WEIGHTS` in `run.ts`, selected via
`--contention`) distinct from M5a's general mix — 40% `file_save_heavy`
(near-continuous real `UPDATE projects` + file write, ~150-300ms interval,
vs. M5a's ~2-3.5s), 20% `metadata_write_heavy` (repeated real `INSERT INTO
snapshots` — a different table, real gzip+filesystem work), 15%
`execution_heavy` (unchanged, real Docker), 10% `busy_room` (unchanged,
shared-room Yjs), 10% `preview_heavy` (unchanged, real `SELECT`-only reads
— tests whether WAL's concurrent-reader guarantee holds under simultaneous
writers), 5% `reconnecting` (unchanged). A separate `--write-burst` mode
(used only with `--burst`) forces every VU onto `file_save_heavy` against
one pre-shared project/file (all VUs reuse one seed identity so every VU
genuinely has edit access — a real bug was hit and fixed here: distinct
freshly-registered VUs got 403s writing to a project only the seed user
owned, which would have silently produced a near-zero-success "measurement"
had it gone unnoticed) — isolates write serialization on a single row from
ordinary cross-project write spread.

**Runs** (all real SQLite, real HTTP/WS, real Docker where applicable; 60s
warm-up (`--ramp`) + 300s steady + 60s rampdown for sustained levels, 30s
steady + 60s rampdown for the burst, per the contract):

- **Baseline reconciliation** (10 users, M5a's _general_ mix, low
  contention): event-loop lag mean 30.5ms, DB p99 0.082ms — matches M5a's
  original level-10 findings almost exactly. Methodology confirmed
  reproducible before adding new measurements.
- **WRITE_10** (control): 14,102 DB calls over 5min steady state, DB p99
  stayed at **0.054ms**, event-loop lag flat at ~30ms mean throughout.
- **WRITE_50**: 69,227 DB calls, DB p99 **0.063ms** — statistically
  indistinguishable from WRITE_10. Event-loop lag crept from 33.3ms to
  37.5ms p99 over the 5 minutes (mild, not alarming).
- **WRITE_100**: 103,591 DB calls, DB p99 **0.061ms** — still flat, still
  indistinguishable from WRITE_10/50. Event-loop lag, however, grew
  noticeably: **33ms → 85.5ms p99**, a steady, roughly-linear climb over
  the full 5-minute window (not a sudden spike). Process RSS grew
  89MB → 399MB over the same window, tracking the SAME time-dependent
  growth curve. The `sandboxes` gauge (execution-heavy VUs) reached 15 by
  t≈60s and then held flat for the remaining ~300s — yet event-loop lag
  _kept climbing_ well after that stabilized, ruling out "more active
  containers" as the sole driver.
- **BURST_100** (the cross-check — 100 VUs, zero ramp, all writing to the
  exact same project/file simultaneously for 30s): 12,129 real writes, 100%
  success, **zero** errors of any class. DB p99 **0.029ms** — the lowest of
  any run. Event-loop lag p99 **34.1ms**, essentially unchanged from
  baseline and _lower_ than the spread-out WRITE_100 run. Save round-trip
  p50/p99: 11.8ms / 121.9ms.

**Attribution — the decisive comparison is WRITE_100 vs. BURST_100.** If
SQLite write serialization were the bottleneck, the scenario that maximizes
single-row write contention (BURST_100) should show the _worst_ event-loop
degradation. It shows the _least_ (34ms vs. 85.5ms p99) while completing 5x
the per-second write throughput (402/s vs. WRITE_100's steady-state rate)
with zero errors. Combined with DB call latency staying at 0.03-0.08ms
across literally every run and workload shape tested — including this
maximally-concentrated one — there is **no evidence DatabaseSync's
synchronous nature is the source of the event-loop lag growth observed at
100 sustained users.** The growth instead correlates with elapsed
time/aggregate concurrent-request volume and, closely, with process RSS
growth (plausibly GC pressure from a busier, longer-running process) — a
distinct, real, worth-investigating finding, but not a DB-threading
question, and explicitly out of this milestone's scope to chase further.

**Data-quality caveat, disclosed**: `file_save_heavy`/`snapshot_create`'s
reported p50/p95/p99 in WRITE_50/WRITE_100 are computed from only the
first 20,000 chronologically-recorded samples (`MAX_SAMPLES_PER_CLASS` in
`load-test/metrics.ts`, a pre-existing harness cap unrelated to this
milestone) — the harness stopped sampling latency partway through each run
once volume exceeded the cap, while outcome counts (success/error) are
uncapped and accurate. This likely means the reported endpoint-latency
percentiles understate the true late-run tail. **This does not affect the
DB-threading conclusion above**, which is built entirely from
`instrumentDb`'s native `node:perf_hooks` histograms (server-side,
uncapped) — only the client-side per-endpoint latency figures are
affected, and those are supporting color, not the decision evidence.

**No data loss, no crashes, no unexplained hangs.** A small number of
`connection_failure`s appeared at WRITE_100 (7 of 37,523 file-save
attempts, 1 of 4,878 snapshot attempts — ~0.02%), consistent with ordinary
transient load-test client/server churn at this concurrency, not a
systemic failure.

Files: `backend/load-test/run.ts`, `backend/load-test/virtualUser.ts`
(both extended, no other production files touched — `observability.ts`
was inspected and found sufficient as-is, no changes needed there).
Evidence: `backend/load-test/results/level-{baseline-control,write-10,
write-50,write-100,write-burst-100}-*.{json,md}`.

Verification: typecheck PASS (0 errors); M1-M5b regression (11 files,
Docker available) 164 passed / 0 failed / 4 skipped (Windows-only skips) —
no regression; `git diff --check` clean; zero leftover managed containers
or `ide-net-` networks after every run.

**Decision: A — NOT JUSTIFIED.** DB latency remains low and stable
(0.03-0.08ms p99) across every workload shape and concurrency level tested,
including the one specifically designed to maximize SQLite write
serialization. Event-loop degradation exists at the 100-user diagnostic
tier but is clearly dominated by another cause (time/volume-correlated,
tracking RSS growth, and _lower_ under maximum DB contention than under
spread load) — not SQLite. An async-DB/worker-thread redesign is not
supported by this evidence and should not be started from this finding.
The RSS/event-loop-lag time-correlation is flagged as a separate,
legitimate follow-up (likely a memory-profiling task, not a DB-architecture
one) — not investigated further here, out of this milestone's scope.

### Milestone 6 — Collaboration broadcast coalescing + WS backpressure

Committed at `f5d65ae`. Addresses item 1 from Milestone 5c's
"Next recommended milestone" list: the collab/WS layer broadcast every Yjs
update and every awareness change synchronously, per-event, to every
connected client, with no protection against a slow WebSocket consumer
building unbounded server-side buffering. Constraints: no Redis/pub-sub/
horizontal scaling, no SQLite changes, no sandbox changes, no Yjs
wire-protocol changes, before/after measurement required (not intuition).

**Design** — `backend/src/collab/manager.ts`:

- **Coalescing** (room-local, trailing-edge): Yjs updates arriving within a
  `DEFAULT_YJS_COALESCE_MS` (25ms, `COLLAB_YJS_COALESCE_MS`) window are
  merged losslessly via `Y.mergeUpdates` — every operation from every
  merged update survives, this is not a "keep the latest" reduction — into
  one physical send. A single shared origin across the window is excluded
  from its own broadcast (preserves "don't echo my own edit"); a mixed-
  origin window goes to everyone, which is always safe since
  `Y.applyUpdate` is idempotent. Awareness updates within
  `DEFAULT_AWARENESS_COALESCE_MS` (50ms, `COLLAB_AWARENESS_COALESCE_MS`) are
  re-encoded from **live** awareness state at flush time (not a snapshot
  taken at arrival), so "latest wins" is automatic even if a client changed
  state multiple times within the window. The handshake (`addClient`'s
  Step1 sync + baseline awareness snapshot, and `handleMessage`'s direct
  sync-protocol replies) is never routed through either coalescer — it is
  sent synchronously and immediately, always.
- **Backpressure** (two-tier, `ws.bufferedAmount`-driven, O(1) per client):
  awareness sends are skipped once a client crosses
  `DEFAULT_HIGH_WATERMARK_BYTES / 2` (500,000B) — safe because state is
  always ephemeral and always re-derived live on the next successful send,
  so nothing needs tracking. Yjs sends are skipped once a client crosses
  the full `DEFAULT_HIGH_WATERMARK_BYTES` (1,000,000B,
  `COLLAB_HIGH_WATERMARK_BYTES`); the client is marked slow in a room-level
  `Set` and every subsequent broadcast is skipped unconditionally for it —
  no per-client queue is ever built, so a client stuck slow indefinitely
  costs the room nothing beyond one `Set` entry. A `setInterval` (500ms,
  self-cancelling when no client is slow) polls backpressured clients
  independently of ordinary traffic; once a client's `bufferedAmount` drops
  to `DEFAULT_LOW_WATERMARK_BYTES` (200,000B,
  `COLLAB_LOW_WATERMARK_BYTES`), it is recovered via `sendCatchUp()` — one
  full-document `Y.encodeStateAsUpdate()` sent through the existing sync
  protocol's `writeUpdate` framing (no new wire protocol) plus one full
  awareness snapshot. `Y.applyUpdate` idempotence makes this safe
  regardless of exactly what was skipped in between.
- **Production bug found and fixed during this milestone**: `dispose()`
  calls `awareness.destroy()`, whose internal implementation calls
  `setLocalState(null)` — this fires the room's own still-registered
  `awareness.on("update")` listener, which called `queueAwarenessUpdate()`,
  re-arming `awarenessCoalesceTimer` via `setTimeout` _after_ `dispose()`'s
  timer-clearing block had already run. Result: one leaked timer per room
  disposal. Fixed with a `disposed` boolean guard, set at the very start of
  `dispose()` and checked at the top of `queueYjsUpdate`/
  `queueAwarenessUpdate`. Confirmed via a fake-timer test
  (`vi.getTimerCount() === 0` after dispose) that failed before the fix and
  passes after.

**Harness bug found and fixed (pre-existing, not introduced this
milestone)**: `/ws/collab`'s upgrade path enforces
`requireProjectAccess(db, userId, projectId, "viewer")`. Every
`busy_room`/`collab_pair`/`rapid_typing` virtual user in the load harness
was a freshly self-registered user with no collaborator grant on the
shared room's project, so every one of them was silently 403'd and its
socket destroyed before ever reaching `room.addClient()`. This means
**every prior collaboration-room-concentration load measurement in M5a and
M5c's history (`busy_room` traffic specifically) was, in practice, only
ever exercising the dedicated 2-socket edit-to-peer probe, not genuine
N-user room concentration** — a measurement-validity gap that predates
this milestone and was only surfaced by M6's harness work. **This does not
retroactively invalidate M5a/M5c's actual conclusions**: M5a's finding was
about general-mix behavior at scale (of which `busy_room` was a minor
weighted component, not the focus), and M5c's DB-threading conclusion did
not depend on `busy_room` at all. No historical evidence file has been
altered or re-labeled; this note is the correction, kept in documentation
only, per instruction. Fixed in the harness (`backend/load-test/run.ts`,
new `--collab-only` flag) by reusing the seed/room-owner's auth token
across every VU under that mode — mirroring the pre-existing
`--write-burst`/`presetToken` pattern — so every VU is still a genuinely
distinct WebSocket connection in the room (which is what actually drives
fan-out/coalescing/backpressure), only the authenticated `userId` is
shared. Verified fix via a sanity check: active WS connections in the room
jumped from a flat 2 to 12 at 10 requested users, and broadcast sends
jumped from ~124 to 6,095 for the same run.

**Before/after evidence** (`backend/load-test/results/level-m6-{baseline,
postfix}-{10,50,100}-*.{json,md}`; one concentrated room, `--collab-only
--relax-auth-rate-limit`, per-IP auth rate limiting relaxed per the
established M5a/M5c harness practice; baseline measured against actual
pre-M6 code at `1bf264a` via an isolated `git worktree`, not cited from
old runs):

| Metric             | 10 before→after        | 50 before→after          | 100 before→after             |
| ------------------ | ---------------------- | ------------------------ | ---------------------------- |
| Broadcast sends    | 23,004 → 12,951 (-44%) | 713,431 → 120,365 (-83%) | 2,607,722 → 212,609 (-91.8%) |
| Edit-to-peer p99   | 1.4ms → 33.1ms         | 20.5ms → 37.3ms          | 704.9ms → 353.8ms            |
| Event-loop lag p99 | 32.5ms → 32.7ms        | 36.4ms → 36.2ms          | 381.4ms → 155.7ms            |
| RSS                | 134.0MB → 117.9MB      | 480.2MB → 451.4MB        | 1523.3MB → 1518.2MB          |

**Honest, scale-dependent result, not oversold**: at low concentration
(10-50 users) the fixed coalescing window costs ~30ms of added edit-to-peer
latency for a real 44-83% broadcast reduction, with no measurable
event-loop benefit yet — the system wasn't under enough contention for
coalescing to pay for itself in latency terms. At the scale this milestone
was actually commissioned for (100 concentrated users), it delivers a
91.8% broadcast reduction, roughly halves event-loop p99, and reduced
contention outweighs the fixed coalescing window enough that edit-to-peer
latency actually _improves_ at every percentile, not just holds flat. One
100-user baseline run segfaulted non-reproducibly before a clean retry;
treated as an anecdotal robustness note, not a proven finding, and not
counted as an official data point.

Files: `backend/src/collab/manager.ts` (production), `backend/src/config.ts`

- `backend/src/observability.ts` + `backend/src/admin/routes.ts` +
  `backend/load-test/server.ts` (additive gauge wiring for
  `totalCollabBroadcastSends`, no behavior change), `backend/load-test/run.ts`
  (`--collab-only` flag + `presetToken` fix), `backend/test/
m6-collab-coalesce-backpressure.test.ts` (new, 8 tests), `backend/test/
m4-collab.test.ts` (one test updated to advance fake timers past the
  coalesce window — the only M1-M5c test whose synchronous-broadcast
  assumption coalescing changed), `backend/test/observability.test.ts`
  (extended for the new gauge).

Verification: backend 308 passed / 4 skipped / 0 failed (Docker available);
frontend 13 passed / 0 failed; backend + frontend typecheck PASS; `git diff
--check` clean; collaboration-focused suite (new M6 tests +
m4-collab.test.ts + shutdown-flush.test.ts + observability.test.ts) 47/47.

**Decision: implement — evidence-justified at the concentration level this
milestone targets.** No further tuning of the coalescing windows or
watermarks was done beyond the conservative defaults; the low-concentration
latency tradeoff is disclosed, not hidden, and is a reasonable line item
for a future milestone if it proves to matter in practice.

### Milestone 7 — Memory investigation (100-user RSS/event-loop attribution)

Committed at `61b3fcb`. Investigation only, no production behavior changed. Answers item 1 from
Milestone 6's "Next recommended milestone" list: why did M5c observe
sustained RSS/event-loop growth under 100-user load, and why did M6's
100-user collaboration RSS stay ~1.52GB before and after coalescing despite
a 91.8% broadcast-volume reduction?

**Instrumentation added** (additive only, no behavior change):
`backend/src/observability.ts` gained `externalBytes`/`arrayBuffersBytes`
on the memory snapshot, a `gc` field (cumulative pause count + duration by
kind, via `node:perf_hooks`'s built-in GC performance entries — no
`--expose-gc` or GC flag needed), and `cpuUsageMicros` (cumulative
`process.cpuUsage()`); `backend/load-test/server.ts` wires
`startGcObserver()`/`stopGcObserver()` alongside the existing event-loop
monitor. `backend/load-test/memory-profile.ts` (new) is a standalone
diagnostic script — deliberately **not** added as flags to `run.ts`, so
the already-verified M5/M6 harness file is untouched — that reproduces a
workload with heap snapshots (`node:v8` `writeHeapSnapshot`, no Chrome
DevTools needed) at baseline/mid-run/peak/post-rampdown, plus a
configurable post-rampdown observation window.
`backend/load-test/analyze-heapsnapshot.cjs` (new) is a bounded, read-only
histogram tool (self-size grouped by constructor name) for `.heapsnapshot`
files, since the files involved (up to ~480MB) are too large for Chrome
DevTools' UI to load comfortably on this machine.

**Methodology note — scale**: the deep-dive (heap snapshots + full
5-minute post-rampdown observation) ran at **40 concurrent users**, not
100, specifically so heap snapshot files stay parseable
(`JSON.parse`-able with a bumped `--max-old-space-size`) and reviewable —
"bounded," per the contract. The qualitative pattern below is confirmed
directly against the **actual 100-user M6 evidence**
(`level-m6-baseline-100-*.json`, unmodified, read only) for the parts that
don't need heap snapshots (RSS/heapUsed/heapTotal time series, gauge
behavior) — both scales show the identical shape: continuous heap growth
in lockstep with RSS, with connection count flat.

**Runs** (all real HTTP/WS/SQLite/Docker, in-process harness, same
45s/90s/20s ramp/steady/rampdown shape as M6 for comparability):

- **`memprofile-collab-heavy-40`** (every VU is `rapid_typing`, one shared
  room — same shape as M6's `--collab-only`; 4 heap snapshots + 300s
  post-rampdown observation): RSS climbed **98.8MB → 723.9MB** over 137s
  while WS connections were flat at 42 for the back half of that climb
  (t=50 to t=137, RSS still roughly doubled during that flat-population
  window). `externalBytes`/`arrayBuffersBytes` stayed pinned at ~8MB/~4MB
  for the _entire_ run — ruling out native buffers/sockets as the driver.
  `gc.major` count was frozen at 23 and `gc.minor` at 202 for the entire
  run from t=5 onward — **no GC activity at all occurred during the
  700MB+ climb**, meaning V8 was simply expanding live heap, not
  struggling to reclaim garbage; GC pauses cannot be what's driving
  event-loop lag here (event-loop p99 only rose modestly at this 40-user
  scale, 32.8ms→36.9ms — the severe 372ms p99 seen in M6's real 100-user
  run is presumably the same underlying mechanism at a scale where
  per-flush encode/broadcast cost over a much larger accumulated document
  finally dominates the tick).
- **Post-rampdown retention (the decisive test)**: after `controller.abort()`,
  WS connections and the collab room gauge both correctly returned to
  **0** (confirming the M6 dispose-path fix and room lifecycle both work
  correctly). Heap did **not** decay: heapUsed sat at ~250MB and RSS at
  ~677MB, completely flat, for the entire remaining 296s of observation —
  and the final `post-rampdown.heapsnapshot`, which `v8.writeHeapSnapshot`
  takes only after forcing a full GC internally, still showed the same
  ~250MB retained. This is genuine live retention, not garbage merely
  awaiting a GC cycle that hadn't run yet.
- **Heap snapshot class breakdown (the attribution)**: the retained memory
  is overwhelmingly three Yjs-internal types — `Item`, `ID`, and
  `ContentString` — growing monotonically across baseline (0 of each) →
  mid-run (458,916 Items) → peak (760,848) → post-rampdown (743,151,
  essentially unchanged from peak, confirming no decay). The real edit
  count for this run is ~17,920 (40 VUs × ~448 avg edits each, computed
  from the ramp/steady timing and the 200ms±jitter edit cadence). 743,151
  ÷ 17,920 ≈ **41.5× replication** — matching almost exactly (40 VUs + a
  couple of probe/server docs). **This is not one growing document; it is
  ~40 independent full replicas of the same ever-growing document, one
  per simulated client, none of which are ever explicitly released.**
  Smaller contributors: ~17,700 leaked `Listener`/`Timeout` object pairs,
  matching the load-test harness's own `sleep()` helper
  (`backend/load-test/virtualUser.ts`) registering one `AbortSignal`
  `"abort"` listener per call and never removing it — a real but minor
  (~3MB) harness bug, dwarfed by the replication effect above.
- **Control A — `memprofile-normal-40`** (M5a's general weighted mix,
  mostly non-collaboration behaviors with a small collaboration
  component): peak RSS **136.7MB**, essentially flat against a ~99MB
  baseline. No heap snapshot needed — the numeric series alone shows no
  meaningful growth.
- **Control C — `memprofile-non-collab-40`** (collaboration behaviors
  removed entirely, weight redistributed to idle/active_editor/
  execution_heavy/preview_heavy): peak RSS **155.3MB** (a few real Docker
  sandboxes account for the small excess over baseline), again
  essentially flat.
- **Attribution conclusion**: only the collaboration-heavy workload grows
  at all; normal and non-collaboration traffic at the same user count and
  duration are flat. Combined with the class breakdown, this points
  specifically at Yjs client-replica retention, not generic backend load,
  not native memory, not GC pressure.

**What this means for M6's own "RSS didn't change" observation**: M6's
100-user before/after RSS staying flat at ~1.52GB despite a 91.8%
reduction in physical broadcast sends is now explained rather than
puzzling — coalescing changes how many WS frames are needed to deliver a
given set of CRDT operations, but every connected replica still ends up
applying the _same total number of operations_ to its own full local
copy either way. The dominant cost here is per-replica document size ×
replica count, which coalescing was never designed to change and didn't.

**Important scope caveat, disclosed explicitly**: because this harness
runs the server and all simulated client replicas in one Node process
(by design, for realistic WS/HTTP traffic without spinning up N browser
processes), this measurement cannot cleanly separate "real server-side
per-room memory" from "harness-simulated client replica memory" the way
a production deployment would (there, each replica would live in a
separate user's browser tab, not the server process). The ~40×
replication effect measured here is **at least partly, and likely
mostly, a load-test harness topology artifact** (classification **E**),
compounded by a real but small harness cleanup bug in `sleep()`
(classification **G**, minor) — not conclusively a `collab/manager.ts`
production leak. `manager.ts` was out of scope for this investigation
contract and was not touched or independently instrumented, so the
server's own single-authoritative-document memory footprint in isolation
was not directly measured here; the existing M6 dispose-path fix and
correctly-zeroing `activeCollabRooms`/`activeWsConnections` gauges are
circumstantial evidence the server-side room lifecycle itself is sound.

**Attribution classification: primarily E (harness artifact, dominant) +
G (minor harness listener leak), with C (retention) describing the
_mechanism_ of what's retained** — not A (the growth is real and doesn't
settle) and not D (external/arrayBuffers never moved) and not B (no GC
activity occurred during the growth at all, ruling out GC pause pressure
as the event-loop-lag driver at this scale).

**Decision: no memory-optimization milestone is justified on the
server/production side from this evidence.** The dominant driver
identified is load-test-harness client-replica lifecycle, not
`collab/manager.ts`. If a follow-up is wanted, it is harness-hygiene
(explicitly destroy each VU's `Y.Doc`/close listeners in
`runCollabRoom`, and fix `sleep()`'s unremoved abort listener) so future
collaboration load tests measure server-side memory more cleanly — not a
production code change. Given the small magnitude of the harness-hygiene
item and that it does not block any other milestone, it is left
unimplemented pending explicit prioritization, per this contract's "no
remediation in this milestone" instruction.

Files: `backend/src/observability.ts`, `backend/load-test/server.ts`
(both additive, no behavior change), `backend/load-test/memory-profile.ts`
(new), `backend/load-test/analyze-heapsnapshot.cjs` (new). Evidence:
`backend/load-test/results/memprofile-{collab-heavy,normal,non-collab}-40-*.{json,md}`
plus `backend/load-test/results/memprofile-heap-collab-heavy-40-*/*.heapsnapshot`
(4 files, ~15MB/~280MB/~460MB/~450MB — kept locally for review, not sized
for a git commit). No M5/M6 evidence file was read-modified or altered.

Verification: backend 308 passed / 4 skipped / 0 failed (unchanged from
before this investigation); backend + frontend typecheck PASS; `git diff
--check` clean.

### Milestone 7b — Load-test harness hygiene (fixes Milestone 7's findings)

Committed at `3911f47`. Harness-only fix, no production behavior changed. Implements the optional
follow-up Milestone 7 identified: `backend/load-test/virtualUser.ts`
never released a simulated collaboration client's `Y.Doc`/WebSocket
listeners, and `sleep()` never removed its `AbortSignal` listener.

**`sleep()` fix**: the `"abort"` listener now removes itself in both the
normal-timeout path and the abort path (previously only `clearTimeout`
ran on abort; the listener itself was never unregistered either way).
Confirmed via `getEventListeners(signal, "abort")` staying at exactly 0
after each call, including across 25 repeated calls on the same shared
signal (test F).

**Collaboration client cleanup**: `wireYjsClient()` now returns a
disposer that removes exactly the two listeners it added (not
`ws.removeAllListeners()`, which would also strip the `ws` library's own
internal listeners and risk interfering with its close handshake). A new
`waitForOpenOrAbort()` helper replaces the three ad hoc
open/error/abort-wait blocks that existed in `runCollabRoom` and
`runReconnecting`, cleaning up all three listeners regardless of which
one wins. A new `disposeCollabClient()` factory returns a single,
idempotent per-client teardown function (`unwire()` + `ws.close()` +
`doc.destroy()`) used from a `finally` block in both `runCollabRoom` and
`runReconnecting`, so cleanup runs on normal completion, on error, and on
abort alike. `runEditToPeerProbe`'s `stopProbe` return value got the same
treatment (idempotence guard + listener removal + `senderDoc.destroy()`/
`listenerDoc.destroy()`) since it has the identical resource shape,
though it only creates one doc pair per run, not one per VU.

**Tests** (`backend/test/virtualUser.test.ts`, new, 9 tests, all
deterministic — fake timers / mocked `ws` module / `getEventListeners`,
no real network, no real sleeps): A (`runCollabRoom` disposes ws+doc on
normal loop exit), B (`disposeCollabClient` teardown is idempotent), C
(aborting before the socket ever opens still disposes), D (`sleep()`
removes its listener after normal completion), E (`sleep()` removes its
listener after abort), F (25 repeated `sleep()` calls never accumulate
listeners), G (a simulated 3-VU workload leaves zero ws/doc/listener
resources after everyone disconnects), plus two supplementary tests
isolating `wireYjsClient`'s and `waitForOpenOrAbort`'s listener hygiene
directly. `new WebSocket(...)` is mocked (`vi.mock("ws", ...)` with a
minimal `EventEmitter`-based fake) rather than hitting a real socket.

**Memory re-measurement** (same `collab-heavy-40` workload as Milestone
7: 40 users, 45s/90s/20s ramp/steady/rampdown, 300s post-rampdown
observation):

|                                                           | Before (M7)                                          | After (M7b)                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Peak RSS / heapUsed (during active workload, ws=42)       | 723.9MB / 280.0MB                                    | 727.3MB / 281.5MB                                                                      |
| Post-rampdown, ws=0/rooms=0, immediately                  | 677.1MB / 255.5MB                                    | 682.6MB / 246.4MB                                                                      |
| Post-rampdown, +300s observation, final                   | **677.2MB / 249.7MB (flat since ~t=160s)**           | **456.1MB / 30.8MB**                                                                   |
| Retained Yjs `Item` objects (post-rampdown heap snapshot) | 743,151                                              | **35,342 (-95.2%)**                                                                    |
| `gc.major` count across the run                           | 23 (frozen from t=5s — no GC ever ran during growth) | 27 (GC actually ran post-rampdown, as expected once there was real garbage to collect) |

Peak memory while the workload is actively running is (correctly)
**unchanged** — 40 genuinely connected clients legitimately holding a
live replica each is expected behavior, not something this milestone
should or does change. The entire effect is in what happens **after**
disconnection: before the fix, heapUsed sat completely flat at ~250MB
forever (no GC activity at all after the initial ramp); after the fix,
heapUsed naturally decays via ordinary (unforced, default-flag) GC over
roughly the first ~220s of the observation window and settles at 30.8MB
— within range of the run's own ~22MB starting baseline, not just
"lower." The post-rampdown heap snapshot file itself shrank from 452MB
to 35.1MB (-92%), and its retained-`Item` count dropped 95.2%,
proportional to going from ~41 replicas of the shared document down to
roughly 2 replicas' worth still resolvable at the snapshot instant. That
small residual (~4MB self-size worth of `Item`/`ContentString` objects,
not hundreds of MB) was not root-caused further — it is not "substantial
unexplained memory" by any reasonable reading of that phrase, and
chasing it further is exactly the kind of open-ended remediation this
milestone's contract said not to start.

Files: `backend/load-test/virtualUser.ts` (harness only — no production
collaboration file touched), `backend/test/virtualUser.test.ts` (new).
Evidence: `backend/load-test/results/memprofile-collab-heavy-40-postfix-*.{json,md}`
plus a fifth local-only heap-snapshot set (same disclosed local-only
convention as Milestone 7 — not sized for a git commit).

Verification: harness tests 9/9 new + 308 pre-existing = 317 backend
tests passed / 4 skipped / 0 failed; frontend 13/13 passed; backend +
frontend typecheck PASS; `git diff --check` clean; no
`backend/src/collab/manager.ts` or other production file touched; no
M5/M6/M7 evidence file altered.

**Classification: EXPECTED_REDUCTION.** The ~40× Yjs replica retention
Milestone 7 attributed to the load-test harness disappears once the
harness releases its own simulated clients — confirming Milestone 7's
attribution was correct and that no production `CollaborationManager`
memory fix is warranted. Future collaboration load-test evidence
(post-rampdown memory in particular) is now a much cleaner signal of
actual server-side behavior, since it is no longer dominated by
un-released harness-side replicas.

### Milestone 8 — Coalescing-window characterization (measurement only)

Answers "Next recommended milestone" item 1 from Milestone 6: should the fixed
`DEFAULT_YJS_COALESCE_MS` (25ms) stay fixed, be reduced, or become adaptive?
**Measurement only — `backend/src/**` untouched** (`collab/manager.ts`,
`config.ts`, `ws/*` all byte-identical to `3911f47`; the production default
is unchanged). No adaptive logic implemented.

**Method**: `backend/load-test/run.ts` gained one harness-only CLI flag,
`--yjs-coalesce-ms <n>`, threaded through the *pre-existing*
`bootstrapLoadTestServer` `ConfigOverrides` plumbing (the same mechanism
M5a uses for `authRateLimit`) into `CollaborationManager`'s existing
constructor option. There is no second production configuration path; with
the flag absent, behavior is exactly as before. Driver:
`backend/load-test/m8-sweep.sh` (disposable runner, not part of the
harness proper). Workload held constant across every run: `--collab-only
--relax-auth-rate-limit --ramp 15 --steady 45 --rampdown 10`, one
concentrated shared room, same edit cadence/duration/ramp per run, same
machine/session (all 27 runs 2026-08-25 06:49–07:23 UTC, sequential,
exit=0 × 27, zero retries).

**Baseline at the current default (25ms)** — edit-to-peer p50/p95/p99 ms |
physical broadcast sends | event-loop p99 | RSS final:

| users | e2p p50/p95/p99 | sends | evloop p99 | RSS |
| ----- | --------------- | ----- | ---------- | --- |
| 1     | 31.1/32.1/32.7  | 688   | 32.4       | 84MB |
| 2     | 30.9/32.9/33.2  | 1,479 | 32.4       | 86MB |
| 3     | 31.0/32.6/32.7  | 2,490 | 32.3       | 91MB |
| 5     | 30.9/32.2/32.6  | 5,088 | 32.2       | 93MB |
| 10    | 30.8/32.5/32.9  | 12,950| 32.3       | 120MB |
| 25    | 30.6/33.1/35.0  | 40,814| 32.9       | 237MB |
| 50    | 30.2/33.9/37.9  | 87,780| 35.6       | 368MB |

(1-user row is a different semantic case — no peer fan-out; reported as a
floor reference only.)

**Window sweep** — physical sends (% change vs 0ms) and edit-to-peer
p50/p99 ms, per room size:

| users | 0ms | 5ms | 10ms | 25ms | 50ms |
| ----- | --- | --- | ---- | ---- | ---- |
| 2  | 1,558 · 15.6/17.3 | 1,590 (+2%) · 15.5/17.5 | 1,580 (+1%) · 15.7/17.1 | 1,479 (−5%) · 30.9/33.2 | 1,303 (−16%) · 61.2/63.5 |
| 5  | 6,061 · 15.6/16.8 | 5,950 (−2%) · 15.6/17.4 | 5,955 (−2%) · 15.6/17.1 | 5,088 (−16%) · 30.9/32.6 | 3,739 (−38%) · 47.3/63.5 |
| 10 | 17,800 · 15.5/17.1 | 17,943 (+1%) · 15.7/17.4 | 18,195 (+2%) · 15.7/17.3 | 12,950 (−27%) · 30.8/32.9 | 8,147 (−54%) · 47.5/64.5 |
| 25 | 72,037 · 15.6/17.1 | 69,973 (−3%) · 15.9/17.7 | 68,773 (−5%) · 16.0/18.5 | 40,814 (−43%) · 30.6/35.0 | 21,897 (−70%) · 46.3/65.7 |
| 50 | 207,060 · 14.8/22.3 | 165,809 (−20%) · 15.9/18.7 | 161,982 (−22%) · 16.6/32.0 | 87,780 (−58%) · 30.2/37.9 | 44,591 (−78%) · 45.9/64.8 |

**Event-loop lag**: statistically flat (p99 ≈ 32.2–35.6ms) across *every*
window × room-size cell — the Windows ~30ms `monitorEventLoopDelay`
resolution floor (documented since M5a) dominates completely at these
loads; no measurable window effect either way. **RSS**: determined by room
size alone (≈86MB @2 → ≈240MB @25 → ≈370MB @50), identical across windows
within ±4MB — coalescing window has no memory effect.

**Answers to the contract's questions**: (1) At 2–5 users, 5/10ms provide
essentially **zero** broadcast reduction (±2%, within jitter — with a ~200ms
cadence, updates rarely collide inside such short windows); 25ms provides
5–16%; latency cost of 5/10ms over 0ms is unmeasurable, of 25ms ≈ +15ms.
(2) At 10 users, yes — 25ms is materially better than 5/10ms (−27% vs ~0%)
for a bounded +15ms. (3) At 25–50 users, 25ms delivers −43%/−58% for the
same +15ms — clearly worthwhile there. (4) 50ms *does* buy meaningful extra
reduction (relative further −37% to −49% beyond 25ms) but doubles the
latency cost (total ≈ +31–48ms over the 0ms floor) — rejected on latency
cost for an interactive editor, not for lack of effect. (5) **No crossover**:
broadcast benefit rises smoothly and monotonically with room concentration
while the latency penalty is a constant ≈ one window regardless of size;
there is no load regime where any smaller fixed window dominates 25ms on
both axes simultaneously.

**Measured facts vs interpretation**: the numbers above are measured facts.
Interpretation: the coalescing value proposition scales like fan-out
collision rate (∝ roughly N²·cadence⁻¹), so a fixed window cannot be
"wrong" at any size — it just buys proportionally more at high
concentration while costing the same bounded latency everywhere. Two
measurement caveats, disclosed: (a) this host's ~15.6ms Windows timer
quantization means absolute latency figures quantize to timer ticks (all of
0/5/10ms read ≈15.5ms; the true per-window differences at 5/10ms are below
this platform's resolution — their ~zero broadcast effect is the decisive
signal anyway); (b) the harness's `totalCollabBroadcastSends` counter
combines Yjs + awareness + catch-up sends (production gauge semantics), so
awareness-only volume is not separately broken out here; awareness
coalescing (50ms) was not swept — out of scope. Per-run convergence is not
asserted by the harness; correctness rests on the test suites below plus
the edit-to-peer probe successfully delivering 118–119/expected frames in
every single run (end-to-end update flow verified at every tested window)
with zero errors, timeouts, connection failures, or slow-consumer/
backpressure events anywhere in the matrix.

**Decision: A — KEEP 25ms.** Rule B fails outright: 5–10ms preserve almost
none of the broadcast reduction (≤5% at ≤25 users vs 27–58% for 25ms), so
reducing would sacrifice nearly all of M6's benefit at low concentration
while buying nothing measurable in latency. Rule C fails: the data shows a
smooth monotonic benefit-vs-concentration curve with constant latency cost
— no crossover regime where a smaller window wins both dimensions, hence no
justification for adaptive complexity. Rule D inapplicable: 27/27 valid,
consistent-environment, low-noise runs. 25ms sits at a defensible knee:
bounded ~one-window latency cost, material reduction at every size ≥5
users, and best-in-class behavior exactly where broadcast volume actually
threatens the event loop.

Files: `backend/load-test/run.ts` (`--yjs-coalesce-ms` harness-only
override), `backend/load-test/m8-sweep.sh` (new driver script),
`backend/load-test/results/level-m8-baseline-{1,2,3,5,10,25,50}-*.{json,md}`
and
`backend/load-test/results/level-m8-sweep-{0,5,10,50}ms-{2,5,10,25,50}-*.{json,md}`
(27 runs), `backend/load-test/results/m8-sweep.log`. No production file,
nor any M5/M6/M7 evidence file, touched.

Verification: collaboration-focused regression (m6-collab-coalesce-
backpressure.test.ts, m4-collab.test.ts, shutdown-flush.test.ts,
virtualUser.test.ts, observability.test.ts) 56/56 PASS; full backend suite
317 passed / 4 skipped / 0 failed (unchanged); backend typecheck PASS
(frontend untouched — no frontend typecheck required, none run);
`git diff --check` clean.

**Next implementation milestone**: unchanged from the prior list — item 1
(the question this milestone answers) is now closed with decision A; the
remaining evidence-gated item is scaling validation at levels 100/500/1000+
per the original report's staging, under its own contract.

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
- `test/python-deps.test.ts`: passes in live-Docker runs (~46s execution time
  due to Docker/pip overhead), skipped in Docker-gated/Docker-unavailable environments.
  Not modified as part of any milestone.

## Current active work

Milestones 1–7b are committed (`3911f47`) and fully closed out. Milestone 8
(coalescing-window characterization — measurement only; decision: **KEEP the
fixed 25ms window**, no adaptivity justified) is implemented and verified in
this working tree, **not yet committed** — see its section above. Manual QA
execution for M1 (`scripts/qa/save-truthfulness.md`) remains outstanding
and un-gated, unchanged from before.

## Next recommended milestone

The SQLite/DB-threading question is resolved (Milestone 5c: **not
justified**), collaboration broadcast coalescing/backpressure is
implemented (Milestone 6), the 100-user RSS/event-loop growth is
attributed (Milestone 7: load-test harness client-replica lifecycle, not a
production collab/manager.ts leak), the harness itself is fixed and
confirmed to release those replicas (Milestone 7b), and the coalescing-window
characterization is complete (Milestone 8: **KEEP 25ms**, adaptive coalescing
not justified). No production memory-optimization or adaptive-coalescing work
is currently justified. Remaining evidence-gated work:

1. Attempt load levels 100/500/1000+, per the original report's staging.
   Not started; do not implement without a new contract.
