#!/bin/sh
# Cloud IDE app container entrypoint.
#
# Responsibilities:
#  - Ensure the persistent data directory exists.
#  - When started as root, fix ownership of the data dir and drop to the
#    unprivileged app user (APP_UID/APP_GID) before running the server.
#  - Dropping privileges is only attempted when the target user can reach the
#    Docker socket. On hosts where the socket is root-only (e.g. Docker Desktop)
#    the process stays root, because managing sandboxes requires socket access.
#    The real isolation boundary for untrusted code is the sandbox containers
#    (non-root, all capabilities dropped), not this management process.
set -e

DATA_DIR="${DATA_DIR:-/var/lib/cloud-ide}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"
DOCKER_HOST_VAL="${DOCKER_HOST:-unix:///var/run/docker.sock}"
SOCK_PATH="${DOCKER_HOST_VAL#unix://}"

mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ] && [ "$APP_UID" != "0" ]; then
  chown -R "$APP_UID":"$APP_GID" "$DATA_DIR" 2>/dev/null || true
  if setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
      sh -c "[ -S '$SOCK_PATH' ] && [ -w '$SOCK_PATH' ]" >/dev/null 2>&1; then
    echo "[entrypoint] dropping privileges to uid $APP_UID" >&2
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups "$@"
  else
    echo "[entrypoint] docker socket not writable by uid $APP_UID; staying root" >&2
    exec "$@"
  fi
fi

exec "$@"
