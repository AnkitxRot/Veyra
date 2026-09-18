# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CloudeeeIDE is a cloud-based integrated development environment (IDE) built as a monorepo with a TypeScript backend and a React frontend. It provides a full IDE experience including a Monaco-based code editor, terminal, file explorer, language execution, and web preview — all running inside Docker containers.

## Tech Stack

- **Backend**: Express + TypeScript + `node:sqlite` (via `DatabaseSync`) + WebSocket (ws) + node-pty
- **Frontend**: React 18 + TypeScript + Vite + Monaco Editor + xterm.js
- **Execution**: Docker containers (`cloudeeeide-runner:latest`) for sandboxed code execution
- **Auth**: Cookie-based sessions (httpOnly, signed) with bcrypt-like scrypt password hashing
- **Database**: SQLite (WAL mode, foreign keys enabled) — zero external dependencies

## Repository Structure

```
backend/
  src/
    index.ts          # Entry point — starts Express server, initializes DB & WS
    app.ts            # Express app factory — registers routes, middleware, error handling
    config.ts         # AppConfig, resolveConfig(), DEFAULT_LIMITS, run user resolution
    db.ts             # SQLite init — creates users/sessions/projects tables
    errors.ts         # ApiError class + error middleware
    tools.ts          # System capability detection (docker, toolchains)
    auth/
      routes.ts       # POST /register, /login, /logout; GET /me
      middleware.ts   # requireAuth() middleware, session issue/verify
      passwords.ts    # scrypt-based hash & verify
    projects/
      routes.ts       # CRUD + file ops + run + install + proxy routes
      service.ts      # Project model, workspace path, ownership checks
      install.ts      # Pure: resolveInstallSpec() — dependency manager selection logic
    files/
      service.ts      # Tree, read/write/move/delete with path-traversal protection
    execution/
      pipeline.ts     # runProject() — detect → compile → run lifecycle
      sandbox.ts      # SandboxManager (singleton) — persistent Docker containers per project
      languages.ts    # Language registry (python, node, c, cpp, java, typescript, html, css, etc.)
      detect.ts       # Language detection from files & activeFile
    ws/
      index.ts        # WebSocket upgrade — auth + route to terminal/execution/lsp/debug
      terminal.ts     # /ws/terminal — docker exec bash session via node-pty
      execution.ts    # /ws/execute — run project via WebSocket stream
    debug/
      manager.ts      # DebugSessionManager — user-owned DAP sessions
      session.ts      # DAP client, state machine, path rewrite, bounds
      ws.ts           # /ws/debug — mediated debugger protocol
      languages.ts    # Allowlisted adapters (debugpy, vscode-js-debug)
    scratch-test.js   # Standalone e2e test script (auth + project + WS execution)
  vitest.config.ts    # Vitest config — testTimeout/hookTimeout 60000ms
  tsconfig.json       # Extends ../tsconfig.base.json, includes src + test
  test/
    api.test.ts       # Integration: auth, CRUD, path traversal, install, IDOR, proxy
    detect.test.ts    # Language detection and main file resolution
    exec.test.ts      # Docker-dependent: language execution (python, node, java), stdin, timeout
    files.test.ts     # Path traversal, tree listing, BUILD_PREFIX skipping
    helpers.ts        # makeTestConfig, startTestApi, TestApi interface
    install.test.ts   # Pure: resolveInstallSpec command selection (7 cases)
    pipeline.test.ts  # Language registry, detect edge cases, resolveMainFile edge cases
    sandbox.test.ts   # Docker-dependent: timeout, non-root uid, cgroup cleanup
    ws.test.ts        # URL parsing, query.token fallback auth
frontend/
  index.html          # HTML entry point (<title>Cloud IDE</title>)
  vite.config.ts      # Vite config — port 5173, proxies /api & /ws to localhost:3000, Monaco alias
  tsconfig.json       # Extends ../tsconfig.base.json, react-jsx jsx
  src/
    main.tsx          # Entry point
    App.tsx           # Auth gate → IDE shell
    api.ts            # Fetch wrapper with token auth, WebSocket URL builder
    types.ts          # Shared TypeScript types
    monacoSetup.ts    # MonacoEnvironment.getWorker for language workers (JSON/CSS/HTML/TS/JS)
    utils/language.ts # Frontend language info lookup (maps file ext → Monaco language)
    styles.css        # Catppuccin Mocha CSS variables, base element/layout styles (.sidebar, .main, etc.)
    styles/           # Per-component CSS: auth, context-menu, editor, layout, output, sidebar, terminal, toolbar
    components/
      Auth/Auth.tsx           # Login/Register form
      IDE/IDE.tsx             # Main IDE layout — sidebar, editor, bottom panel tabs
      Sidebar/Sidebar.tsx     # Project list, file tree explorer with context menus
      Editor/Editor.tsx       # Monaco editor wrapper with tabs, save, dirty tracking
      Toolbar/Toolbar.tsx     # Run/Stop/Debug buttons, capability indicators
      Output/Output.tsx       # Execution log panel (WebSocket-based stdout/stderr)
      Terminal/Terminal.tsx   # xterm.js terminal panel (WebSocket-based)
      Preview/Preview.tsx     # iframe proxy for running web apps in sandbox
      Debug/DebugPanel.tsx    # Debugger toolbar, call stack, variables
```

## Key Architecture Patterns

### Backend Routing
All routes are under `/api/`. Auth middleware (`requireAuth`) verifies session cookies or Bearer tokens. Project routes enforce ownership via `requireOwnedProject()`. Error middleware converts unhandled errors to JSON. The `/api/projects/:id/proxy/:port` route uses `http-proxy-middleware` to reverse-proxy to mapped container ports, requiring auth for each request. The `scratch-test.js` in `backend/` is a standalone e2e script that exercises the full flow (register → create project → write file → WebSocket execute → stdin → exit).

### Docker Sandbox Execution
Each project gets a persistent Docker container (`ide-sandbox-{projectId}`) mounted with the workspace directory. The `SandboxManager` singleton handles container lifecycle — creation, port mapping (for preview ports 3000,4173,5173,8000,8080), stop, and cleanup. Code execution uses `docker exec` inside this container (not `docker run`), which has Python, Node.js, TypeScript (tsx), GCC, G++, and JDK pre-installed per `docker/Dockerfile.runner` (based on `node:22-bookworm-slim`).

### Language Execution Pipeline
`runProject()` in `execution/pipeline.ts` orchestrates: language detection → main file resolution → compilation (if applicable) → execution. Each step can short-circuit with specific outcome types (`no_language`, `no_main_file`, `compile_error`, `not_runnable`, etc.).

### WebSocket Protocol
WebSocket endpoints:
- `/ws/terminal` — bidirectional shell session (messages: `{type: 'data'|'resize'}` → server, `{type: 'data'}` ← server)
- `/ws/execute` — one-way execution stream (messages: `{type: 'start'|'stdin'|'stop'}` → server, `{type: 'stdout'|'stderr'|'status'|'exit'|'error'}` ← server)
- `/ws/lsp` — language intelligence (JSON-RPC framed by the backend)
- `/ws/debug` — mediated debugger (launch / breakpoints / continue / pause / step / stack / variables / terminate). Not raw DAP.

### File Service Path Traversal Protection
`safeResolve()` validates relative paths against workspace root. `assertInsideWorkspace()` resolves symlinks to confirm paths stay within workspace boundaries.

### Frontend Communication Pattern
The IDE uses custom DOM events (`ide-save`, `ide-run`, `ide-run-confirmed`, `ide-stop`, `run-started`, `run-stopped`) for component-to-component communication. The API layer (`api.ts`) handles both REST (Bearer token + cookie) and WebSocket connections.

### Monaco Worker Configuration
`monacoSetup.ts` sets `self.MonacoEnvironment.getWorker` to route language workers (JSON, CSS, HTML, TypeScript/JavaScript) to bundled Vite workers. Without it, Monaco renders all files as plain text. The `monaco` global is exposed on `window`.

## Commands

### Development
```bash
# Install dependencies
npm install

# Run setup script (installs toolchains, creates sandbox user on Linux)
npm run setup

# Build Docker runner image (required for code execution)
npm run runner:build

# Start backend development server (with hot reload via tsx watch)
npm run dev
# or run from backend directory:
cd backend && npm run dev

# Start frontend development server (Vite, port 5173, proxies to backend)
cd frontend && npm run dev

# Start both (run backend, then frontend in another terminal)
```

If `npm run dev` fails with `Port 5173 is already in use`: frontend/vite.config.ts sets `server.strictPort`, so Vite now fails fast instead of silently moving to another port — which previously masked a stale dev server still holding 5173 with a dead /api proxy (login calls returning `request failed (404)`). Stop the process listening on 5173, or start this instance elsewhere with `npm run dev -- --port <n>`. On Windows/Docker Desktop, 5173 can also fall inside a reserved range (`netsh interface ipv4 show excludedportrange protocol=tcp`) even with nothing listening — pick another port or restart WinNAT (`net stop winnat && net start winnat`).

### Building & Preview
```bash
# Type-check backend
cd backend && npm run typecheck

# Type-check frontend
cd frontend && npm run build    # builds with tsc --noEmit then vite build

# Preview frontend production build
cd frontend && npm run preview
```

### Testing
```bash
# Run all backend tests
npm run test

# Run tests in watch mode
npm run test:watch

# Test files are in backend/test/ — each covers auth, execution, detection, sandbox, and API
```

Tests use Vitest with `singleThread` pool. Docker-dependent tests are auto-skipped when Docker is not available (`skipIf(!isDockerRunning())`). Test helper `makeTestConfig()` uses in-memory SQLite and temp directories.

### Configuration
Environment variables:
- `PORT` — backend listen port (default: 3000)
- `DATA_DIR` — workspace/data directory (default: `~/.cloud-ide` on Windows, `/var/lib/cloud-ide` on Linux)
- `DATABASE_PATH` — SQLite database path
- `CGROUP_ROOT` — cgroup v2 mount (default: `/sys/fs/cgroup/cloudide`)
- `RUN_USER` — unprivileged user for code execution (default: `ide`)

## Key Files to Reference

- `backend/src/execution/languages.ts` — registry of supported languages, extensions, main files, compile/run commands
- `backend/src/execution/sandbox.ts` — `SandboxManager` singleton for persistent Docker containers (`ide-sandbox-{id}`) with security options (`--security-opt no-new-privileges --cap-drop ALL`); `deleteProject` in service.ts calls `stopProjectSandbox` for cleanup
- `backend/src/execution/pipeline.ts` — `runProject()` orchestrator
- `backend/src/debug/manager.ts` — user-owned DAP sessions in the project sandbox
- `backend/src/projects/routes.ts` — all project REST endpoints (CRUD, files, run, install, proxy)
- `frontend/src/components/IDE/IDE.tsx` — main layout orchestrator, coordinates all sub-components
- `frontend/src/api.ts` — API client with auth token management and WebSocket URL builder
- `frontend/src/monacoSetup.ts` — Monaco worker routing (required for syntax highlighting)
- `frontend/src/styles.css` — Catppuccin Mocha CSS variables, layout classes
- `backend/scratch-test.js` — standalone e2e test for auth + WS execution flow
