#!/usr/bin/env bash
# Cloud Agent start step: per-boot runtime initialization. Ensures the data
# directory exists and the Docker daemon is running for sandbox execution.
# Dependency installation and the runner-image build live in the install step.
set -uo pipefail
cd "$(dirname "$0")/.."

mkdir -p "${DATA_DIR:-$HOME/.cloud-ide}/workspaces"

# Ensure dockerd is up (idempotent; a no-op when already running). Best-effort.
bash scripts/cloud-agent-docker.sh || true
