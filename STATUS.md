# STATUS

Last updated: 2026-08-24.

## Current state

- **Baseline:** `c9833eb` — "fix: enforce auth, ownership, and port allowlist on preview proxy WS upgrades"
- **This commit:** M1, M2, M3, and Milestone 2 (per-user sandbox quota +
  terminal concurrency gate) — all implemented, gated, and verified on top
  of that baseline.
- PR #1 and PR #2 merged previously; `fix/preview-proxy-ws-auth` branch deleted.

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

None — M1, M2, M3, and Milestone 2 (per-user sandbox quota + terminal
concurrency gate) are all implemented, gated, and verified: typecheck
clean, sandbox/terminal gate tests 12/12, `exec.test.ts` with Docker
11/11, M1/M2/M3 regression with Docker 62/2-skipped/0-failed, full backend
suite with Docker 269 passed / 1 failed (the pre-existing, unrelated
`python-deps.test.ts` failure documented above) / 4 skipped. Manual QA
execution for M1 (`scripts/qa/save-truthfulness.md`) remains outstanding
and un-gated by this commit.

## Next recommended milestone

Multiplayer correctness: the audit-identified test-coverage gaps for the
collaboration layer — no test with more than 2 simultaneous concurrent
editors in one room, no reconnect-storm test (many clients reconnecting at
once after a server restart), no room-lifecycle race test (client
reconnecting during a room's idle-disposal grace window), no room-count/
memory soak test. Not started; do not implement without a new contract.
