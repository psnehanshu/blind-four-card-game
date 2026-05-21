# syntax=docker/dockerfile:1.7

# Multi-stage build for blind-four. Stages:
#   deps-root  - install root npm deps (engine + server, with native build tools)
#   deps-web   - install web npm deps
#   builder    - copy sources, run sanity, compile server (tsc), build web (vite)
#   prod-deps  - install runtime-only npm deps (engine + server)
#   runtime    - nginx-unprivileged image serving web/dist and proxying /api
#                to the in-container node game server. Single exposed port 8080.

ARG NODE_IMAGE=node:24-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27

# ---------- deps-root ----------
FROM ${NODE_IMAGE} AS deps-root
WORKDIR /app
# better-sqlite3 needs a native build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------- deps-web ----------
FROM ${NODE_IMAGE} AS deps-web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

# ---------- builder ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps-root /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json eslint.config.ts ./
COPY .prettierrc .prettierignore ./
COPY engine ./engine
COPY server ./server

COPY --from=deps-web /app/web/node_modules ./web/node_modules
COPY web ./web

# Gate the build on lint + typecheck + format + engine/server tests.
RUN npm run sanity

# Vite production build -> /app/web/dist
RUN cd web && npm run typecheck && npm run build

# Server compile -> /app/dist (mirrors engine/* + server/* layout).
# Inline tsconfig.build.json so we don't add a file to the repo just for Docker.
RUN printf '%s\n' \
  '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":false,"outDir":"dist","declaration":false,"sourceMap":false},"include":["engine/**/*.ts","server/**/*.ts"],"exclude":["**/*.test.ts"]}' \
  > tsconfig.build.json \
 && npx tsc -p tsconfig.build.json

# ---------- prod-deps ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM ${NGINX_IMAGE} AS runtime
USER root

# Both nginx-unprivileged:1.27 and node:24-slim are debian-bookworm-slim based,
# so the node binary copied here links cleanly against the runtime's glibc /
# libstdc++ — and stays ABI-compatible with the better-sqlite3 native binding
# built in prod-deps against the same node:24-slim.
COPY --from=deps-root /usr/local/bin/node /usr/local/bin/node

# nginx site config: static SPA + /api proxy with WebSocket upgrade.
# The base image's nginx.conf already includes /etc/nginx/conf.d/*.conf inside
# its http {} block, so we only need to override the server block.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# App: prod node_modules, compiled server JS, built web assets.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=builder   /app/dist         /app/dist
COPY --from=builder   /app/web/dist     /usr/share/nginx/html

# Entrypoint supervises node + nginx.
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R nginx:nginx /app

USER nginx
WORKDIR /app
ENV NODE_ENV=production \
    GAME_SERVER_PORT=3001 \
    SERVER_ENTRY=/app/dist/server/index.js \
    DB_PATH=/app/data/blind-four.db

VOLUME ["/app/data"]
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
