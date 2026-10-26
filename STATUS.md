# STATUS

Last updated: 2026-10-26. Latest milestone: **M94**.

This file is the short milestone ledger. The complete historical record
(~10k lines, M1–M86 write-ups, verification logs, architecture decisions
and known issues as of M86) is archived in
[`docs/archive/STATUS-history.md`](docs/archive/STATUS-history.md).
Forward plan: [`docs/ROADMAP.md`](docs/ROADMAP.md). Per-milestone reports:
`docs/reports/`. Archived load-test runs: `docs/archive/load-test-results/`.

Rule: every milestone adds one ledger row here and updates the README
status line; long write-ups go in `docs/reports/`, not here.

## Milestones M87–M94

Full detail for M89–M91 is in `docs/reports/`. Test counts are as reported in
the commit messages and reports, not re-run for this summary.

| # | Milestone | Commit | Summary |
| --- | --- | --- | --- |
| M87 | Project Git in the sandbox | `e635004` | Project Git execution moved from the host into the project sandbox. |
| M88 | Terminal reload persistence | `83b0c9b` | Terminal session survives same-tab remount/reload. |
| M89 | Read-your-writes test repair | `6f24154` | `testWriteHook` + confined-write mock migration fixing M4/M56 suites. 3 M86 server-integration tests need Docker (fail on Docker-less Windows). Report: `docs/reports/M89_REPORT.md`. |
| M90 | Post-M89 audit | — | Baseline verification and milestone definition. Report: `docs/reports/m90-report.md`. |
| M91 | Deterministic idle-disposal retry | `639908c` | `VirtualClock`-driven retry lifecycle; 9 tests. Reports: `docs/reports/M91_FINAL_REPORT.md`, `m91-report.md`. |
| M92 | Audit event coverage | `bfacd66` | Audit events across auth, collab, execution, sandbox, terminals, Git, projects. Discovery found the originally proposed M92 (snapshot restore) already existed (M20/M31/M32). Report: `docs/reports/M92_DISCOVERY_REPORT.md`. |
| M93 | Audit failure monitoring | `58eed79` | Failure counter with categories, `GET /api/admin/audit-integrity`, admin WS `audit_integrity` telemetry, retention GC (startup/periodic/shutdown). Reported 1545 backend + 1067 frontend passing. |
| M94 | LSP and DAP audit trail | `b9eb7b6` | `LSP_SESSION_*` and `DEBUG_SESSION_{STARTED,FAILED,TIMEOUT,STOPPED}` events; fail-soft; 16 new tests (PR #18). |

### Known gaps after M94
- README/STATUS were stale at M85/M86 until this update.
- Duplicate M92/M93 commits in history (`affe895`/`bfacd66`, `52f3c60`/`58eed79`).
- Docker-dependent tests cannot run on Docker-less Windows; CI is the gate.
- Browser E2E on the 2-vCPU CI runner is the least stable suite.
- No LICENSE file; load-test result dumps are committed.
- Next work: see `docs/ROADMAP.md`.

## Earlier milestone index (details in the archive)

- M1 — Truthful save primitive (BUG-1, P0 data loss)
- M2 — Shutdown room flush (BUG-2, P0 data loss)
- M3 — WS payload cap + heartbeat reaper (BUG-4) — now COMPLETE
- Milestone 2 — Per-user sandbox quota + terminal concurrency gate
- Milestone 3 — Multiplayer correctness (collab room lifecycle race)
- Milestone 4 — Frontend regression coverage
- Milestone 5a — Performance instrumentation, execution hot-path fixes, load-test baseline
- Milestone 5b — Global sandbox admission correctness (fixes the M5a TOCTOU finding)
- Milestone 5c — SQLite write-contention characterization (measurement only)
- Milestone 6 — Collaboration broadcast coalescing + WS backpressure
- Milestone 7 — Memory investigation (100-user RSS/event-loop attribution)
- Milestone 7b — Load-test harness hygiene (fixes Milestone 7's findings)
- Milestone 8 — Coalescing-window characterization (measurement only)
- Milestone 9 — Scale validation (100 to 1000 VUs)
- Milestone 10 — Performance hotspot investigation (Execution & Filesystem)
- Milestone 11 — Targeted execution cold-start and filesystem stat/telemetry optimizations
- Milestone 12 — Execution conflict-retry, lazy port mapping, and tree single-flight caching optimizations
- Milestone 13 — Active sandbox liveness freshness optimization
- Milestone 14 — Scale re-validation under M11–M13 optimizations (measurement only)
- Milestone 15 — Bounded cold-sandbox prewarming experiment (measurement only; REJECTED)
- Milestone 16 — Cold sandbox provisioning & concurrency optimization
- Milestone 17 — Cumulative Scale Validation Post-M16 (measurement only)
- Milestone 18 — Cold-Wait Decomposition & Scheduling Decision (measurement only)
- Milestone 19 — Session Lifecycle & WebSocket Security Hardening
- Milestone 20 — Project Snapshot Quotas & Retention Management
- Milestone 21 — Project Workspace Export & Import
- Milestone 22 — User Preferences & Editor Settings Persistence
- Milestone 23 — Automated Production Deployment Smoke & Readiness Verification Harness
- Milestone 24 — Direct Workspace File & Folder Upload
- Milestone 25 — Production Database Backup & Disaster Recovery Automation
- Milestone 26 — Workspace-wide Search & Replace
- Milestone 27 — Database Backup Security Hardening
- Milestone 28 — Project Duplication & Workspace Forking
- Milestone 29 — Harden Project Fork Authorization
- Milestone 30 — Automated Database Restore & Disaster-Recovery Verification
- Milestone 31 — Automated Per-Project Workspace & Snapshot-Body Backup
- Milestone 32 — Per-Project Workspace & Snapshot Restore
- Milestone 33 — Audit Trail Coverage & Deletion Integrity
- Milestone 34 — Backup & Restore Operational Health Observability
- Milestone 35 — Starter Project Templates UI
- Milestone 36 — Fix viewport-level modal rendering (shared PromptModal/ConfirmModal portal)
- Milestone 37 — Prevent collaboration ghost-file resurrection
- Milestone 38 — Close collaboration deletion race
- Milestone 39 — Close collaboration race during workspace replacement import
- Milestone 40 — Reset collaboration state after explicit server disposal
- Milestone 41 — Prevent disposed collaboration rooms from flushing stale state
- Milestone 42 — Fresh read-only discovery + tree-cache stale-write-after-invalidate fix
- Milestone 43 — Surface the dependency-install pipeline in the IDE UI
- Milestone 44 — Detect missing-dependency run failures and offer an inline install action
- Milestone 45 — Fix ide-run tab-dispatch race and stuck Stop button after mid-run tab switch
- Milestone 46 — Surface admin backup and restore controls in the admin dashboard
- Milestone 47 — Encrypted per-project secrets & environment variables
- Milestone 48 — Ambient Workspace Presence, Activity Intent & Safe Follow Mode
- Milestone 49 — Admin Platform Observability Dashboard
- Milestone 50 — Safe workspace-wide Replace All
- Milestone 51 — First-class local Git version control
- Milestone 80 — First-class HTTPS Git remotes
- M80 stabilization
- Milestone 52 — Eliminate Yjs initial-load content duplication
- Milestone 53 — Persistent project-scoped execution session
- Milestone 54 — Collaborative run awareness (status + safe metadata)
- Milestone 55 — Server-authoritative collaboration identity & awareness integrity
- Milestone 56 — Collaboration-safe destructive operations
- Milestone 57 — Multiplayer Presence, Live Workspace Awareness & Collaborative Editing Foundation
- Milestone 58 — Live Attention, Callouts & Spatial Collaboration
- Milestone 59 — Collaborative Focus & Context Handoff
- M59 UX validation & stabilization pass (2026-08-30)
- M59 final closeout pass (2026-08-30)
- Milestone 60 — Change Attribution & Collaboration History
- Milestone 61 — Contextual Comments (Track A) + dormant Customization / Identity schema
- M61-A — Contextual Collaboration (IMPLEMENTED)
- M57–M61 live release-gate closure (2026-09-04)
- M62 — self-service profile identity & effective display propagation (backend)
- M62-4 — Settings → Profile tab
- M62-5 — display identity across collaboration surfaces
- M63 — unified connection & sync-state visibility (frontend)
- M64 — unified transient notices + blocking `alert()` removal (frontend)
- M64 adversarial audit + live verification (2026-09-06)
- M65 — shared run output (bounded, ephemeral, owner/editor)
- M66 — unified preferences: classification + formatOnSave migration
- M67 — persistent IDE layout preferences (user-global)
- M68 — project/workspace load reliability & error recovery
- M68 release-hardening pass (2026-09-06)
- M68 final classification
- M69 — unified theme & appearance
- M70 — configurable keybindings
- M71 — measured frontend performance & resource optimization
- M72 — profile + avatar + identity UX
- M73 - seamless multiplayer / presence UX
- M74 — awareness-table reconciliation + collaboration-aware sandbox lifecycle
- M74-A — awareness table never accumulates orphan entries
- M74-B — an occupied project's container stays warm; an empty one is released sooner
- M74-C — observability
- M75 — line-ending hygiene + finish the alert() → notice migration
- M75-1 — `.gitattributes` (LF enforced repo-wide)
- M75-2 — `alert()` → M64 notice system (IDE-route components)
- M76 — M74 closeout, awareness re-verification, admin notice migration
- M77 — live browser / runtime verification pass (closes the M76 PARTIAL)
- M78 — idle connected collaborators stay visible to peers
- M74–M78 history reconstruction (2026-09-08)
- M79 — terminal session reliability & persistence
- Milestone 81 — Language Intelligence
- Milestone 82 — Production Language Intelligence
- Milestone 83 — Debugging Foundation
- Milestone 84 — Test / Task / Build Workflow
- Milestone 85 — Workspace Intelligence & IDE Reliability
- Milestone 86 — Workspace Read-Your-Writes
