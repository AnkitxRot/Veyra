# Architecture — execution boundaries

Veyra is one Node process plus per-project Docker sandboxes. This note
records **where work runs** and **who is allowed to start it**. It is not
a threat model.

```text
Browser (React, Monaco, xterm)
    HTTPS / WebSocket
Backend (Express, Yjs rooms, Git execFile, SQLite)
    docker exec -u ide -w /workspace
Sandbox  ide-sandbox-<projectId>
    Run / Test / Build / Terminal / LSP / Debug adapters
```

## Isolation

| Layer | What is isolated | How |
| --- | --- | --- |
| Project | Workspace files, sandbox, Git repo, secrets | `projectId` on every route/WS; `requireProjectAccess` |
| User | Debugger control, terminal PTY attach, sessions | Authenticated session; debug is `(projectId, userId)` |
| Process | User code, language servers, debug adapters, npm/pytest | `docker exec` in the project container, non-root, cap-drop |
| Filesystem | Paths under the project workspace | `safeResolve` + `assertInsideWorkspace`; `.git` blocked |
| Environment | Secrets, Git PATs, backend env | Allowlisted container env; secrets not injected into LSP/debug/install |

The browser never names an executable, container ID, cwd, or env for
Run, Debug, LSP, Test, or Build.

## Subsystems

**Run** — `runProject()` detects language from files, compiles if needed,
`docker exec`s the program. One run slot per project (`runGate`).

**Test / Build** — discovery is allowlisted (`package.json` `test`/`build`
scripts, pytest markers). Execution is `npm run <validated-name>` or
`python3 -m pytest`. Same sandbox and Stop path as Run. Debugger active
→ refuse.

**LSP** — one process per `(project, language)` inside the sandbox
(`pylsp`, `typescript-language-server`). Yjs text is canonical when a
collab room holds the file. Logout closes that user's socket only.

**Debug** — mediated `/ws/debug` (not raw DAP). Adapters allowlisted.
Collaborators cannot operate another user's session. Debuggee is the
launch snapshot; later editor edits surface a mismatch.

**Git** — `execFile` only. HTTPS remotes; credentials via askpass, never
argv. Pull is fast-forward only. Dirty / collaborator-dirty buffers are
gated (M56). Checkout/pull invalidate the file-tree cache and refresh
the explorer.

**Collaboration** — Yjs CRDT is the shared buffer. LSP and debugger
state are process-local and not stored in Yjs.

## Resource caps (current)

Concurrent runs, search workers, LSP servers, debug sessions, tree
entries, search duration/results, test-case parse count, output buffers,
and PTY slots are all capped. Hitting a cap returns a structured error
(`busy`, `too_many_searches`, …) rather than unbounded work.

## Lifecycle

Project delete stops the sandbox (terminals, LSP, debug, runs), disposes
the collab room, forgets the tree cache, then removes the workspace.
Logout closes that user's sockets and clears that tab's terminal-resume
hints; shared LSP for remaining collaborators continues. A same-tab
reload within the terminal detach grace reattaches the existing PTY
(`resume=1`); it does not spawn a second shell. Process shutdown: stop
maintenance → drain HTTP → close WS → dispose terminals/LSP/debug →
flush collab rooms → close SQLite.
