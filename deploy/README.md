# CloudeeeIDE — Production Deployment (single-node VPS)

This document describes how to run CloudeeeIDE on a **Docker-capable Linux VPS/VM**
as a single node. The architecture is intentionally unchanged from development:
Express backend + Vite frontend + SQLite + host Docker daemon for per-project
sandboxes, preview proxy, and WebSockets.

## Deployment model

The application container manages sandboxes through the **host Docker daemon** via
the mounted `/var/run/docker.sock`. This is Docker-out-of-Docker (DooD):

- No Docker-in-Docker. The app image contains only the Docker **CLI**.
- The Docker daemon is never exposed publicly; only the local socket is mounted.
- Sandboxes are sibling containers created on the host daemon, labeled
  `cloudeeeide.managed=true`, one per project, on isolated per-project networks.

```
 host (Linux VPS, Docker daemon running)
 ├── cloudeeeide-app container
 │     ├── Express backend + built frontend (serves /, /api, /ws)
 │     ├── SQLite + workspaces  ->  bind mount /var/lib/cloud-ide
 │     └── docker CLI           ->  /var/run/docker.sock
 ├── ide-sandbox-<projectA>   (runner image, non-root, caps dropped)
 ├── ide-sandbox-<projectB>
 └── ...
```

### Two path-identity requirements (read this)

1. **Data directory.** The backend passes `/var/lib/cloud-ide/workspaces/<id>` to
   `docker run -v`. The host daemon resolves that path on the **host** filesystem,
   so the data volume must be mounted at the **same path** inside and outside the
   container: `/var/lib/cloud-ide:/var/lib/cloud-ide`. Do not remap it to a
   different host path.

2. **Preview reachability.** Sandbox preview ports are published to host loopback
   (`127.0.0.1::`). A containerized backend cannot reach host loopback bindings, so
   when `APP_CONTAINERIZED=1` the backend joins each project's sandbox network and
   proxies to the sandbox container by name on its **internal** port. No host
   networking or public port exposure is needed.

## Prerequisites

- Linux host with Docker Engine running (`docker info` succeeds).
- Docker CLI on the host (to build images).
- ~1 GB disk for images plus workspace growth under `/var/lib/cloud-ide`.

## Deploy

```bash
# 1. One-time host prep (creates data dir, checks Docker).
npm run deploy:setup

# 2. Build the sandbox runner image (required for execution).
npm run runner:build

# 3. Build the app image and start the stack.
#    Detects the host docker group gid automatically for non-root socket access.
npm run deploy:up
```

The app listens on `http://<host>:3000` by default.

### Manual equivalent

```bash
mkdir -p /var/lib/cloud-ide/workspaces
docker build -t cloudeeeide-runner:latest -f docker/Dockerfile.runner .
DOCKER_GID=$(getent group docker | cut -d: -f3) docker compose build
docker compose up -d
```

## Required environment variables

`ADMIN_PASSWORD` is required in `.env` before the first deploy — `docker compose up`
will refuse to start without it. Everything else is optional and has a safe default
(see `.env.example`):

| Variable                  | Default      | Purpose                                                                                                                                                                                            |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_USERNAME`          | `admin`      | Username of the bootstrapped administrator account.                                                                                                                                                |
| `ADMIN_PASSWORD`          | _(required)_ | Password for the bootstrapped administrator account. Set once in `.env`; the account is created on first startup and this value is not used to change its password afterward — see `.env.example`. |
| `HTTP_PORT`               | `3000`       | Host port published for the app.                                                                                                                                                                   |
| `DOCKER_GID`              | `999`        | Host docker group gid for non-root socket access.                                                                                                                                                  |
| `MAX_SANDBOXES`           | `20`         | Hard cap on concurrent sandbox containers.                                                                                                                                                         |
| `PROJECT_QUOTA`           | `20`         | Max projects per user.                                                                                                                                                                             |
| `MAX_CONCURRENT_RUNS`     | `3`          | Max concurrent executions per user.                                                                                                                                                                |
| `SANDBOX_IDLE_TIMEOUT_MS` | `1800000`    | Idle time before a sandbox is reaped.                                                                                                                                                              |
| `SANDBOX_ROOM_EMPTY_GRACE_MS` | `120000` | Grace period after a project's collaboration room empties before its sandbox becomes eligible for early reaping (before the full idle timeout).                                                     |
| `SECRETS_MASTER_KEY`      | _(unset)_    | Master key for **project secrets & environment variables** (M47). 32 bytes, encoded as base64 or 64 hex characters. Required only if any project uses the Secrets feature — see the section below. |

Set in production (not in `.env`): `NODE_ENV=production` (already set in the image),
and any secrets your reverse proxy needs.

## Project secrets & environment variables (M47)

Owners can attach encrypted per-project environment variables (marked as
secrets or as plain config). They are injected into **runs and terminal
sessions** — never into `install` — via a `0600` file staged inside the
sandbox container's tmpfs (values are never placed on a `docker` command
line). Secret values are write-only: no API or UI path returns a stored
secret value once written; the list view shows metadata plus an optional
last-4 fingerprint only.

### `SECRETS_MASTER_KEY`

- **Source of truth is this one operator-supplied variable.** The server
  never generates a key and never reads one from a file or the database.
- Generate one: `openssl rand -base64 32` (or `openssl rand -hex 32`).
- Malformed material (wrong length, not base64/hex) is rejected.
- The key is **never** written to SQLite, the workspace, a backup artifact,
  a log line, or an API response.

### Fail-closed behaviour

- The server **starts without the key** as long as no encrypted secret
  exists yet. Once secrets exist, startup logs a clear `[secrets]` warning if
  the key is missing/invalid, and every secret-dependent operation (CRUD,
  run/terminal injection) fails with a generic 5xx — it never runs with a
  partial or empty secret set and never returns partial plaintext.

### Backup / restore interaction

- **Database backups** contain the `secrets` table as **ciphertext only**.
  The master key is not in the backup.
- Restoring a database backup **under the same `SECRETS_MASTER_KEY`** recovers
  all secrets. Restoring under a **missing or different** key leaves those
  rows permanently undecryptable — this is intentional, not a bug. Keep the
  key backed up separately from the database, with equivalent care.
- **Workspace backups** and **workspace ZIP exports** never contain
  platform-managed secret values (they are DB rows, not workspace files). An
  ordinary `.env` file a user placed in the workspace is unaffected and keeps
  its existing include/exclude behaviour.

### Key rotation

- Rows store a `key_version` (currently always `1`). Rotation to a new key
  version is a future addition and does not require a destructive schema
  migration. There is no automated re-encryption today: rotating
  `SECRETS_MASTER_KEY` in place makes existing secrets undecryptable, so
  re-enter them after a deliberate rotation.

### Limitations (no KMS)

This is application-level AES-256-GCM with a locally-configured key on a
single node. It protects secrets at rest in the database and in database
backup files. It is **not** equivalent to a KMS/HSM and does not defend
against an attacker with code execution or root on the live host (the key is
resident in process memory while the server runs).

## Local Git version control (M51) and HTTPS remotes (M80)

Every project can hold its own Git repository at
`<data-dir>/workspaces/<projectId>/.git`. `git` is available both to the
backend (which drives the in-IDE **Source Control** panel) and inside the
project sandbox (so `git` in the Veyra terminal operates on the exact same
repository). No configuration is required.

- **HTTPS remotes (M80).** M51's local-only decision is superseded for
  transport: the IDE can clone, fetch, fast-forward-only pull, and push
  against an `https://` remote named `origin`. SSH, `git://`, `file://`,
  local paths, and credential-bearing URLs (`https://user:token@…`) are
  rejected. Git LFS, submodules, force-push, merge, and rebase are not
  supported.
- **Credentials.** HTTPS PATs/passwords are stored as reserved M47 project
  secrets (`GIT_HTTPS_USERNAME`, `GIT_HTTPS_TOKEN`): encrypted at rest,
  owner-set, never returned by the API, never written into `.git/config` or
  the remote URL, never placed on a Git argv, never injected into
  run/terminal environments, and never copied on export/fork. Git is
  authenticated via a transient askpass helper (0600 files outside the
  workspace). Unset `SECRETS_MASTER_KEY` makes credentialed operations fail
  closed.
- **Pull safety.** Pull is `merge --ff-only` only. Diverged branches and
  dirty / collaborator-dirty buffers are rejected through the same M56
  mutation gate as checkout. Fetch does not change the working tree.
- **Commit authorship.** Commits made from the IDE or the terminal are
  attributed to `<username> <username@veyra.local>` — a synthesized local
  identity derived from the authenticated account. The browser client cannot
  set an arbitrary author. (A terminal user can `git config user.email` in
  their own sandbox; that only affects their own subsequent terminal
  commits.)
- **Permissions.** Project owners and editors have full Git read/write;
  viewers have read-only Git access; non-collaborators get the same
  IDOR-safe `404` as every other project route.
- **`.git` is NOT portable in v1.** It is deliberately excluded from ZIP
  export, from `git`-less ZIP import, from per-project workspace backups, and
  from project snapshots. **Forking a project starts a fresh repository** —
  the source project's history is not inherited. If you need history to
  travel with a project, keep it in a remote of your own (outside Veyra) for
  now.
- **Snapshot restore preserves `.git`.** Restoring a project snapshot rolls
  back the ordinary workspace files but leaves the Git repository, its
  commit history, and its branches intact (snapshots never captured `.git`
  in the first place).
- **Hooks.** A hook committed into `.git/hooks/` never runs on the
  application/control-plane process — backend Git invocations force an empty
  `core.hooksPath` and read no system/global/user Git config. Hooks _can_
  run when you invoke `git` yourself from the Veyra terminal, but only
  inside the isolated sandbox container, as the unprivileged sandbox user —
  the same trust boundary that already contains all other terminal activity.
- **Committing secrets.** If you `git commit` a `.env` file (or any file
  with plaintext credentials), those secrets are written into the project's
  Git history and will persist across commits. Veyra's platform-managed
  encrypted secrets (M47) are the safe place for credentials; a committed
  `.env` is not protected by them.

## Persistent volume paths

| Path                                                | Contents                           | Survives redeploy? |
| --------------------------------------------------- | ---------------------------------- | ------------------ |
| `/var/lib/cloud-ide/cloudide.db` (+ `-wal`, `-shm`) | SQLite (users, sessions, projects) | Yes (volume)       |
| `/var/lib/cloud-ide/workspaces/<projectId>/`        | Project files                      | Yes (volume)       |

Everything durable lives under `/var/lib/cloud-ide`. Sandbox **containers** and
**networks** are ephemeral and are recreated/reconciled automatically on startup; they
do not need to be persisted.

## Backup / restore

Stop the app, then back up the data directory (SQLite in WAL mode is crash-safe, but a
clean copy is best taken while quiescent):

```bash
docker compose stop
sqlite3 /var/lib/cloud-ide/cloudide.db ".backup /backup/cloudide-$(date +%F).db"
tar czf /backup/workspaces-$(date +%F).tgz -C /var/lib/cloud-ide workspaces
docker compose start
```

Restore the database with `npm run db:restore -- --latest` (see the Offline Disaster
Recovery Runbook below) after stopping the app; restore workspaces by extracting the
`.tgz` back into `/var/lib/cloud-ide`.

## Database migrations

Schema is versioned via a `schema_migrations` table (`backend/src/db.ts`). The current
schema is baseline version 1; existing databases are marked at baseline on first open
and any future migrations apply idempotently on startup. No manual migration step is
required for deploys.

## Reverse proxy / TLS

Run a reverse proxy (Caddy/nginx/Traefik) in front of port 3000 to terminate TLS.

- Forward `/`, `/api`, and `/ws` to the app.
- **Enable WebSocket upgrades** (`Connection: Upgrade`, `Upgrade: websocket`).
- Set `X-Forwarded-For` / `X-Forwarded-Proto`; the app trusts the first hop
  (`TRUST_PROXY=1` is set in compose) so rate limiting and `secure` cookies work.
- Cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
- Disable or minimize **upstream keep-alive** to the app (verified: reused
  keep-alive connections can misbehave after a request passes through the
  preview proxy route). In Caddy: `reverse_proxy ... { transport http { keepalive off } }`.

Minimal Caddy example:

```
ide.example.com {
    reverse_proxy localhost:3000
}
```

Caddy handles TLS and WebSocket upgrades automatically.

## Health checks

- `GET /api/health` — liveness. Cheap, independent of Docker; the container is not
  restarted just because the execution runtime is unavailable.
- `GET /api/health/ready` — readiness. Returns 503 unless the database, Docker daemon,
  and runner image are all available. Use this to gate traffic, not restarts.

The compose healthcheck uses `/api/health`.

## Automated deployment smoke verification

Validate the complete vertical stack of a running deployment in seconds:

```bash
# Run against local instance (default: http://localhost:3000)
npm run deploy:smoke

# Or specify a custom target URL (local or remote VPS)
node scripts/smoke-test.js --url=https://ide.example.com
```

The smoke test exercises 11 automated scenarios in sequence:

1. **Liveness**: verifies `GET /api/health` HTTP 200 and live status.
2. **Readiness**: verifies `GET /api/health/ready` database, Docker daemon, and runner image checks.
3. **Authentication**: provisions a disposable smoke user with strong credentials and tests session cookie issuance.
4. **User Preferences**: tests `GET`/`PUT` preferences persistence and SQLite storage fidelity.
5. **Project Creation**: creates a temporary project and lists directory tree.
6. **File I/O**: writes Python code to `main.py` and verifies exact byte-level readback.
7. **Docker Execution**: executes Python program inside an isolated sandbox container and verifies stdout matching.
8. **Preview Proxy**: tests preview authorization and proxy routing on port 8000 (and validates port restrictions).
9. **Workspace Export**: downloads `GET /api/projects/:id/export` ZIP archive, verifies PKZIP headers, and confirms content exclusions.
10. **WebSocket Handshake**: connects to `/ws/collab` using session cookie authentication and verifies binary protocol sync frames.
11. **Cleanup & Teardown**: deletes the temporary project and logs out the session in a guaranteed `finally` block.

**Exit codes:**

- `0`: All required deployment checks passed (instance is production ready).
- `1`: One or more checks failed with detailed diagnostic error messages.

## Graceful shutdown

`SIGTERM`/`SIGINT` triggers a drain: background timers stop, WebSocket clients are
closed (which kills in-flight execs/PTYs), the HTTP server stops accepting and waits
for open requests, then SQLite is closed. Persistent sandboxes, workspaces, and the DB
are left intact and recovered on the next startup. A grace period
(`SHUTDOWN_GRACE_MS`, default 10s) force-exits if connections never drain.

## Security notes

- The app process needs Docker socket access. On a VPS it drops to a non-root user in
  the `docker` group when the socket permits; on hosts where the socket is root-only it
  stays root. In both cases the **untrusted-code isolation boundary is the sandbox
  container** (non-root `ide` user, `--cap-drop ALL`, `no-new-privileges`, memory/CPU/
  pids limits, isolated network), not the management process.
- Sandbox preview ports bind to host loopback only; they are not exposed publicly. The
  only authenticated preview path is `/api/projects/:id/proxy/:port` (auth-gated).
- Keep `/var/run/docker.sock` mounted only into this app container. Anyone with socket
  access can control the host daemon.
- Existing rate limits, quotas, run gates, and container restrictions remain enforced.

## Operations

```bash
docker compose ps                 # status + health
docker compose logs -f app        # logs
docker compose restart app        # restart (sandboxes reconcile on startup)
docker ps -f label=cloudeeeide.managed=true   # live sandboxes
```

Idle sandboxes are reaped automatically; orphaned containers/networks are cleaned at
startup by reconciliation.

## Database Backups & Disaster Recovery

CloudeeeIDE uses an online point-in-time snapshot mechanism powered by SQLite `VACUUM INTO`. This is "online" at the SQLite/WAL engine level — no other database connection or process is locked out while a backup runs. It is **not** non-blocking at the application level: the backup implementation uses Node's synchronous `DatabaseSync` API, so `VACUUM INTO` and the subsequent integrity check block the Node process's event loop for their duration, meaning no other HTTP, WebSocket, or terminal traffic in that process is serviced while a backup executes. Measured cost at the tested database size (~260KB) is small (~8ms), but backup latency scales with database size — schedule production backups off-peak (e.g. via the cron job below) and monitor duration as the database grows.

Backup creation, retention pruning, and deletion are serialized through a cross-process filesystem lock in the backup directory, shared by both the admin API (server-triggered backups) and this CLI (cron-triggered backups), so the two can never race against each other even though they run as separate OS processes.

### 1. Manual Backup Command

Run the standalone CLI backup utility from the host or within the container:

```bash
npm run db:backup
# Or directly with node:
node scripts/backup-db.js --backup-dir=/var/lib/cloud-ide/backups --max-backups=10
```

Sample output:

```
============================================================
  Veyra SQLite Production Database Backup
============================================================
  Target Database:  /var/lib/cloud-ide/cloudeeeide.db
  Backup Directory: /var/lib/cloud-ide/backups

  ✓ Online backup completed and verified:
    File:       cloudeeeide_backup_2026-08-26T01-30-00-000Z_a1b2c3d4.db
    Size:       266,240 bytes (260.0 KB)
    Duration:   8ms
    Integrity:  ok
    Retention:  10 backups retained (0 pruned)
============================================================
```

### 2. Automated Scheduled Backups (Cron)

To take automated hourly or daily backups with automatic oldest-first pruning, add a cron job on the host system:

```bash
# Run backup daily at 02:00 UTC
0 2 * * * cd /opt/cloudeeeide && /usr/bin/npm run db:backup >> /var/log/cloudeeeide-backup.log 2>&1
```

### 3. Backup Configuration Tunables

| Variable               | Default                      | Purpose                                                               |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `BACKUP_DIR`           | `/var/lib/cloud-ide/backups` | Target directory for timestamped `.db` backup files.                  |
| `MAX_DATABASE_BACKUPS` | `10`                         | Maximum number of backup files to retain before oldest-first pruning. |
| `MAX_BACKUP_BYTES`     | `104857600` (100MB)          | Maximum total storage allocated for backup retention.                 |

### 4. Admin API Management

Authenticated administrators can manage backups programmatically:

- `GET /api/admin/backups`: Lists all backups with size, timestamp, and integrity status.
- `POST /api/admin/backups`: Triggers an online backup and integrity check.
- `GET /api/admin/backups/:filename`: Downloads a verified backup file.
- `DELETE /api/admin/backups/:filename`: Safely deletes a specific backup and records an audit log.

Restore is deliberately **not** exposed here or anywhere over HTTP: replacing the live
database file is only safe while nothing has it open, and the very process serving an admin
HTTP request would itself hold that file open. Restore is a CLI-only, offline operation — see
below.

### 5. Offline Disaster Recovery Runbook

> [!WARNING]
> Database restoration replaces the active SQLite database and must **only** be performed while the application service is stopped. Never overwrite the database file while the application process is running — neither the automated tool below nor any manual command can safely detect a still-running application, so stopping it first is the operator's responsibility.

#### Step-by-Step Restoration Procedure (automated, preferred)

1. **Stop the application service**:

   ```bash
   docker compose -f deploy/docker-compose.prod.yml stop app
   ```

2. **Choose a backup** (skip if using `--latest`):

   ```bash
   ls -la /var/lib/cloud-ide/backups/
   ```

3. **Run the restore command**:

   ```bash
   npm run db:restore -- --latest
   # or restore a specific backup:
   npm run db:restore -- --backup-file=cloudeeeide_backup_<TIMESTAMP>_<NONCE>.db
   ```

   `scripts/restore-db.js` (`backend/src/backup/shared.js`'s `restoreDatabaseFromBackup`)
   performs the full safe sequence automatically: verifies the chosen backup's integrity via
   `PRAGMA integrity_check` **before** touching the live database (a failed check aborts with
   the live database untouched); makes a timestamped safety copy of the current live database
   — plus its `-wal`/`-shm` sidecars if present — under `<data-dir>/restore-safety/` **before**
   any destructive action (this safety copy is never deleted automatically); replaces the live
   database via a same-directory copy-to-temp-file followed by a single `rename` over the live
   path (the only operation that ever touches the final live path, so a failure mid-copy can
   never leave it partially written); removes the now-stale live `-wal`/`-shm` sidecars
   (which describe the pre-restore generation and must not be replayed against the restored
   file); and re-verifies integrity of the now-live restored file before reporting success.
   The whole operation runs under the same cross-process backup lock `db:backup` uses, so it
   can never race a concurrently-running scheduled backup.

   **This is expected, not an error**: any live database writes made after the restored
   backup's own creation timestamp are permanently lost — that is the nature of restoring to
   a prior point in time.

   **If post-restore verification fails**: the command exits non-zero and reports the failure
   prominently. It does **not** attempt an automatic rollback — the pre-restore safety copy
   created in this same run remains at the path the command printed (under
   `<data-dir>/restore-safety/`), and manual recovery from that safety copy, or from a
   different backup, is required.

4. **Verify the command's own output** confirms `Post-Restore Integrity: ok`.

5. **Start the application service**:

   ```bash
   docker compose -f deploy/docker-compose.prod.yml start app
   ```

6. **Verify deployment readiness**:
   ```bash
   npm run deploy:smoke
   ```

#### Manual Fallback Procedure

If `scripts/restore-db.js` is unavailable for any reason, the equivalent steps can be
performed by hand:

1. **Stop the application service**:

   ```bash
   docker compose -f deploy/docker-compose.prod.yml stop app
   ```

2. **Make a safety copy of the current state**:

   ```bash
   cp /var/lib/cloud-ide/cloudeeeide.db /var/lib/cloud-ide/cloudeeeide.db.corrupt-backup
   # Remove active WAL journals so SQLite starts with clean single-file state
   rm -f /var/lib/cloud-ide/cloudeeeide.db-wal /var/lib/cloud-ide/cloudeeeide.db-shm
   ```

3. **Select a verified backup file**:

   ```bash
   ls -la /var/lib/cloud-ide/backups/
   ```

4. **Restore the database**:

   ```bash
   cp /var/lib/cloud-ide/backups/cloudeeeide_backup_<TIMESTAMP>_<NONCE>.db /var/lib/cloud-ide/cloudeeeide.db
   ```

5. **Verify database integrity before starting**:

   ```bash
   node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/var/lib/cloud-ide/cloudeeeide.db'); console.log('Integrity:', db.prepare('PRAGMA integrity_check').get()); db.close();"
   ```

6. **Start the application service**:

   ```bash
   docker compose -f deploy/docker-compose.prod.yml start app
   ```

7. **Verify deployment readiness**:
   ```bash
   npm run deploy:smoke
   ```

## Workspace & Snapshot Backups (Milestone 31)

The database backup/restore above protects everything in `cloudeeeide.db` (accounts, project
metadata, audit history, snapshot _records_, etc.), but not the two filesystem-resident pieces of
durable project state: `<data-dir>/workspaces/<projectId>/` (actual project source files) and
`<data-dir>/snapshots/<projectId>/` (the gzip _bodies_ of user-created snapshots — the `snapshots`
table only stores their metadata). Milestone 31 adds an automated, admin-managed **backup** for
these two, per project; Milestone 32 added the matching **automated restore**
(`POST /api/admin/workspace-backups/:projectId/:filename/restore`), and Milestone 46 surfaced both
in the admin dashboard's "Database & Workspace Backups" tab. Manual extraction of an archive into
`<data-dir>/workspaces/<projectId>/` still works as a fallback but is no longer required.

### What is included / excluded

Each backup is a single ZIP per project containing:

- `workspace/<relative-path>` — every file under that project's workspace, including hidden files
  and `.env`-shaped files, **captured exactly as they exist** — this is a disaster-recovery
  artifact, not a redacted export. See "Secrets" below.
- `snapshots/<snapshotId>.gz` — every snapshot payload body currently on disk for that project.
- `manifest.json` — a small self-describing summary (project id/name, capture timestamp, file and
  snapshot counts).

Excluded, matching the workspace's own existing exclusion model exactly (`SKIP_DIRS`/
`BUILD_PREFIX` in `backend/src/files/service.ts`, the same set every file-tree/export/fork
operation already excludes): `.git`, `node_modules`, `.venv`, `.cloudide-build-*` directories, and
any symlinked file or directory (never followed, silently skipped). Never included: live sandbox/
container state, Yjs collaboration room state, WebSocket presence, terminal state, runtime locks,
or in-memory telemetry — none of this is durable project data.

### Secrets

Because `.env` and other dotfiles are included intentionally, a workspace backup can contain raw,
unhashed secrets a user placed in their own project. This is a materially different risk profile
than the database backup (which only ever contains hashed passwords). Mitigation for this
milestone: admin-only API access (identical `requireAdmin` gate as database backups), 0o600 file /
0o700 directory permissions on POSIX (best-effort, matching the database backup convention), and
backups are never served statically or exposed to ordinary collaborators. **Encryption-at-rest is
deliberately not implemented in this milestone** — the current single-VPS, locally-retained-backup
deployment model doesn't clearly justify the added key-management complexity, but this is a
conscious, documented tradeoff, not an oversight, and should be revisited if off-site replication
or a stronger threat model is ever adopted.

### Consistency model

**This backup provides per-project eventual consistency. Database metadata and filesystem state
are not captured as one globally atomic transaction.** A database backup taken at one moment and a
workspace backup taken at another can describe slightly different project states (e.g. a project
renamed or deleted in between) — true cross-domain atomicity would require either freezing the
whole application's writes (disruptive, and inconsistent with this project's own "schedule
off-peak" precedent already accepted for database backups) or a distributed-transaction-like
mechanism this codebase has no other use for. Consistency is enforced at _project_ granularity
only, via the same per-project lock (`withProjectSnapshotLock`) snapshot restore and export already
use — a workspace backup can never race a concurrent snapshot restore of the _same_ project.
Ordinary file edits (`POST /:id/file`, `/move`, `/delete`, `/upload`) do **not** participate in
this lock, so a file edited concurrently with a backup may be captured in its pre- or post-edit
state, or omitted if it was deleted mid-walk — an accepted eventual-consistency window, not a
defect.

### Retention

Per project, not global — one project's large history never displaces another's retained backups.

| Variable                                 | Default             | Purpose                                               |
| ---------------------------------------- | ------------------- | ----------------------------------------------------- |
| `MAX_WORKSPACE_BACKUPS_PER_PROJECT`      | `5`                 | Max backup files retained per project (oldest-first). |
| `MAX_WORKSPACE_BACKUP_BYTES_PER_PROJECT` | `262144000` (250MB) | Max total backup storage per project.                 |

### Admin API

```
POST   /api/admin/workspace-backups/:projectId              Creates a backup for the project.
GET    /api/admin/workspace-backups/:projectId               Lists that project's backups.
GET    /api/admin/workspace-backups/:projectId/:filename     Downloads a specific backup.
DELETE /api/admin/workspace-backups/:projectId/:filename     Deletes a specific backup.
POST   /api/admin/workspace-backups/:projectId/:filename/restore   Restores that backup in place (M32; destructive, admin-only).
```

Admin-only, same as the database backup routes. `:projectId` list/download/delete deliberately do
**not** require the source project to still exist — a backup's entire purpose is to survive
deletion of its source, so it remains fully manageable (and its download/delete still gets audited)
even after the project itself is gone.

### Scheduling

Not implemented in this milestone — creation is admin-triggered/on-demand only (`POST
/api/admin/workspace-backups/:projectId`). Unlike the database backup CLI (which needs a separate
OS process specifically for `VACUUM INTO`'s connection semantics), this feature runs entirely
server-side and needs no cross-process coordination — but adding a bounded, safely-cancellable
background scheduler is a distinct concern (queue design, shutdown lifecycle, per-project
overlap-skipping) that deserves its own focused pass rather than being folded into establishing the
archive format/security/retention/admin-API layer in the same milestone. An operator who wants
regular workspace backups today should trigger them via the admin API on their own schedule (e.g.
an external cron job calling the endpoint) until a future milestone adds one natively.

## Backup Health Observability (Milestone 34)

`GET /api/admin/health` (admin-only) now includes a `backups` field reporting real backup posture,
computed fresh on every call — no background poller, no cache. This closes a real blind spot: an
operator running the `db:backup` cron job above has no other way to discover it silently stopped
working until the moment a real disaster makes that too late to matter.

```json
"backups": {
  "database": {
    "status": "ok",
    "backupCount": 3,
    "latestBackupCreatedAt": "2026-08-26T02:00:00.000Z",
    "latestBackupAgeMs": 41400000,
    "warningAgeMs": 93600000,
    "criticalAgeMs": 172800000
  },
  "workspaces": {
    "status": "ok",
    "totalProjects": 12,
    "coveredProjects": 12,
    "uncoveredProjects": 0,
    "coveragePercent": 100,
    "oldestLatestBackupAgeMs": 3600000,
    "oldestLatestBackupProjectId": "…",
    "warningAgeMs": 93600000,
    "criticalAgeMs": 172800000
  }
}
```

**Database backup status** is based on the newest backup that actually passes
`PRAGMA integrity_check` — a corrupt newest file is skipped in favor of an older valid one, never
reported as if it were healthy. `backupCount` is an honest total file count, independent of which
(if any) are valid.

**Workspace backup status** tracks two deliberately separate dimensions: _coverage_ (does every
project have at least one backup at all?) and _freshness_ (how old is the least-recently-backed-up
covered project's newest backup?). Status rules, checked in order:

| Status     | Condition                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `never`    | no project has ever been backed up (and at least one project exists)                                          |
| `critical` | any project has zero backups, OR the oldest covered project's newest backup exceeds the critical age          |
| `stale`    | every project has at least one backup, but the oldest covered project's newest backup exceeds the warning age |
| `ok`       | otherwise (including the vacuous case of zero projects total)                                                 |

Both dimensions share the same two age thresholds:

| Variable                        | Default           | Purpose                                                                   |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `BACKUP_HEALTH_WARNING_AGE_MS`  | `93600000` (26h)  | Tolerates a once-daily cron running a bit late before warning.            |
| `BACKUP_HEALTH_CRITICAL_AGE_MS` | `172800000` (48h) | A full missed day — the daily job has failed outright, not just run late. |

**Only aggregate metadata is ever reported** — no backup filenames, filesystem paths, or project
content appear in this response, matching the same admin-only gate every other backup route already
uses.

**Deliberately NOT wired into `GET /api/health` or `GET /api/health/ready`.** Those are
process-liveness/readiness signals consumed by container orchestration for restart decisions, and
are documented above as deliberately independent even of Docker for that reason. A stale backup is
an operational fact about disaster-recovery posture, not evidence the running process itself is
broken — conflating the two would make an unrelated cron failure trigger pointless container
restarts that do nothing to fix the actual problem. Check `backups` under `/api/admin/health`
specifically for this signal.

## Troubleshooting

- **Readiness 503 (docker false):** the socket is not mounted or not accessible. Check
  `/var/run/docker.sock` and `DOCKER_GID`.
- **Readiness 503 (runnerImage false):** build it with `npm run runner:build`.
- **Preview returns 502/504:** the project's app isn't actually listening on that port
  inside the sandbox, or the sandbox is not running. Run the project first.
- **Execution says Docker not running:** the daemon is down or the socket mount is
  missing. `docker info` on the host must succeed.
