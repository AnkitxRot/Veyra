#!/usr/bin/env bash
# Cloud Agent install step: refresh workspace dependencies and (best-effort)
# prepare the Docker toolchain used by the sandbox-execution feature.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== Cloud IDE install =="

# Core dependency install for the npm workspaces (backend + frontend). This
# MUST succeed — the IDE cannot run without it.
if ! npm install; then
  echo "[install] npm install failed" >&2
  exit 1
fi

# Optional: prepare Docker + the sandbox runner image so code execution works.
# Non-fatal by design (see scripts/cloud-agent-docker.sh).
bash scripts/cloud-agent-docker.sh || \
  echo "[install] Docker setup skipped/failed; core IDE still works, sandbox execution disabled"

echo "== Cloud IDE install complete =="
