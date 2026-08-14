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
# produced inside the image).
RUN npx prisma generate

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

# Only production dependencies.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev --legacy-peer-deps || npm install --omit=dev --legacy-peer-deps

# Copy compiled output + generated Prisma client from the builder stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated

# Local uploads directory (when STORAGE_ENDPOINT is empty).
RUN mkdir -p /app/uploads

# Entrypoint runs prisma migrate deploy then starts the server.
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

# tini reaps zombie processes (signal handling for graceful shutdown).
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/app.js"]
