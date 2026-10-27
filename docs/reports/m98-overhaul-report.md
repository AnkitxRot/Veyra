# M98 — Toolchain and architecture overhaul

Branch `overhaul/m95` (named before the M95/M97 ledger rows were noticed; ledgered as M98).
Behavior-preserving; no framework swap.

## Done
- Toolchain: Node 24, TypeScript 6, `verbatimModuleSyntax`/`isolatedModules`/`noImplicitOverride`/`noUncheckedIndexedAccess`, typed ESLint (`strictTypeChecked`, tiered), Prettier, `.editorconfig`.
- Majors: Express 5, React 19, Vite 8, Vitest 5, jsdom 30, @types/node 24, react-hooks 7.
- Backend: zod v4 validation (`validate.ts`; auth, admin, ai, projects bodies); zlib off the event loop (`zip.ts`, `snapshots.ts`); `tools.ts` execFile; pino logger (`logger.ts`) replacing `console.*`; `errorInfo()` for unknown-typed catches; backend `any` 89 → ~27.
- Decomposition: `projects/routes.ts` (1557 → 24 lines) split into 7 feature route modules; `collab/clock.ts` extracted from `collab/manager.ts`.
- Frontend: typed `ide-*` event registry (`src/events.ts`, DocumentEventMap augmentation; no runtime change).
- CI: split jobs, CodeQL, dependabot, image scan.

## Not done (deliberate)
- `backup/shared.js` → `.ts`: sync lock is CLI-only (server uses `withBackupLockAsync`); risk > value.
- Deeper `collab/manager.ts` / `execution/sandbox.ts` splits, `IDE.tsx`/`AdminDashboard`/`SourceControlPanel` splits, TanStack Query, frontend `any` removal, remaining ~27 backend `any`, zod on comments/git/projectsecrets handlers.
- Oracle review of zip/backup/collab changes; reviewer pass per phase; base-image digest pinning; TS 7 / ESLint 10.

## Verification
Backend: 3 failed | 1391 passed | 214 skipped (the 3 known m86 git failures, identical on baseline). Frontend: 1067 passed. Docker/E2E skipped on this host.
