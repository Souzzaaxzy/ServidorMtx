# ──────────────────────────────────────────────────────────────
# MATRIX API — Dockerfile (production-ready, multi-stage)
# Node 22 + Fastify + Prisma + PostgreSQL
# ──────────────────────────────────────────────────────────────

# ── Stage 1: install deps + build ─────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# OpenSSL is required by Prisma's query engine at build time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma ./prisma

# Install ALL deps (dev included) so we can build + generate the Prisma client.
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Generate the Prisma client (src/generated is gitignored, so it must be
# produced inside the image). Use the locally pinned CLI, not `npx`.
RUN ./node_modules/.bin/prisma generate

# Copy the rest of the source and compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: production runtime ───────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies (tsx included as a runtime dep for `db:seed`).
# Note: we use `npm install` (not `npm ci`) so the lockfile is reconciled
# with the current package.json before installing.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install --legacy-peer-deps --omit=dev

# Copy compiled output + generated Prisma client from the builder stage.
# tsc emits to dist/src/ (rootDir="." includes prisma/), so the compiled
# app is at dist/src/app.js. The Prisma client is plain JS (not compiled),
# so it must be placed where the relative import '../generated/index.js'
# from dist/src/config/prisma.js resolves → dist/src/generated/index.js.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./dist/src/generated

# Source is needed at runtime for `npm run db:seed` (prisma/seed.ts is
# TypeScript executed by tsx, and imports from ../src/*.ts).
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Local uploads directory (when STORAGE_ENDPOINT is empty).
RUN mkdir -p /app/uploads

# Entrypoint runs prisma migrate deploy then starts the server.
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

# tini reaps zombie processes (signal handling for graceful shutdown).
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/src/app.js"]
