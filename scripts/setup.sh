#!/usr/bin/env bash
# Cloud IDE setup: installs toolchains, creates the unprivileged sandbox user,
# and prepares data/cgroup directories. Java is best-effort and never blocks.
set -u
export DEBIAN_FRONTEND=noninteractive

echo "== Cloud IDE setup =="

ensure() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "  $1 available: $("$1" --version 2>/dev/null | head -n1 || true)"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  installing $1..."
    apt-get install -y "$2" >/dev/null 2>&1 && echo "  $1 installed" || echo "  WARNING: could not install $1 (continuing without it)"
  else
    echo "  WARNING: $1 not found and no apt-get available"
  fi
}

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
fi

ensure python3 python3
ensure node nodejs
ensure npm npm
ensure gcc gcc
ensure g++ g++
ensure java default-jdk-headless

# Unprivileged sandbox user (skip if it already exists or cannot be created)
if ! id ide >/dev/null 2>&1; then
  useradd -r -m -s /bin/bash -u 1000 ide && echo "  created sandbox user 'ide'" || echo "  WARNING: could not create 'ide' user (will fall back to nobody)"
fi

mkdir -p /var/lib/cloud-ide/workspaces
chmod 0755 /var/lib/cloud-ide /var/lib/cloud-ide/workspaces 2>/dev/null || true
mkdir -p /sys/fs/cgroup/cloudide 2>/dev/null || true

echo "== Setup complete =="
