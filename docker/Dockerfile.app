# syntax=docker/dockerfile:1
#
# Cloud IDE application image (multi-stage).
# Build from the repository root:  docker build -f docker/Dockerfile.app .
#
# This image manages sandboxes through the HOST Docker daemon via the mounted
# /var/run/docker.sock (Docker-out-of-Docker). It does NOT run Docker-in-Docker
# and does NOT expose the daemon.

# ---------- Stage 1: build frontend + backend ----------
FROM node:22-bookworm AS build

# node-pty is a native module and needs a toolchain to compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace-aware install driven by the lockfile for reproducibility.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci

# Copy sources and build both workspaces.
COPY tsconfig.base.json ./
COPY backend/ backend/
COPY frontend/ frontend/

# See ci.yml's "Frontend typecheck + build" step for the measured rationale:
# the monaco-editor-heavy vite build peaks ~2.9GB, above V8's default ~2GB
# old-space ceiling. Scoped to this build stage only (does not carry into
# the stage-2 runtime image).
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build -w @cloud-ide/frontend \
 && npm run build -w @cloud-ide/backend

# Keep only production dependencies for the runtime copy.
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime

# Must match the host docker socket group for non-root socket access on a VPS.
ARG DOCKER_GID=999

# Docker CLI (to drive the host daemon over the socket) and setpriv for the
# entrypoint's privilege drop.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg util-linux git \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user whose uid matches the sandbox runner's `ide` user (1000).
# The node base image already uses uid 1000 for its `node` user, so rename it.
RUN groupadd -g "${DOCKER_GID}" docker \
 && groupmod -n ide node \
 && usermod -l ide -m -d /home/ide node \
 && usermod -aG docker ide

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/var/lib/cloud-ide \
    APP_CONTAINERIZED=1

# Runtime artifacts: production node_modules, compiled backend (with its own
# package.json so ESM resolution is correct), and the built frontend.
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /var/lib/cloud-ide \
 && chown -R ide:ide /app /var/lib/cloud-ide

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "backend/dist/index.js"]
