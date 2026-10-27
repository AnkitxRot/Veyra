# M99–M110 overhaul report

Branch `overhaul/m100`. Per-milestone detail is in `STATUS.md`.

| Phase | Milestones | Summary |
| --- | --- | --- |
| A prod hardening | M99–M100 | WS Origin allowlist, zod config, global security headers, CSRF guard (Origin-based), rate-limit middleware, `/metrics`, M97 follow-ups, LICENSE, HEALTHCHECK |
| B editor core | M101–M104 | Editor groups/split, terminal tabs, markdown/image viewers + encoding/EOL, outline, breadcrumbs, explorer DnD, snippets |
| C customization | M105–M108 | Layered settings, theme engine (9 themes), zen/dockable panel/tab order, per-project runtime image (`RUNNER_IMAGES` allowlist; oracle-reviewed) |
| D language/debug | M109–M110 | Conditional/hit/logpoint breakpoints, watches, debug console; LSP rename/code actions/format, incremental sync, clangd, `.veyra/tasks.json` |

## Verification
- Backend: full suite after M100–M103 (1589 passed, 38 skipped); later milestones targeted tests only.
- Frontend: 1109 tests, `tsc` clean after M110.

## Open items
- Not done: phase-end browser checks, `npm run deploy:smoke`, Docker-dependent suites (no Docker run here).
- jdtls deferred (needs a pinned, checksummed download); clangd added via apt, unverified in a container; runner image size not measured.
- M110 LSP/WS surface and M109 had no oracle pass.
- `CSP: sandbox` for previews deferred; CSRF guard is Origin-based; settings/themes/layout are client-side only; `.env.example` not generated from the schema.
- Rename/code-action edits only apply to open files; others are reported.
- M109 `evaluate` reverses the earlier "no evaluate" policy.
- M100–M103 were committed together.
