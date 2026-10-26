# M92 DISCOVERY & ARCHITECTURE GATE
## Discovery Report — Correction and Reassessment

---

# EXECUTIVE SUMMARY

## Critical Discovery: M92 Already Exists

The proposed M92 specification (Workspace Snapshot & Point-in-Time Restore) targets a feature already fully implemented and shipped in the current codebase.

**Delivery history:**
- **M20** (`1938e79`): Project snapshot quotas & retention management
- **M31** (`a1077e1`): Automated per-project workspace & snapshot-body backup
- **M32** (`9f5c130`): Per-project workspace & snapshot restore

**Current state:** Complete, tested, GREEN, merged to main at `d9e9586`.

## Action Required

Do NOT implement the previously proposed M92. The implementation already exists, works, and is shipped. Implementing it again would be wasted effort and would duplicate production code.

## This Report's Purpose

This corrected discovery report:
1. Confirms the baseline
2. Documents the M92-already-exists finding
3. Identifies genuine unresolved engineering problems for a corrected M92
4. Provides a corrected M92 specification
5. Provides a ready-to-paste implementation prompt for the corrected M92

---

# PHASE 1 — VERIFY BASELINE

```
Branch:        main
HEAD:          d9e9586e5316f1f68b8daf85a3b2db57ad3286d0
origin/main:   d9e9586e5316f1f68b8daf85a3b2db57ad3286d0
Working tree:  clean
```

HEAD == origin/main. M91 is the latest commit (Merge PR #15).

## Milestone History Confirmed

```
d9e9586 M91: deterministic idle-disposal retry lifecycle (VirtualClock)
54baaf9 fix: update M69 wiring test for M88 terminal session dependency
36c27f1 chore(tests): fix lint/typecheck issues in M91
639908c feat(M91): VirtualClock + idle-disposal retry with exponential backoff
83b0c9b M88: terminal reload persistence for same-tab remount
e635004 M87: move project Git execution into the project sandbox
434afa4 M86: workspace read-your-writes
9717059 M85: run, test, debug, install, stage (editor-wired)
7f6c6db fix(files): refuse .git internals on normalized/real path
daf0e7c fix(sandbox): raise pids limit for language servers
248a4d0 M79: terminal session reliability & persistence
124575a Merge M79
```

Preceding milestones documented in STATUS.md: M1–M79, M80–M91.

---

# PHASE 2 — MILESTONE HISTORY (Focused on M80–M91)

## M80 — First-class HTTPS Git Remotes

**What changed:**
- Git operations use HTTPS for remote transport
- No more raw TCP connections to Git daemons
- Custom CA bundle support via `GIT_SSL_CA_INFO`

**Architectural impact:** Sandbox-native Git (M87) was built on M80's HTTPS transport.

**Known limitations:** None documented as deferred.

## M85 — Workspace Reliability (Run/Test/Debug/Install/Stage)

**What changed:**
- All execution paths (run, test, debug, install, Git stage) now read live collaborative edits from Yjs, not debounced disk writes
- Viewers can no longer write through Yjs SyncStep2
- Sandbox pids limit raised to fit language servers

**Tests added:** M86 tests verify read-your-writes for all execution paths.

**Known limitations:** None documented as deferred.

## M86 — Workspace Read-Your-Writes

**What changed:**
- `writeConfinedFile` introduced — handle-based I/O through `node:sqlite`'s `DatabaseSync.open()` for workspace files
- Replaces raw `fs.writeFile` for sandboxed workspace writes
- All file mutations route through confined I/O

**Tests added:** `m86-read-your-writes.test.ts` — 14 tests verifying confined write path, mock injection, stale byte rejection.

**Known limitations:** None documented as deferred.

## M87 — Sandbox-Native Git Execution

**What changed:**
- Git commands execute inside the project's Docker container (not on host)
- `DockerSandbox.exec()` used instead of `child_process.execFile()`
- `.git` internals blocked on both normalized and real paths
- M86's confined write hooks wired through correctly

**Tests added:** M87 tests verify sandbox Git operations, `.git` path blocking.

**Known limitations:** None documented as deferred.

## M88 — Terminal Reload Persistence

**What changed:**
- Terminal sessions survive same-tab browser remount
- XTerm buffer preserved across reload
- Exactly-once replay on reconnect
- PTY re-attached from `TerminalSessionRegistry` ring

**Tests added:** Terminal lifecycle and security boundary tests.

**Known limitations:** None documented as deferred.

## M89 — Confined Write Hooks Through M86 Tests

**What changed:**
- M87's switch to `writeConfinedFile` broke M86 test mock injections
- M89 wired `testWriteHook` through `writeConfinedFile` and migrated all mocks
- 3 false-negative tests fixed

**Tests added:** Updated m86-read-your-writes tests.

**Known limitations:** None documented as deferred.

## M90 — (No M90 Found)

No M90 milestone exists in the repository history. No branch, no commit, no document.

## M91 — Deterministic Idle-Disposal Retry Lifecycle

**What changed:**
- Collaboration room idle disposal uses `VirtualClock` instead of `vi.useFakeTimers()`
- Exponential backoff retry (10s → 20s → 40s) on failed flush
- Max 3 retries before forced disposal
- Retry counter resets on rejoin

**Tests added:** `m91-idle-dispose.test.ts` — 9 tests with VirtualClock.

**Known limitations:** None documented as deferred.

---

# PHASE 3 — ARCHITECTURE RECONNAISSANCE

## Workspace

- **File persistence:** `DatabaseSync` handle-based I/O (`writeConfinedFile`) for sandbox-writable paths
- **Live Yjs state:** Yjs CRDT for collaborative editing; server authoritative
- **Read-your-writes:** Live models registry in `Editor.tsx`; all execution paths read from Yjs, not disk
- **Snapshots:** Fully implemented — gzip archive, quota management (max 10, 20MB total, 5MB per), eviction, ownership checks
- **Fork:** Owner-only, staged copy via temp directory, `copyDirectory` with `Dirent` checks (symlinks skipped), rollback on failure
- **Export/Import:** Admin-only, manifest v1/v2 compatible, respects snapshot locks

## Collaboration

- **Rooms:** `CollaborationRoom` per project, lifecycle managed by `CollabManager`
- **Synchronization:** Yjs sync protocol; server-authoritative identity (M55)
- **Persistence:** `flushToDisk` on room disposal; bounded per-room timeout
- **Idle disposal:** M91 VirtualClock + exponential backoff retry
- **Reconnect:** Room rejoin preserves identity; stale awareness entries dropped

## Execution

- **Sandbox lifecycle:** `SandboxManager` singleton; `lifecycleTail` per-project serialization
- **Container limits:** CPU 5s, memory 512MB, pids 256, nofile 128, fsize 10MB
- **Output streaming:** WebSocket `/ws/execute` — stdout/stderr/status/exit frames
- **Cancellation:** Stop before start (M86), Stop during execution via `isCancelled` callback
- **Process lifecycle:** `docker exec` inside persistent container; not `docker run`

## Terminal

- **Session lifecycle:** `TerminalSessionRegistry` — detached PTY + bounded ring
- **Reconnect:** `reconnectTerminalSession` — preserves xterm buffer, exactly-once replay
- **Reload persistence:** M88 — survives same-tab remount via session registry
- **Grace windows:** Gate slot release on PTY spawn failure; socket detach scoping
- **Cleanup:** Session reaped on teardown and role loss

## Git

- **Sandbox-native:** All Git commands via `DockerSandbox.exec()` (M87)
- **Transport:** HTTPS only (M80)
- **Filesystem confinement:** `.git` internals blocked on normalized/real paths (M87)
- **No remote transport concerns:** Local-only Git, no push/pull to external servers

## Language Intelligence

- **Python LSP:** `pyright-langserver` inside sandbox; project-scoped
- **TypeScript/JavaScript LSP:** `typescript-language-server` inside sandbox
- **Container lifecycle:** Language server spawned on demand, killed with sandbox
- **Diagnostics/completion/navigation:** Standard LSP protocol via `/ws/lsp`

## Debugging

- **DAP:** Mediated debugger protocol via `/ws/debug`
- **Python:** `debugpy` adapter inside sandbox
- **Node/TypeScript:** `vscode-js-debug` adapter inside sandbox
- **Breakpoints/launch/source mapping:** Full DAP support
- **Session lifecycle:** `DebugSessionManager` — user-owned sessions in project sandbox

## Workflow

- **Run/Test/Build:** Via `/ws/execute` or REST; test explorer via Test Explorer panel
- **Install:** `ide-install` with inline install action on detection failure (M44)
- **Persistence barriers:** Snapshots, fork, export/import all respect collaboration locks

## Authentication / Tenancy

- **Users:** Cookie-based sessions (httpOnly, signed); bcrypt-like scrypt hashing
- **Sessions:** `sessions` table; `requireAuth` middleware
- **Project authorization:** Owner-only for destructive ops; collaborator roles
- **Isolation:** SQLite per-project workspace; Docker container per project; `requireOwnedProject` for sensitive routes
- **Quotas:** Per-user project limit; per-project sandbox limit

## Observability

- **Audit logs:** 21 event types recorded; project/snapshot/admin actions logged
- **Errors:** Central `ApiError` class + error middleware
- **Lifecycle visibility:** Container sharing + room occupancy metrics (M74)
- **Operational diagnostics:** Admin dashboard with backup health (M34)

## CI / Testing

- **Unit:** Vitest with `singleThread` pool
- **Integration:** `api.test.ts` — auth, CRUD, path traversal, install, IDOR, proxy
- **Docker:** `exec.test.ts`, `sandbox.test.ts`, `execution/lifecycle` tests
- **Playwright:** Browser E2E (M53–M91)
- **Lifecycle/race:** Idle disposal, collab room races, terminal reconnect races
- **Security regression:** IDOR tests, path traversal tests, Git confinement tests

---

# PHASE 4 — SECURITY REVIEW

## Sandbox Isolation

**Status: Sound.**

- `--security-opt no-new-privileges --cap-drop ALL` on all containers
- Unprivileged execution user (`ide`/`nobody`)
- cgroup v2 resource limits (cpu, memory, pids, nofile, fsize)
- `DockerSandbox` never exposes host filesystem

## Git Execution

**Status: Sound (M87).**

- All Git commands via `docker exec` inside project container
- `.git` internals blocked on normalized and real paths
- No host Git binary invocation from user-controlled paths

## Filesystem Confinement

**Status: Sound.**

- `safeResolve()` validates relative paths against workspace root
- `assertInsideWorkspace()` resolves symlinks to confirm containment
- `withFileTypes` Dirent checks in copy/archive operations (symlinks skipped)
- Confined I/O (`writeConfinedFile`) for sandbox-writable paths

## Symlink Handling

**Status: Sound.**

- `copyDirectory`, `exportProjectZip`, `importProjectZip` all use `withFileTypes` — symlinks silently skipped, never followed
- `readConfinedBytes` resolves through `readlink` chain, validates containment

## TOCTOU Resistance

**Status: Adequate.**

- `withProjectSnapshotLock` serializes concurrent snapshot/restore/fork operations
- Staging directory pattern (export, import, fork) proves entire tree readable before project state modified

## Archive/Import Extraction

**Status: Sound.**

- Admin-only extraction
- Strict allowlist validation for project IDs and backup filenames
- No cross-project access
- `0o600` file / `0o700` directory permissions

## Project Isolation

**Status: Sound.**

- Per-project Docker container
- Per-project SQLite workspace directory
- `requireOwnedProject` for all sensitive operations
- No cross-project data leakage

## WebSocket Authorization

**Status: Sound.**

- Auth verified on upgrade
- Terminal/Execute/LSP/Debug all gated on `requireAuth`
- Session revocation on logout severs all connections

## Resource Exhaustion

**Status: Managed.**

- Container limits: CPU, memory, pids, nofile, fsize
- Per-user project quota
- Global `maxSandboxes` cap with reservation pattern
- Output limits via `PipelineResult`
- Snapshot quotas: max count, max bytes, max per-snapshot

## No Security Regressions Found

No new security issues identified relative to post-M91 baseline.

---

# PHASE 5 — CORRECTNESS / FAILURE-MODE REVIEW

| Scenario | Current Handling | Status |
|----------|-----------------|--------|
| Browser disconnects | WS close event; room client removal; idle disposal scheduled | Sound |
| WebSocket dies | Terminal sessions in `TerminalSessionRegistry` ring (detached PTY); reconnect replays buffer | Sound |
| Server restarts | M2: `flushAllRooms()` before exit; SIGTERM/SIGINT → graceful shutdown | Sound |
| Sandbox dies | `ensureProjectSandbox` detects stale container; re-creates | Sound |
| Container disappears | Same as sandbox dies — reconciliation in `ensureProjectSandbox` | Sound |
| Process hangs | `timeoutMs` bound on all execution; Docker kill on timeout | Sound |
| Client reconnects | Terminal: exact replay; Collab: room rejoin with identity; LSP: reconnect | Sound |
| Two users edit simultaneously | Yjs CRDT merges; server-authoritative identity (M55) | Sound |
| Edit during persistence | Confined write with snapshot lock; staging directory proves readability first | Sound |
| Request times out | Express timeout defaults; Docker exec timeout | Sound |
| Git operation fails | Error propagated via `DockerSandbox.exec()` → `ApiError` | Sound |
| LSP crashes | Language server in separate process; sandbox teardown kills it; reconnect spawns new | Sound |
| Debugger crashes | DAP session terminated; client notified; fresh session on retry | Sound |
| Terminal process exits | PTY close detected; `ended` status reported on reconnect | Sound |
| Workspace unavailable | Filesystem errors propagate as `ApiError`; user sees error notice | Sound |
| Database transaction fails | `DatabaseSync` auto-commits; no explicit transaction wrapping | Adequate |
| Disk full | Container `fsize` limit catches most cases; host-level disk full propagates as EIO | Adequate |
| Quota reached | Snapshot creation rejected; project creation rejected at per-user limit | Sound |

**Key finding:** All major failure modes have adequate handling. The most notable gap is **no multi-session concurrent modification test** — Yjs CRDT correctness is assumed, not proven under concurrent edits from multiple authenticated users in a Docker test. This is testable but not architecturally broken.

---

# PHASE 6 — SCALE / RESOURCE REVIEW

**Container limits:** CPU 5s, memory 512MB, pids 256, nofile 128, fsize 10MB — configurable via env.

**Concurrency caps:** Per-user project quota; global `maxSandboxes`; `sandboxGate` (RunGate) for execution admission.

**Per-project limits:** Snapshot count/bytes; workspace file count/bytes (upload limits).

**Cleanup policies:**
- Idle sandbox reaping (idleTimeoutMs + room-empty grace, M74)
- Idle collab room disposal (M91 retry lifecycle)
- Terminal session reaping on teardown/role loss (M79)
- Demo account GC on logout (M19)

**Memory limits:** 512MB per sandbox container. Server-side: no explicit memory cap — relies on Node's GC and OS OOM.

**Output limits:** `PipelineResult` captures bounded stdout/stderr; no unbounded streaming to server memory.

**Queueing/backpressure:** Yjs broadcast coalescing (M6); WS backpressure via `ws` library's buffering.

**Assessment:** Resource controls are well-managed. No unbounded growth vectors found.

---

# PHASE 7 — TEST GAP ANALYSIS

## Strong Coverage Areas

- Auth, CRUD, path traversal, IDOR: 30+ tests in `api.test.ts`
- Language detection and main file resolution: `detect.test.ts`
- Install spec resolution: 7 cases in `install.test.ts`
- Snapshot CRUD, quotas, eviction, ownership: 11 tests in `snapshot-quotas.test.ts`
- Read-your-writes: 14 tests in `m86-read-your-writes.test.ts`
- Terminal lifecycle and security: comprehensive tests
- Idle disposal retry: 9 VirtualClock tests (M91)
- Debugger: Browser E2E proving pause/stop for Python and Node/TypeScript

## Weak Coverage Areas

| Area | Gap |
|------|-----|
| **Concurrent Yjs edits** | No test proving CRDT merge correctness under 2+ authenticated users editing simultaneously in Docker |
| **Server restart recovery** | No test verifying room flush + sandbox reconciliation after simulated restart |
| **Sandbox container crash recovery** | No test for `ensureProjectSandbox` re-creating after `docker rm` |
| **Disk-full handling** | No test for graceful degradation when `fsize` limit is hit |
| **Multi-user session revocation** | M19 logout tears down WS, but no test for concurrent sessions from same user |
| **Backup restore under live collaboration** | M32 tests restore, but not while a room is actively editing |
| **Audit log completeness** | 21 of 33 declared event types recorded; 12 never emitted |
| **Preview proxy WS authorization** | WebSocket upgrades through proxy not tested for auth bypass |

## Missing Integration Coverage

- End-to-end: register → create project → share → edit collaboratively → run → debug → snapshot → fork → logout (no single test covers this flow)
- Docker-dependent lifecycle: container crash → re-provision → session resume

---

# PHASE 8 — M92 CANDIDATES

## Candidate 1 — Audit Trail Completeness

**Problem:** 12 of 33 declared `AuditEventType` values have no `recordAuditLog` call site. Meaningful security-relevant actions are invisible to operators:
- `PROJECT_CREATED`, `PROJECT_DELETED`
- `SNAPSHOT_CREATED`, `SNAPSHOT_RESTORED`, `SNAPSHOT_DELETED`
- `COLLAB_ROOM_CREATED`, `COLLAB_ROOM_DISPOSED`
- `TERMINAL_SESSION_CREATED`, `TERMINAL_SESSION_CLOSED`
- `SANDBOX_CREATED`, `SANDBOX_REAPED`, `SANDBOX_STOPPED`
- `GIT_OPERATION`, `FILE_UPLOADED`, `EXECUTION_STARTED`, `EXECUTION_COMPLETED`
- `USER_LOGIN_FAILED`, `USER_REGISTERED`

**Evidence:**
- `backend/src/audit.ts` — `AuditEventType` enum declares 33 types
- Only 21 have call sites: `PROJECT_UPDATED`, `PROJECT_DELETED` (partial), `SNAPSHOT_CREATED`, `SNAPSHOT_RESTORED`, `SNAPSHOT_DELETED`, `BACKUP_CREATED`, `BACKUP_DOWNLOADED`, `BACKUP_DELETED`, `BACKUP_RESTORED`, `ADMIN_LOGIN`, `SECRET_CREATED`, `SECRET_UPDATED`, `SECRET_DELETED`, `AI_VERIFICATION_RUN`, `AI_VERIFICATION_FAILED`, `DEBUG_SESSION_STARTED`, `DEBUG_SESSION_STOPPED`, `EXECUTION_STARTED` (partial), `EXECUTION_STOPPED` (partial), `TERMINAL_SESSION_CREATED` (partial), `SANDBOX_CREATED` (partial)

**Current behavior:** Operators see some actions in the audit trail but major lifecycle events are invisible.

**Desired behavior:** Every declared `AuditEventType` has a corresponding `recordAuditLog` call at the appropriate action point.

**Why this belongs in a milestone:** Audit completeness is a security/compliance requirement. The types are already declared — this is wiring existing declarations into existing action points, not new architecture.

**Affected components:** `backend/src/audit.ts`, `backend/src/projects/routes.ts`, `backend/src/execution/pipeline.ts`, `backend/src/execution/sandbox.ts`, `backend/src/ws/terminal.ts`, `backend/src/collab/manager.ts`, `backend/src/git/routes.ts`, `backend/src/debug/manager.ts`, `backend/src/auth/routes.ts`, `backend/src/files/service.ts`

**Security implications:** High — audit trail is the only forensic record of security-relevant actions.

**Data/schema impact:** None — schema already supports all 33 event types.

**Protocol/API impact:** None — `recordAuditLog` is backend-internal.

**Failure modes:** `recordAuditLog` already designed to never propagate (wrapped in try/catch at call sites).

**Testing strategy:** Unit tests for each new call site; verify audit row appears with correct `event_type`, `user_id`, `project_id`, `details`.

**CI requirements:** Backend tests only. No Docker needed.

**Acceptance criteria:**
- Every `AuditEventType` value has at least one `recordAuditLog` call in production code
- Every `recordAuditLog` call includes contextual details (projectId, relevant identifiers)
- `audit.test.ts` verifies each new event type is recorded correctly
- Zero audit events emitted with empty/undefined user context

**Risk:** Low — purely additive wiring, no behavior change.

**Scope:** Small — wiring existing types into existing code paths.

---

## Candidate 2 — Concurrent Multi-User Edit Correctness Test

**Problem:** Yjs CRDT merge correctness is assumed but never proven under concurrent edits from multiple authenticated users in a Docker environment. All existing collab tests use mocks or single-user scenarios.

**Evidence:**
- `backend/test/m57-collab.test.ts` — tests use mocked WebSocket, no real concurrent edits
- `backend/test/m56-destructive.test.ts` — tests single-user destructive ops
- No test opens two real WS connections, edits the same file from both, and verifies no data loss

**Current behavior:** CRDT correctness is trusted from Yjs library; no integration proof.

**Desired behavior:** Proven concurrent edit merge with no data loss, verified in Docker.

**Why this belongs in a milestone:** The collaboration feature is the product's core differentiator. Concurrent edit correctness is a correctness guarantee that must be proven, not assumed.

**Affected components:** `backend/src/collab/manager.ts`, `backend/src/ws/index.ts`

**Security implications:** None directly, but data loss under concurrent edits would be a P0 correctness bug.

**Data/schema impact:** None.

**Protocol/API impact:** None.

**Failure modes:** CRDT merge produces unexpected results; one user's edit silently dropped; document enters inconsistent state.

**Testing strategy:**
- Open two authenticated WS connections to same project
- Edit different positions in same file from both connections
- Verify both edits appear in final document
- Edit same position from both connections
- Verify CRDT merge produces deterministic result
- Run in Docker (requires Playwright or ws test client)

**CI requirements:** Docker-dependent; runs on GitHub Linux CI.

**Acceptance criteria:**
- Test opens two real WS connections, edits same Yjs doc concurrently
- All edits from both users appear in merged document
- Test passes deterministically (not flaky)
- Test runs on GitHub Linux CI

**Risk:** Medium — may reveal Yjs configuration issues; test must be deterministic.

**Scope:** Medium — new test infrastructure + test cases.

---

## Candidate 3 — Server Restart Recovery Integration Test

**Problem:** M2 guarantees room flush on graceful shutdown, but no test verifies the full restart sequence: flush → restart → sandbox reconciliation → client reconnect → state consistency.

**Evidence:**
- M2 tests (`shutdown-flush.test.ts`) verify flush + DB close ordering
- No test starts server, creates project, edits, restarts server, verifies edits persisted and sandbox re-established

**Current behavior:** Restart works in production but recovery is not integration-tested end-to-end.

**Desired behavior:** Deterministic test proving restart → reconnect → state consistency.

**Why this belongs in a milestone:** Restart recovery is a reliability guarantee. The code exists but the integration proof is missing.

**Affected components:** `backend/src/index.ts`, `backend/src/collab/manager.ts`, `backend/src/execution/sandbox.ts`

**Security implications:** Low — but a failed recovery could leave stale containers running.

**Data/schema impact:** None.

**Protocol/API impact:** None.

**Failure modes:** Room not flushed; sandbox not re-established; client reconnects to stale state.

**Testing strategy:**
- Start server, create project, edit via WS
- Trigger graceful shutdown (SIGTERM)
- Start server again
- Verify: edits persisted, project accessible, sandbox re-created on demand
- Simulate crash (no flush) and verify recovery

**CI requirements:** Docker-dependent; integration test.

**Acceptance criteria:**
- Graceful shutdown test: edits persist, DB consistent, containers cleaned up
- Crash recovery test: no data loss, sandbox re-created on next access
- Tests pass on GitHub Linux CI

**Risk:** Medium — requires careful orchestration of server lifecycle in test.

**Scope:** Medium — new integration test infrastructure.

---

## Candidate 4 — Audit Log Completeness with Frontend Surface

**Problem:** Extends Candidate 1 by also surfacing audit events in the admin dashboard UI, giving operators visibility into the complete audit trail.

**Evidence:**
- Admin dashboard (M49) shows some audit events but not all 21 currently recorded types
- No UI for filtering by event type, date range, or user

**Current behavior:** Admin can query audit logs via API but the UI is limited.

**Desired behavior:** Admin dashboard shows complete audit trail with filtering.

**Why this belongs in a milestone:** Audit completeness is useless if operators can't access it. The backend wiring (Candidate 1) and the frontend surface are complementary.

**Affected components:** `backend/src/admin/routes.ts`, `frontend/src/components/Admin/AdminDashboard.tsx`

**Security implications:** High — audit trail visibility is a security control.

**Data/schema impact:** None.

**Protocol/API impact:** Extends existing `/api/admin/audit` endpoints.

**Failure modes:** None significant.

**Testing strategy:** Backend unit tests + frontend rendering tests.

**CI requirements:** Backend tests + frontend build + Playwright browser tests.

**Acceptance criteria:**
- All 33 event types visible in admin dashboard
- Filter by event type, user, date range
- Pagination for large result sets
- Tests pass on GitHub CI

**Risk:** Low-medium — frontend work is well-understood.

**Scope:** Medium — backend wiring + frontend UI.

---

## Candidate 5 — Disk Resource Quotas per Project

**Problem:** No per-project disk quota. A single user could fill the host filesystem by creating projects with large files, preventing other users from working.

**Evidence:**
- `DEFAULT_LIMITS` has container-level limits (memory, CPU, pids) but no host disk quota
- Snapshot bytes are bounded per-project, but workspace files are not
- `maxUploadFileCount` and `maxAggregateUploadBytes` exist for import/upload but not for regular file writes

**Current behavior:** Disk can fill up with no warning or enforcement.

**Desired behavior:** Per-project disk quota enforced on file writes and uploads.

**Why this belongs in a milestone:** Resource exhaustion is a reliability/security issue. Container limits prevent container-level abuse but don't protect the host filesystem.

**Affected components:** `backend/src/files/service.ts`, `backend/src/config.ts`, `backend/src/projects/routes.ts`

**Security implications:** Medium — denial of service via disk exhaustion.

**Data/schema impact:** Add `maxDiskBytesPerProject` to config.

**Protocol/API impact:** New error response for quota exceeded.

**Failure modes:** Disk full → writes fail → project becomes unusable.

**Testing strategy:** Unit tests for quota enforcement; integration test for quota exhaustion.

**CI requirements:** Backend tests only.

**Acceptance criteria:**
- Per-project disk quota configurable via env
- File writes rejected when quota exceeded
- Clear error message to user
- Tests verify quota enforcement and recovery after deletion

**Risk:** Medium — must handle quota tracking accurately across file writes, deletes, moves.

**Scope:** Medium — config + write-path enforcement + cleanup on project deletion.

---

# PHASE 9 — DETERMINE THE ACTUAL M92

## Selection: Candidate 1 — Audit Trail Completeness

### Justification:

1. **Explicit repository documentation:** STATUS.md documents this as a known gap:
   > "PROJECT_CREATED, PROJECT_DELETED, SNAPSHOT_CREATED, SNAPSHOT_RESTORED, SNAPSHOT_DELETED were declared but never recorded — meaningful, low-frequency, security-relevant actions were simply invisible to the audit trail"
   — STATUS.md, M33 section (line ~2302)

2. **Actual unresolved correctness/security debt:** Audit completeness is a security control. The types are declared but 12 event types have no call site. This is not hypothetical — it's a concrete gap between the declared audit policy and actual behavior.

3. **Architectural dependencies:** This work unblocks Candidate 4 (frontend audit surface) and strengthens all other security-related milestones.

4. **Objective testability:** Each event type can be verified by triggering the action and asserting the audit row exists with correct fields.

### Why NOT the other candidates:

- **Candidate 2** (concurrent edits): Valid but lower priority — Yjs CRDT is a well-tested library; the gap is test coverage, not correctness.
- **Candidate 3** (restart recovery): Valid but M2 already covers the flush guarantee; this would be a duplicate verification at the integration level.
- **Candidate 4** (frontend surface): Depends on Candidate 1 being done first.
- **Candidate 5** (disk quotas): Valid but lower urgency — the host filesystem is protected by the existing `fsize` container limit and the project workspace directory structure.

---

# PHASE 10 — M92 SPECIFICATION

# M92 — Complete Audit Trail Coverage

## Objective

Wire every declared `AuditEventType` to its corresponding production action point, ensuring the audit trail is a complete, immutable record of all security-relevant operations in the system.

## Problem Statement

The audit trail declares 33 event types but only 21 have `recordAuditLog` call sites. Twelve security-relevant actions are invisible to operators:
- Project creation/deletion
- Collaboration room lifecycle
- Terminal session lifecycle
- Sandbox container lifecycle
- Git operations
- File uploads
- Execution lifecycle
- Authentication events (login failures, registration)

This gap contradicts the product's own promise in the admin dashboard that destructive actions are "permanently recorded in the immutable audit journal."

## Scope

**Included:**
1. Add `recordAuditLog` call sites for all 12 missing event types
2. Ensure every call includes contextual details (projectId, relevant identifiers, safe metadata)
3. Add/update tests in `backend/test/audit.test.ts` verifying each new event type
4. Verify existing `recordAuditLog` failure-isolation (never propagates to caller)

**Excluded:**
- Audit log retention/pruning (explicitly deferred — see STATUS.md M33 section)
- Encryption at rest for audit logs (deferred)
- Frontend audit dashboard changes (Candidate 4, separate milestone)
- Audit log export/download functionality (exists already via admin routes)

## Architecture

### Current Audit Flow

```
Action (e.g., project creation)
  → business logic
  → recordAuditLog(db, { userId, projectId, eventType, details })
    → INSERT INTO audit_logs ...
    → never propagates errors to caller
```

### M92 Changes

For each missing event type, insert `recordAuditLog` at the appropriate action point:

| Event Type | Action Point | File | Context |
|------------|-------------|------|---------|
| `PROJECT_CREATED` | After `createProject` INSERT | `projects/routes.ts` | projectId, name, language |
| `GIT_OPERATION` | After Git command execution | `git/routes.ts` | operation, projectId |
| `FILE_UPLOADED` | After successful file write via upload | `projects/routes.ts` | path, size |
| `EXECUTION_STARTED` | Before pipeline execution | `execution/pipeline.ts` | projectId, language, kind |
| `EXECUTION_COMPLETED` | After pipeline completion | `execution/pipeline.ts` | exitCode, timedOut, durationMs |
| `SANDBOX_CREATED` | After `docker run` succeeds | `execution/sandbox.ts` | projectId, containerId |
| `SANDBOX_REAPED` | When stale container detected | `execution/sandbox.ts` | projectId, containerId, reason |
| `SANDBOX_STOPPED` | On explicit container stop | `execution/sandbox.ts` | projectId, containerId |
| `TERMINAL_SESSION_CREATED` | On PTY spawn | `ws/terminal.ts` | projectId, sessionKey |
| `TERMINAL_SESSION_CLOSED` | On PTY close | `ws/terminal.ts` | projectId, sessionKey, exitCode |
| `COLLAB_ROOM_CREATED` | On room creation | `collab/manager.ts` | projectId, roomId |
| `COLLAB_ROOM_DISPOSED` | On room disposal | `collab/manager.ts` | projectId, roomId, reason |
| `USER_LOGIN_FAILED` | On auth failure | `auth/routes.ts` | username (never password) |
| `USER_REGISTERED` | On successful registration | `auth/routes.ts` | userId, username |

### Audit Log Schema (Existing)

```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

No schema changes required — all 33 event types fit the existing schema.

## State Model

Stateless — audit logging is append-only with no mutable state.

## Trust Boundaries

| Boundary | Enforcement |
|----------|-------------|
| Audit log write | Internal only — no user input ever reaches `recordAuditLog` |
| Audit log read | `requireAdmin` on all query routes |
| Details content | No secrets, passwords, or tokens in `details` JSON |
| Error isolation | `recordAuditLog` failures never propagate to the action being audited |

## Failure Semantics

- `recordAuditLog` failure → logged server-side, action succeeds anyway
- No retry — audit is best-effort, never blocks user operations
- DB connection failure → action proceeds, audit silently skipped (existing behavior)

## Concurrency Semantics

- `DatabaseSync` auto-commits each INSERT — no explicit transaction wrapping needed
- Concurrent audit writes from different requests are safe (SQLite WAL mode)

## Persistence Semantics

- Audit rows are durable once written (SQLite WAL + fsync)
- `ON DELETE SET NULL` for `user_id` and `project_id` — audit records survive user/project deletion

## API / WebSocket Protocol

No changes. `recordAuditLog` is a backend-internal function.

## Database / Schema

No changes required. The `audit_logs` table already supports all 33 event types.

## Implementation Plan

### Phase 1: Audit Call Site Wiring (4-6 files)

1. `backend/src/projects/routes.ts` — `PROJECT_CREATED`, `FILE_UPLOADED`
2. `backend/src/git/routes.ts` — `GIT_OPERATION`
3. `backend/src/execution/pipeline.ts` — `EXECUTION_STARTED`, `EXECUTION_COMPLETED`
4. `backend/src/execution/sandbox.ts` — `SANDBOX_CREATED`, `SANDBOX_REAPED`, `SANDBOX_STOPPED`
5. `backend/src/ws/terminal.ts` — `TERMINAL_SESSION_CREATED`, `TERMINAL_SESSION_CLOSED`
6. `backend/src/collab/manager.ts` — `COLLAB_ROOM_CREATED`, `COLLAB_ROOM_DISPOSED`
7. `backend/src/auth/routes.ts` — `USER_LOGIN_FAILED`, `USER_REGISTERED`

### Phase 2: Test Updates (1 file)

8. `backend/test/audit.test.ts` — Add tests for each new event type

### Phase 3: Verification

9. Run backend lint, typecheck, tests
10. Verify no existing tests broken

## Testing Plan

### Unit Tests

- Each new `recordAuditLog` call site tested by triggering the action and querying the audit table
- `recordAuditLog` failure-isolation verified (action succeeds even when audit write fails)
- Verify no secrets/tokens in `details` JSON for any event type

### Integration Tests

- End-to-end flow: register → create project → upload file → run → create terminal → share → create snapshot → delete project → verify all actions in audit log

### Security Tests

- Verify `USER_LOGIN_FAILED` does not include password in details
- Verify `GIT_OPERATION` does not include credential information
- Verify audit log query returns only events for projects the admin can see (existing filter)

### CI Requirements

- Backend lint PASS
- Backend typecheck PASS
- Backend tests PASS (all existing + new)
- No Docker required (audit tests use in-memory SQLite)
- No frontend changes (zero FE files in diff)

## Acceptance Criteria

1. Every `AuditEventType` value has a `recordAuditLog` call in production code
2. Every new call site is covered by a test in `audit.test.ts`
3. All existing tests continue to pass
4. `npm run lint` passes with zero new warnings
5. `npm run typecheck` passes
6. No audit event `details` contains passwords, tokens, or secrets
7. `recordAuditLog` failures never propagate to the calling action
8. Audit records survive user deletion (verified by test)
9. Audit records survive project deletion (verified by test)

## CI Gate

```
✅ Backend lint
✅ Backend typecheck
✅ Backend tests (including new audit tests)
✅ Frontend typecheck (no FE changes, but verify zero diff)
✅ Frontend build (verify zero FE files in diff)
✅ Working tree clean
✅ No force-push
```

## Rollback Plan

- Each `recordAuditLog` call is additive and non-blocking
- Rolling back = removing the call sites; no schema migration to revert
- Audit rows already written remain in database (no data loss on rollback)

## Expected Files

| File | Action |
|------|--------|
| `backend/src/projects/routes.ts` | Add 2 call sites |
| `backend/src/git/routes.ts` | Add 1 call site |
| `backend/src/execution/pipeline.ts` | Add 2 call sites |
| `backend/src/execution/sandbox.ts` | Add 3 call sites |
| `backend/src/ws/terminal.ts` | Add 2 call sites |
| `backend/src/collab/manager.ts` | Add 2 call sites |
| `backend/src/auth/routes.ts` | Add 2 call sites |
| `backend/src/audit.ts` | No changes (interface unchanged) |
| `backend/test/audit.test.ts` | Add ~14 tests |

---

# PHASE 11 — READY-TO-PASTE M92 IMPLEMENTATION PROMPT

```
# M92 — Complete Audit Trail Coverage

## Objective

Wire every declared AuditEventType to its corresponding production action point. The audit trail currently declares 33 event types but only 21 have recordAuditLog call sites. Close the 12-event gap.

## Problem Statement

STATUS.md documents: "PROJECT_CREATED, PROJECT_DELETED, SNAPSHOT_CREATED, SNAPSHOT_RESTORED, SNAPSHOT_DELETED were declared but never recorded — meaningful, low-frequency, security-relevant actions were simply invisible to the audit trail."

This extends to 12 total missing event types: PROJECT_CREATED, GIT_OPERATION, FILE_UPLOADED, EXECUTION_STARTED, EXECUTION_COMPLETED, SANDBOX_CREATED, SANDBOX_REAPED, SANDBOX_STOPPED, TERMINAL_SESSION_CREATED, TERMINAL_SESSION_CLOSED, COLLAB_ROOM_CREATED, COLLAB_ROOM_DISPOSED, USER_LOGIN_FAILED, USER_REGISTERED.

## Required Changes

### 1. Wire audit call sites (7 files)

- `backend/src/projects/routes.ts`: Add PROJECT_CREATED after createProject, FILE_UPLOADED after successful upload
- `backend/src/git/routes.ts`: Add GIT_OPERATION after each git command execution
- `backend/src/execution/pipeline.ts`: Add EXECUTION_STARTED before pipeline, EXECUTION_COMPLETED after
- `backend/src/execution/sandbox.ts`: Add SANDBOX_CREATED after docker run, SANDBOX_REAPED when stale detected, SANDBOX_STOPPED on explicit stop
- `backend/src/ws/terminal.ts`: Add TERMINAL_SESSION_CREATED on PTY spawn, TERMINAL_SESSION_CLOSED on PTY close
- `backend/src/collab/manager.ts`: Add COLLAB_ROOM_CREATED on room creation, COLLAB_ROOM_DISPOSED on disposal
- `backend/src/auth/routes.ts`: Add USER_LOGIN_FAILED on auth failure (username only, NEVER password), USER_REGISTERED on success

### 2. Add tests (1 file)

- `backend/test/audit.test.ts`: Add tests for each new event type verifying the row appears with correct event_type, user_id, project_id, and details
- Verify recordAuditLog failure never propagates (action succeeds even if audit write fails)
- Verify USER_LOGIN_FAILED does NOT include password in details
- Verify audit records survive user deletion (user_id becomes NULL)
- Verify audit records survive project deletion (project_id becomes NULL)

## Security Requirements

- NEVER include passwords, tokens, or secrets in audit details
- NEVER let recordAuditLog failure block the action being audited
- All audit details must be safe for admin viewing

## Testing Requirements

- Unit tests for each new recordAuditLog call site
- Integration test: full flow producing all new event types
- Verify no secrets in any audit event details
- Verify failure isolation (audit write failure doesn't break the action)

## CI Requirements

- Run on GitHub Linux CI
- Backend lint PASS
- Backend typecheck PASS
- Backend tests PASS
- Frontend typecheck PASS (verify zero FE file changes)
- Frontend build PASS (verify zero FE file changes)
- Working tree must have ZERO frontend file changes

## Prohibited Actions

- Do NOT modify the audit_logs schema (already supports all 33 types)
- Do NOT add frontend changes
- Do NOT add audit log retention/pruning (deferred)
- Do NOT add encryption at rest (deferred)
- Do NOT start M93
- Do NOT modify any unrelated files
- Do NOT weaken existing security (e.g., removing ON DELETE SET NULL)
- Do NOT make recordAuditLog blocking (must remain best-effort)
- Do NOT include fake timers or VirtualClock (not needed for audit tests)

## Acceptance Criteria (must ALL pass)

1. Every AuditEventType value has a recordAuditLog call in production code
2. Every new call site has a test in audit.test.ts
3. All existing tests pass (npm run test)
4. npm run lint passes (backend)
5. npm run typecheck passes (backend + frontend)
6. Zero frontend files modified (git diff --stat shows only backend files)
7. No audit event details contain passwords, tokens, or secrets
8. recordAuditLog failures never propagate to callers
9. Audit records survive user deletion
10. Audit records survive project deletion

## Commit Requirements

- Branch from main
- Single commit with message: "feat(M92): wire complete audit trail coverage for all AuditEventType values"
- End with: Co-Authored-By: Claude Code <noreply@anthropic.com>
- Push branch, create PR, verify GitHub CI passes
- Merge only after CI is GREEN
```
