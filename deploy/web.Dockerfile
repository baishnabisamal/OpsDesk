# The public front door: Caddy serves the built React app and passes /api and
# /socket.io on to the Node processes. It also gets and renews the HTTPS
# certificate on its own.
# Built from the repository root: docker build -f deploy/web.Dockerfile .

# --- Stage 1: build the React app -----------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace web --include-workspace-root=false
COPY web/ web/
# "true" lists the seeded demo accounts on the login page (public demo only).
ARG VITE_DEMO_LOGINS=false
ENV VITE_DEMO_LOGINS=$VITE_DEMO_LOGINS
RUN npm run build --workspace web

# --- Stage 2: Caddy with the static files ---------------------------------
FROM caddy:2.10-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist /srv
