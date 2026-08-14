#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — container entrypoint
#
# Runs pending Prisma migrations against DATABASE_URL, then starts the
# compiled server. This guarantees the schema is in sync every time the
# container boots — no manual migrate step needed on the host.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

echo "▶ Applying Prisma migrations…"
npx prisma migrate deploy

echo "▶ Starting MATRIX API…"
exec "$@"
