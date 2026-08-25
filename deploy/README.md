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

Set in production (not in `.env`): `NODE_ENV=production` (already set in the image),
and any secrets your reverse proxy needs.

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

Restore by copying the DB and workspaces back into `/var/lib/cloud-ide` and starting.

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

### 5. Offline Disaster Recovery Runbook

> [!WARNING]
> Database restoration replaces the active SQLite database and must **only** be performed while the application service is stopped. Never overwrite the database file while the application process is running.

#### Step-by-Step Restoration Procedure

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

## Troubleshooting

- **Readiness 503 (docker false):** the socket is not mounted or not accessible. Check
  `/var/run/docker.sock` and `DOCKER_GID`.
- **Readiness 503 (runnerImage false):** build it with `npm run runner:build`.
- **Preview returns 502/504:** the project's app isn't actually listening on that port
  inside the sandbox, or the sandbox is not running. Run the project first.
- **Execution says Docker not running:** the daemon is down or the socket mount is
  missing. `docker info` on the host must succeed.
