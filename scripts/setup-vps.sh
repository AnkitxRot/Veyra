#!/usr/bin/env bash
# One-time VPS preparation: create the persistent data directory and verify the
# Docker daemon prerequisite. Safe to re-run.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/cloud-ide}"
mkdir -p "$DATA_DIR/workspaces"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not found on this host." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running or not accessible." >&2
  exit 1
fi

DG="$(getent group docker 2>/dev/null | cut -d: -f3 || true)"
echo "Data dir:    $DATA_DIR"
echo "Docker gid:  ${DG:-<no docker group; app will run as root>}"
echo
echo "Next steps:"
echo "  npm run runner:build     # build the sandbox runner image"
echo "  DOCKER_GID=${DG:-999} docker compose up -d"
