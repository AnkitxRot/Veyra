# Veyra

Collaborative cloud IDE: Monaco editor, terminals, sandboxed execution, and
HTTPS Git remotes — one Node process, SQLite, Docker sandboxes.

[![CI](https://github.com/AnkitxRot/Veyra/actions/workflows/ci.yml/badge.svg)](https://github.com/AnkitxRot/Veyra/actions/workflows/ci.yml)

**Status:** M83 Debugging Foundation is implemented (sandboxed DAP for
Python `debugpy` and Node/TypeScript `vscode-js-debug`). M82 language
intelligence, M81 Python LSP, and M80 HTTPS Git remotes remain in
place. This is a working single-node product, not a hosted SaaS. See
[`STATUS.md`](STATUS.md) for the milestone history.

## What it is

Veyra (internal package name `@cloud-ide`) is a browser IDE backed by an
Express API and WebSocket layer. Each project is a directory on the server
plus a persistent Docker sandbox. Several people can edit the same files
through Yjs, run code, and use a shared Source Control panel against a
per-project Git repository.

The Git repository *inside* a project (`.git` under the workspace) is **not**
the Veyra source repository. Do not confuse the two.

## Capabilities

| Area | What exists |
| --- | --- |
| Editing | Monaco, tabs, search/replace, comments |
| Language intelligence | Python and TypeScript/JavaScript/TSX/JSX: live diagnostics, completion, hover, definition, references, document symbols (M82). Other languages: syntax + post-run diagnostics only. |
| Debugging | Python and Node/TypeScript: breakpoints, stepping, stack, variables inside the project sandbox (M83). No evaluate/watches. |
| Collaboration | Yjs CRDT, awareness, follow, mutation gates (M56) |
| Execution | Docker runner (`python`, Node, C/C++, Java, TypeScript, …) |
| Terminals | PTY in the sandbox; detach/reattach (M79) |
| Preview | Authenticated reverse-proxy to allowlisted sandbox ports |
| Projects | CRUD, upload, ZIP export/import, fork, snapshots, quotas |
| Secrets | Encrypted per-project secrets (M47); write-only values |
| Git (local) | Init, status, stage, commit, branches, checkout (M51) |
| Git (HTTPS) | Clone, origin, fetch, fast-forward-only pull, push (M80) |
| Admin | Users, backups, observability |
| Auth | Cookie sessions (httpOnly, signed) + optional Bearer token |

Not in this tree: SSH Git, GitHub OAuth, pull-request UI, merge/rebase UI,
force-push, LFS, submodules, billing, analytics, Java/C++ language
servers or debuggers, rename/refactor, expression evaluation / watches,
collaborative debugger control, profiler, AI coding assistants.

## Architecture

```text
Browser (React + Monaco + xterm)
  ↓  HTTPS / WebSocket
Express API + WS upgrade
  ↓
Project · Collab (Yjs) · Git · Secrets · Terminal · LSP · Debugger · Sandbox
  ↓
SQLite + workspace filesystem + Docker (ide-sandbox-<projectId>)
```

- **Frontend** (`frontend/`): Vite, React 18, Monaco, xterm.js. Dev server
  proxies `/api` and `/ws` to the backend.
- **Backend** (`backend/`): Express + TypeScript, `node:sqlite`, `ws`,
  `node-pty`. One process.
- **Sandboxes**: image `cloudeeeide-runner:latest`, non-root, capabilities
  dropped. Code runs with `docker exec`, not a fresh `docker run` per
  invocation. The same container hosts language servers (`pylsp`,
  `typescript-language-server`) and debug adapters (`debugpy`,
  `vscode-js-debug` via a stdio bridge).
- **Git control plane**: `execFile` only (no shell). Isolated env, empty
  `core.hooksPath`, no credential helper. HTTPS credentials never appear on
  argv or in `.git/config`.

## Security model

- **Auth.** Registration/login issue a signed httpOnly session cookie.
  Routes under `/api/` (except health and auth) require a valid session or
  Bearer token.
- **Authorization.** Project access is owner / editor / viewer.
  `requireProjectAccess` / `requireOwnedProject` close IDOR on every
  project-scoped route, including Git and the preview proxy.
- **Secrets.** AES-256-GCM with `SECRETS_MASTER_KEY`. Missing key → secret
  operations fail closed. Git PATs use the same store.
- **Git credentials.** Stored as reserved secrets `GIT_HTTPS_USERNAME`,
  `GIT_HTTPS_TOKEN`, `GIT_HTTPS_HOST`. They are not injectable into run or
  terminal environments, not returned by the secrets API, not copied on
  export/fork, and not written into Yjs. The host pin refuses to present a
  PAT to a different origin after `origin` is replaced (API or terminal).
- **HTTPS-only remotes.** `ssh://`, `git://`, `file://`, SCP syntax, local
  paths, UNC, backslashes, userinfo, and query/hash are rejected. Unsafe
  input is never rewritten into an allowed URL.
- **Pull.** Fast-forward only. Dirty worktrees and collaborator-dirty
  buffers are blocked (same M56 gate as checkout). No merge, rebase, reset,
  or force-push.
- **Collaboration.** External filesystem mutations (upload, Git checkout,
  pull, restore) go through `notifyExternalFileMutation`; dirty live buffers
  are preserved rather than overwritten.
- **Debugger.** `/ws/debug` requires editor (not viewer). The client cannot
  choose an adapter, executable, container, cwd, or env. Debuggee env does
  not inherit backend secrets, Git PATs, or project secrets. Control is
  per authenticated user, not shared with collaborators.

Do not treat this README as a threat model. The implementation and tests
are the source of truth.

## Language intelligence (M82)

Python and TypeScript/JavaScript files get a project-scoped language server
inside the existing Docker sandbox (`docker exec pylsp` or
`typescript-language-server --stdio`). The browser talks JSON-RPC over
`/ws/lsp`; the backend owns process lifecycle, initialize/shutdown, URI
rewriting, and a single authoritative document stream per file (Yjs is
canonical when a collab room holds the file). Clients cannot name an
executable or escape `/workspace`.

| Language | Syntax | Live diagnostics | Completion / hover | Navigation | Runtime |
| --- | --- | --- | --- | --- | --- |
| Python (`.py`, `.pyi`) | Monaco | `pylsp` (pyflakes / pycodestyle) when the runner image and sandbox are available | `pylsp` | Go to definition, references, document symbols | `python3` |
| TypeScript (`.ts`) | Monaco | `typescript-language-server` / tsserver against the workspace `tsconfig.json` | same | Go to definition, references, document symbols | Node / tsx |
| TSX (`.tsx`) | Monaco | same server (`typescriptreact`) | same | same | — |
| JavaScript / JSX (`.js`, `.jsx`, `.mjs`, `.cjs`) | Monaco | same TypeScript server | same | same | Node |
| C / C++ | Monaco | Post-run gcc/g++ parser only | — | — | gcc / g++ |
| Java | Monaco | Post-run javac parser only | — | — | JDK |

Live LSP diagnostics are independent of post-run parser diagnostics
(Problems panel owner `lsp` vs `cloudeee-problems`).

**Workspace / packages.** The TypeScript server reads the project
`tsconfig.json`, path aliases, and `node_modules` as they exist on disk.
**LSP startup never runs `npm install` / `yarn` / `pnpm`.** Missing
dependencies degrade to module-resolution diagnostics; the editor stays
usable. `package.json` and lockfiles are not modified.

**Degraded behaviour.** Opening and editing files never depends on the
language server. If Docker, the runner image, `pylsp`, or
`typescript-language-server` is missing, the editor still works; the
toolbar **Py LSP** / **TS LSP** chips show unavailable/failed/busy and
Monaco providers return empty results. No toast loop.

**Lifecycle.** One process per `(project, language)`. Collaborators share
it. Caps: 8 servers host-wide, 2 per project (Python + TypeScript/JS),
120s idle reap, 30s startup timeout, 3 restarts per minute. Project
delete, sandbox stop, and process shutdown dispose the session. Logout
closes that user's socket only — other collaborators keep the shared
server. LSP state is not stored in Yjs or SQLite.

**Document sync.** Full-document `didChange` (not incremental). Edits are
coalesced for 200ms per dirty path; the last keystroke is flushed on
tab close and project switch. A second client opening the same file does
not overwrite the canonical buffer.

**Deployment.** Rebuild `cloudeeeide-runner:latest` so `/opt/lsp` contains
pinned `python-lsp-server[pyflakes,pycodestyle]==1.12.2` and the image
has pinned `typescript@5.8.3` + `typescript-language-server@5.3.0`.
Local `npm run dev` without that image degrades as above. CI builds the
image before backend tests (including Docker-backed pylsp/tsserver tests
and Playwright browser E2E).

## Debugging

Veyra debugs **inside the existing project sandbox**. The browser never
names an executable, adapter, container, or host path. `/ws/debug` is a
mediated protocol (launch / breakpoints / continue / pause / step /
stack / variables / terminate). Raw DAP from the client is ignored.
Expression evaluation, watches, and conditional breakpoints are **not**
exposed.

| Runtime | Launch | Breakpoints | Continue / Pause | Step | Stack | Variables | Source mapping |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Python (`.py`) | `debugpy==1.8.21` in `/opt/debug` | yes | yes | over / into / out | yes | locals / scopes | `/workspace` ↔ editor path |
| Node (`.js` / `.mjs` / `.cjs`) | `vscode-js-debug` v1.117.0 | yes | yes | yes | yes | yes | workspace path |
| TypeScript (`.ts`) | same adapter, `node --import tsx` (same process) | yes | yes | yes | yes | yes | source maps via tsx + js-debug |
| TSX / JSX / Java / C / C++ | — | — | — | — | — | — | not in M83 |

**How to start.** Open a supported file, set a breakpoint in the editor
gutter (or Debug after placing one), click **Debug**. Unsaved buffers are
flushed first; if a flush fails, launch is refused rather than running
stale disk contents. **Run** is unchanged and stays available when the
debugger is not active.

**Requirements.** Rebuild `cloudeeeide-runner:latest` so `/opt/debug`
contains pinned `debugpy==1.8.21` and `js-debug-dap-v1.117.0`. Adapters
are never downloaded at session time.

**Security.** Debuggee and adapter run as `ide` in `ide-sandbox-<projectId>`.
The host only `docker exec`s allowlisted wrappers (`veyra-debugpy`,
`veyra-js-debug`). Container env is a minimal HOME/XDG/TMPDIR/LANG set —
no `SECRETS_MASTER_KEY`, Git PATs, database URLs, or project secrets.
Sessions are **user-owned** (`projectId` + `userId`); a collaborator
cannot control another user's debugger. Workspace paths are validated
the same way as file APIs. DAP `runInTerminal` / `startDebugging` /
`evaluate` are rejected.

**Lifecycle.** Caps: 4 live sessions host-wide, 2 per project, 1 per user.
Startup timeout 20s, request timeout 10s, session lifetime 30 min.
Disconnect, logout, project delete, sandbox stop, and process shutdown
terminate the session (no reattach). Output, stack, and variables are
bounded.

**Collaboration.** Breakpoints live in per-project `localStorage`, not
Yjs. Stack, variables, and DAP traffic are not synchronized. If the
paused file is edited after launch, the Debug panel reports a source
mismatch; the debuggee still runs the snapshot from launch.

**Degraded behaviour.** Opening a project never depends on the debugger.
If Docker, the runner image, or an adapter is missing, the editor still
works; Debug stays disabled / the panel shows **Unavailable**.

Rename, workspace-wide refactor, Java/C++ language servers, debugger, and
AI coding assistants are out of scope.

## Git support (M80)

Supported:

- `POST /api/projects/clone` — HTTPS clone into a new project
- `PUT /api/projects/:id/git/remote` — canonical `origin` (409 unless
  `replace: true`)
- Fetch; fast-forward-only pull; push of the current branch
  (`--set-upstream`, never `--force`)
- Project-scoped HTTPS credentials (owner-set)

Unsupported (rejected or simply not built):

- SSH, `git://`, `file://`, local paths
- Credentials embedded in the remote URL
- Merge / rebase / stash UI, force-push, LFS, submodules, GitHub PRs

M51 built local Git (init, commit, branches). M80 adds HTTPS remotes on
that envelope; it does not replace local Git. `.git` is still excluded from
ZIP export, workspace backups, and snapshots; forks start a fresh
repository. History that must travel should live on an HTTPS remote you
control.

## Development

Requires Node 22, npm, and (for execution tests) Docker. Git is required
for M80 remote tests.

```bash
npm install
npm run setup              # toolchains / sandbox user (Linux)
npm run runner:build       # docker build -f docker/Dockerfile.runner

# Backend (Express, default :3000)
npm run dev

# Frontend (Vite :5173 → proxies /api and /ws to :3000)
cd frontend && npm run dev
```

If Vite says port 5173 is in use, stop the other process or run
`npm run dev -- --port <n>`. `server.strictPort` is on so Vite will not
silently move.

### Verification (same commands as CI)

```bash
npm run lint -w @cloud-ide/backend
npm run lint -w @cloud-ide/frontend
npm run typecheck -w @cloud-ide/backend
npm run build -w @cloud-ide/frontend          # tsc --noEmit && vite build
npm test -w @cloud-ide/frontend
npm test -w @cloud-ide/backend                # includes Docker tests when Docker is up
git diff --check
```

Frontend production build is memory-heavy (Monaco). CI sets
`NODE_OPTIONS=--max-old-space-size=4096` for that step. A large `monaco`
chunk in the Rollup output is expected: the editor is a dedicated async
chunk, not an accidental full-app bundle.

Docker-dependent backend tests skip when the daemon is not running. GitHub
Actions builds the runner image and runs the full suite.

## Project structure

```text
backend/     API, Git, collab, sandboxes, SQLite
frontend/    React IDE
docker/      Dockerfile.runner, Dockerfile.app
deploy/      Production notes (single-node VPS)
scripts/     setup, runner build, backup, smoke
.github/     CI workflow
STATUS.md    Milestone log (historical; long)
```

## Configuration

Copy [`.env.example`](.env.example) for Compose. The backend also reads
process environment directly (`PORT`, `DATA_DIR`, …).

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_PASSWORD` | (none) | Required on first boot until an admin exists. Compose refuses to start without it. Changing it later does **not** rotate the password. |
| `ADMIN_USERNAME` | `admin` | First-boot admin only. |
| `PORT` / `HTTP_PORT` | `3000` | Process listen port / published host port. |
| `DATA_DIR` | platform-specific | Workspaces + SQLite. Production: `/var/lib/cloud-ide`. |
| `DATABASE_PATH` | `$DATA_DIR/cloudide.db` | |
| `SECRETS_MASTER_KEY` | unset | 32-byte key, base64. Required for secrets and Git PATs. |
| `GIT_SSL_CAINFO` | unset | CA file for HTTPS Git (tests / private CAs). |
| `MAX_SANDBOXES` | `20` | |
| `PROJECT_QUOTA` | `20` | |
| `MAX_CONCURRENT_RUNS` | `3` | |
| `SANDBOX_IDLE_TIMEOUT_MS` | `1800000` | |
| `MAX_LSP_SERVERS` | `8` | Concurrent language-server processes (M82). |
| `MAX_LSP_SERVERS_PER_PROJECT` | `2` | Python + TypeScript/JavaScript. |
| `LSP_IDLE_TIMEOUT_MS` | `120000` | Reap after last client disconnects. |
| `LSP_STARTUP_TIMEOUT_MS` | `30000` | |
| `MAX_DEBUG_SESSIONS` | `4` | Live debug sessions (starting/running/paused). |
| `MAX_DEBUG_SESSIONS_PER_PROJECT` | `2` | |
| `MAX_DEBUG_SESSIONS_PER_USER` | `1` | |
| `DEBUG_STARTUP_TIMEOUT_MS` | `30000` | Adapter initialize + launch. |
| `COOKIE_SECURE` | production=`true` | |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy. |
| `APP_CONTAINERIZED` | off | Compose sets `1` so preview proxy uses sandbox networks. |

Never commit a real `.env` or `SECRETS_MASTER_KEY`.

## Deployment

Single-node Docker-out-of-Docker on a Linux VPS. The app container talks to
the **host** Docker daemon via `/var/run/docker.sock`. Data must be mounted
at the **same path** inside and outside the container
(`/var/lib/cloud-ide:/var/lib/cloud-ide`) because sandbox binds use host
paths.

```bash
npm run deploy:setup
npm run runner:build
npm run deploy:up
```

Details, backup/restore, and Git operational notes: [`deploy/README.md`](deploy/README.md).

Health:

- `GET /api/health` — liveness
- `GET /api/health/ready` — readiness

## Testing

- **Backend:** Vitest, single-thread pool. Auth, files, Git, collab, secrets,
  backups, and Docker execution when the daemon is available.
- **Frontend:** Vitest + Testing Library (jsdom). Editor, Source Control,
  collab UI, settings.
- **CI:** `.github/workflows/ci.yml` — lint, typecheck, frontend build,
  frontend tests, runner image, backend tests, app image. Node 22.

## License

Private repository. All rights reserved unless a license file is added.
