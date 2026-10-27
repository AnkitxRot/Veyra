# Roadmap (from M111)

M95–M110 shipped; see `docs/reports/m99-m110-overhaul-report.md`. Next: jdtls (pinned download), phase-end browser verification, `deploy:smoke`, `CSP: sandbox` previews, server-side settings/themes, oracle pass on LSP/debug surfaces, runner image size measurement.

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
