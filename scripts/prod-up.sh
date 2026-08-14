#!/usr/bin/env bash
# Build the runner + app images and start the single-node production stack.
# Run from any directory; it resolves the repository root automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="${DATA_DIR:-/var/lib/cloud-ide}"
mkdir -p "$DATA_DIR/workspaces"

# Detect the host docker group gid so the app user can reach the socket on a VPS.
DOCKER_GID="$(getent group docker 2>/dev/null | cut -d: -f3 || true)"
export DOCKER_GID="${DOCKER_GID:-999}"

echo "==> Building sandbox runner image (cloudeeeide-runner:latest)..."
docker build -t cloudeeeide-runner:latest -f docker/Dockerfile.runner .

echo "==> Building application image (DOCKER_GID=$DOCKER_GID)..."
docker compose build

echo "==> Starting stack..."
docker compose up -d

echo "==> Status:"
docker compose ps
echo
echo "App:      http://localhost:${HTTP_PORT:-3000}"
echo "Health:   http://localhost:${HTTP_PORT:-3000}/api/health"
echo "Readiness: http://localhost:${HTTP_PORT:-3000}/api/health/ready"
