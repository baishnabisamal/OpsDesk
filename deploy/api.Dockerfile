# One image for the three Node processes: the API, the worker and the
# WebSocket gateway. Same code, different start command (docker-compose.yml).
# Built from the repository root: docker build -f deploy/api.Dockerfile .

# --- Stage 1: compile TypeScript to JavaScript -----------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Package files first: this layer (npm ci) is reused until a dependency changes.
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace api --include-workspace-root=false
COPY api/ api/
RUN npm run build --workspace api

# --- Stage 2: only what runs ----------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
# Runtime dependencies only: no TypeScript, Vitest or Testcontainers.
RUN npm ci --workspace api --include-workspace-root=false --omit=dev \
 && npm cache clean --force
COPY --from=build /app/api/dist api/dist
# The migration runner looks for the SQL files next to its own folder
# (dist/scripts/../migrations).
COPY api/migrations api/dist/migrations
# Archive files are written here; docker-compose.yml mounts a volume on it.
RUN mkdir -p /data/archive && chown node:node /data/archive
WORKDIR /app/api
# Never run as root inside the container.
USER node
CMD ["node", "--enable-source-maps", "dist/src/server.js"]
