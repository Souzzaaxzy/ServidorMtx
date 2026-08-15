#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — container entrypoint (SQLite edition)
#
# Ensures the persistent data/ dir exists, applies pending Prisma migrations
# against the SQLite database (creating it on first boot), then starts the
# compiled server. The DB file is NEVER deleted or reset.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# SQLite file lives in the persistent data/ directory. Use an ABSOLUTE path
# so the Prisma client (compiled dist) and the CLI open the same file.
mkdir -p /app/data
export DATABASE_URL="${DATABASE_URL:-file:/app/data/matrix.db}"

echo "▶ Applying Prisma migrations (SQLite: $DATABASE_URL)…"
# Use the locally pinned CLI (node_modules/.bin/prisma) — never `npx prisma`,
# which would download the latest major and break schema compatibility.
./node_modules/.bin/prisma migrate deploy

echo "▶ Starting MATRIX API…"
exec "$@"
