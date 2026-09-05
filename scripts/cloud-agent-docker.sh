#!/usr/bin/env bash
# Best-effort Docker setup for the CloudeeeIDE sandbox-execution feature inside a
# Cloud Agent VM. Idempotent and intentionally non-fatal: the core IDE (backend
# API + frontend) runs fine without Docker; only the code-execution and terminal
# sandbox features require it. Any failure here disables those features but must
# never break environment setup.
set -uo pipefail

log() { echo "[docker-setup] $*"; }
cd "$(dirname "$0")/.."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    log "no root privileges and sudo unavailable; skipping Docker setup"
    exit 0
  fi
fi

# 1. Install the Docker engine if the daemon binary is missing.
if ! command -v dockerd >/dev/null 2>&1; then
  log "installing docker.io ..."
  $SUDO apt-get update -y >/dev/null 2>&1 || true
  if ! $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io >/dev/null 2>&1; then
    log "docker.io install failed; skipping Docker setup"
    exit 0
  fi
fi

# 2. The Cloud Agent root filesystem is overlayfs. Docker's default overlay
#    snapshotter cannot mount overlay-on-overlay (mount fails with EINVAL), so
#    force the vfs storage driver, which works on any filesystem.
$SUDO mkdir -p /etc/docker
echo '{ "storage-driver": "vfs", "features": { "containerd-snapshotter": false } }' \
  | $SUDO tee /etc/docker/daemon.json >/dev/null

# 3. Start the daemon if it is not already responding.
if ! $SUDO docker info >/dev/null 2>&1; then
  log "starting dockerd ..."
  $SUDO sh -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 30); do
    $SUDO docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! $SUDO docker info >/dev/null 2>&1; then
  log "dockerd did not become ready; sandbox execution disabled"
  exit 0
fi

# 4. Make the socket usable by the app process without a docker-group re-login.
#    Acceptable for a single-tenant dev VM; production uses group membership.
[ -S /var/run/docker.sock ] && $SUDO chmod 666 /var/run/docker.sock || true

# 5. Build the sandbox runner image if it is not present yet.
if ! docker image inspect cloudeeeide-runner:latest >/dev/null 2>&1; then
  log "building cloudeeeide-runner:latest (first run, may take a few minutes) ..."
  if ! docker build -t cloudeeeide-runner:latest -f docker/Dockerfile.runner . >/var/log/runner-build.log 2>&1; then
    log "runner image build failed (see /var/log/runner-build.log); sandbox execution disabled"
    exit 0
  fi
fi

log "Docker ready (storage-driver=vfs, cloudeeeide-runner:latest present)."
