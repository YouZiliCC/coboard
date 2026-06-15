# syntax=docker/dockerfile:1

# --- Stage 1: build -------------------------------------------------------
# Install all deps, build shared -> web -> server. Produces dist artifacts.
FROM node:22-alpine AS build
WORKDIR /app

# Enable pnpm via corepack (pinned by the root package.json packageManager field).
RUN corepack enable

# Copy manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json drizzle.config.ts ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/

# Install the full workspace (dev deps needed for building).
RUN pnpm install --frozen-lockfile || pnpm install

# Copy the rest of the source.
COPY . .

# Build in dependency order: shared -> web (vite) -> server (tsc).
RUN pnpm --filter shared build \
  && pnpm --filter web build \
  && pnpm --filter server build

# Prune to production dependencies for the runtime image.
# --config.confirm-modules-purge=false: Docker build has no TTY, so pnpm would
# otherwise abort the node_modules purge (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
RUN pnpm install --prod --frozen-lockfile --config.confirm-modules-purge=false \
  || pnpm install --prod --config.confirm-modules-purge=false

# --- Stage 2: runtime -----------------------------------------------------
# Minimal node:22-alpine image with prod deps + built dist only.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

# Workspace manifests + pruned node_modules.
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules

# shared (built) + its node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules

# server (built) + migrations + its node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/server/node_modules ./server/node_modules

# web build output served statically by the server
COPY --from=build /app/web/dist ./web/dist

EXPOSE 3000

# Container start: the server runs migrations on boot, then listens (§9).
WORKDIR /app/server
CMD ["node", "dist/index.js"]
