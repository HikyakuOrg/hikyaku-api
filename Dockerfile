# ---- Build stage ----
FROM node:22-alpine AS builder

RUN npm install -g pnpm@11.20.0
# better-sqlite3 (native dep of @cardog/corgi, used for VIN decoding) has no
# prebuilt binary for Node 22 on musl/Alpine, so pnpm compiles it from source
# via node-gyp — hence the toolchain below.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---- Production stage ----
FROM node:22-alpine AS runner

RUN npm install -g pnpm@11.20.0
# ogr2ogr (Node wrapper, in dependencies) shells out to the GDAL CLI tools
# below to import tzdata.timezone in the background on first boot — see
# src/tzdata.
RUN apk add --no-cache gdal-tools gdal-driver-pg
# Same node-gyp toolchain as the builder stage: this stage runs its own
# `pnpm install`, so better-sqlite3 has to be rebuilt here too.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts is deliberately NOT passed here: pnpm-workspace.yaml's
# `allowBuilds` allowlist (not this flag) is what gates which dependencies may
# run install scripts, and better-sqlite3 needs its install script to build
# its native addon. --ignore-scripts would override that allowlist and disable
# every dependency's scripts unconditionally, including the approved ones.
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3002

# start:prod runs pending migrations (migration:run:prod, over DB_MIGRATION_URL)
# then boots the app — so a deploy never serves against a stale schema.
CMD ["pnpm", "run", "start:prod"]
