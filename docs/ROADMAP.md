# Roadmap (from M112)

M95–M111 shipped; see `docs/reports/m99-m110-overhaul-report.md`. The plan below (M112–M150) supersedes the historical M94 plan further down, whose Phase 3/4 items (git depth, SSH/OAuth, multi-node, hosted basics, AI) did not ship under those numbers and are renumbered here. Each milestone still starts with the discovery gate: confirm it isn't already built.

## M112–M150

| Phase | #    | Milestone                                                                                                          |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| A     | M112 | Preview isolation: `sandbox` CSP + upstream `Set-Cookie` strip on the proxy (done); document symlink-race residual | **(done)** |
| A     | M113 | Audit ratchet covers `ws/*`; `ws/execution.ts` audited; fix unused `auditHandler` (`terminalSessions.ts:151`)      | **(done)** |
| A     | M114 | Burn down `KNOWN_UNAUDITED` I: project create/import/fork/upload/move/delete/snapshots                             | **(done)** |
| A     | M115 | Burn down `KNOWN_UNAUDITED` II: admin backups, run/install, search/replace/format, ai, comments                    | **(done)** |
| A     | M116 | Oracle pass on LSP/debug/WS surfaces + fixes                                                                       | **(done)** |
| B     | M117 | `deploy:smoke` script + CI job                                                                                     |
| B     | M118 | Phase-end browser verification (Playwright) of M101–M111 UI                                                        |
| B     | M119 | CI stability: evidence-based flake fixes, split Docker/E2E jobs                                                    |
| B     | M120 | Runner image size measurement and slimming                                                                         |
| B     | M121 | Server-side settings/themes sync (user-level)                                                                      |
| B     | M122 | Admin UI for `audit-integrity` + audit log export                                                                  |
| C     | M123 | jdtls via pinned download                                                                                          |
| C     | M124 | Git diff viewer                                                                                                    |
| C     | M125 | Git stash                                                                                                          |
| C     | M126 | Merge-conflict UI                                                                                                  |
| C     | M127 | Non-FF pull options (still no force-push by default)                                                               |
| C     | M128 | Test explorer (run/discover tests per language)                                                                    |
| C     | M129 | Launch/task config UI over `.veyra/` files                                                                         |
| C     | M130 | Global replace preview + search UX                                                                                 |
| C     | M131 | Debug adapters: Java and C/C++ under existing caps                                                                 |
| C     | M132 | Command palette + keybinding customization                                                                         |
| D     | M133 | SSH remotes (reuse M80 host-pin + secret store rules)                                                              |
| D     | M134 | GitHub OAuth                                                                                                       |
| D     | M135 | Read-only PR/issue integration                                                                                     |
| D     | M136 | Collaborative debugging view (control stays per user)                                                              |
| D     | M137 | Presence and follow mode                                                                                           |
| D     | M138 | Review comments v2                                                                                                 |
| E     | M139 | Multi-node: measure first, then decide                                                                             |
| E     | M140 | Externalize sessions/collab rooms only if M139 justifies it                                                        |
| E     | M141 | Per-user quotas                                                                                                    |
| E     | M142 | Org/team model                                                                                                     |
| E     | M143 | Onboarding                                                                                                         |
| E     | M144 | Billing hooks                                                                                                      |
| E     | M145 | Observability: traces, SLOs, alerts                                                                                |
| E     | M146 | Backup/restore disaster-recovery drill                                                                             |
| F     | M147 | AI assistant design gate (needs M113–M115 and M141)                                                                |
| F     | M148 | AI assistant v1, sandboxed and quota'd                                                                             |
| F     | M149 | Accessibility audit and fixes                                                                                      |
| F     | M150 | Release hardening and v1 report                                                                                    |

Phases A and B come first because the rest add surface area on top of unreviewed code. Phase E items marked "measure first" may be rejected with evidence rather than built.

## Historical plan (from M94)

Updated 2026-10-26. Ordering rule: stabilize and de-risk first, then
user-visible features, then scale/product. Each milestone follows the
existing discipline: discovery gate → failing tests first → fix →
full suite + CI green → update `STATUS.md`, README status line, this file.
Check for already-shipped work before starting (see M92 discovery).

## Phase 1 — Hygiene (small, do first)

| #   | Milestone                | Scope                                                                                                                                                                                                                  | Done when                                                         |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| M95 | Repo hygiene & docs      | Add LICENSE; move committed load-test results to a release asset or `docs/reports/load-test/`; keep root to README/STATUS/CLAUDE; collapse STATUS.md (≈10k lines) into a short ledger plus `docs/milestones/` archive. | Root has no stray reports; STATUS < 500 lines.                    |
| M96 | CI stability             | Use the M85 diagnostics to find root causes of flaky Playwright runs (workflow-browser, debug-browser); add retries only with evidence; split Docker/E2E jobs; document the Docker-less Windows test story.            | 20 consecutive green runs on main.                                |
| M97 | Audit completeness check | Test that enumerates mutating routes/WS handlers and asserts each emits an audit event; admin UI for `audit-integrity`; export of audit log.                                                                           | Coverage test fails when a new mutating route has no audit event. |

### Phase 1b — security follow-ups (from the M97 review)

- Confirm/fix the move/delete symlink race; add WS `Origin` allowlist; sandbox or separate-origin previews.
- Review the files not yet covered: auth routes, zip import/upload/move/proxy, git, terminal and execution WS.
- Extend the audit ratchet to WS handlers and burn down its `KNOWN_UNAUDITED` list.

## Phase 2 — Developer experience (highest user value)

| #    | Milestone                                        | Scope                                                                                                            |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| M98  | Debugger depth                                   | Expression evaluation, watches, conditional breakpoints (Python + Node); enforce existing sandbox/env isolation. |
| M99  | Rename & refactor                                | LSP rename, code actions, organize imports for Python/TS.                                                        |
| M100 | Incremental LSP sync + Java/C++ language servers | Replace full-document didChange; add clangd and a Java server under the existing per-project caps.               |

## Phase 3 — Git and collaboration

| #    | Milestone                  | Scope                                                                                       |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------- |
| M101 | Git depth                  | Merge-conflict UI, non-FF pull options, stash, diff viewer; still no force-push by default. |
| M102 | SSH remotes / GitHub OAuth | Credential model extension; reuse the M80 host-pin and secret store rules.                  |
| M103 | Collaborative debugging    | Shared view of a debug session (control stays per user unless granted).                     |

## Phase 4 — Product & scale

| #    | Milestone               | Scope                                                                                                                        |
| ---- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M104 | Multi-node readiness    | Decide (measure first, per M9/M17 precedent) whether to externalize sessions, collab rooms, SQLite; reject if not justified. |
| M105 | Hosted-product basics   | Quotas/billing hooks, org/team model, onboarding.                                                                            |
| M106 | AI assistant (optional) | Only after audit, quotas and secrets isolation are proven; design gate first.                                                |

## Per-milestone checklist

1. Discovery: confirm the feature doesn't already exist; write the gate report in `docs/reports/`.
2. Tests first (RED), then implementation.
3. `npm run lint`, `typecheck`, backend + frontend tests, Playwright; CI green.
4. Update `STATUS.md` ledger row, README status/capabilities, `CLAUDE.md` if structure changed, and this roadmap.
