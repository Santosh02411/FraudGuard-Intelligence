# --- Builder: has the toolchain better-sqlite3 needs to compile its native binding ---
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# python3/make/g++ are node-gyp's requirements for building better-sqlite3
# from source — not needed at runtime, which is why this is a separate
# stage from the one that actually ships.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Production deps only — jest/supertest/eslint (devDependencies) have no
# place in a runtime image.
RUN npm ci --omit=dev

# --- Runtime: slim, no build toolchain ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same base image family/glibc as the builder stage, so better-sqlite3's
# compiled .node binding (copied via node_modules below) is ABI-compatible.
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# SQLite is a dev-only default (see config/database.js) — this volume
# mount point exists so a container restart doesn't lose the DB file if
# you do run it this way; set DATABASE_URL to point at Postgres instead
# for anything beyond a quick demo (see docker-compose.yml).
RUN mkdir -p /data
ENV SQLITE_PATH=/data/fraudguard.db
VOLUME ["/data"]

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 5000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
