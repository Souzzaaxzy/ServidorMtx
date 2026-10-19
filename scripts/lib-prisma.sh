#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — Prisma helpers shared by start.sh / scripts/start.sh.
#
# Sourced, never executed. Exposes:
#   matrix_is_termux              → 0 when running under Termux/Android
#   matrix_prisma_generate <cli>  → generates the client, offline-safe
#   matrix_migrate <cli>          → applies migrations with the right engine
#
# WHY THIS EXISTS
# The Prisma CLI ALWAYS downloads and executes a native `schema-engine`
# binary. Prisma publishes no Android/bionic build, so on Termux
# `prisma generate` / `prisma migrate deploy` fail with:
#     Prisma detected unknown OS "android" … Defaulting to "linux".
#     Error: Schema engine error
#     … is for EM_X86_64 (62) instead of EM_AARCH64 (183)
# `engineType = "client"` only makes the *Client* Rust-free; the CLI is not.
#
# Two verified facts drive the strategy below:
#   1. `prisma generate` does NOT execute the schema engine — it only needs
#      the path to exist. Pointing PRISMA_SCHEMA_ENGINE_BINARY at any existing
#      file makes generation work fully OFFLINE and still emit the complete
#      JS/WASM client (verified: the generated client connects and queries).
#   2. `prisma migrate deploy` DOES execute the engine, so it can never work on
#      Termux. There we use `src/db/migrate.ts`, a node:sqlite runner that
#      applies the same migration.sql files and writes byte-identical
#      `_prisma_migrations` bookkeeping (verified: 148/148 schema objects and
#      the full bookkeeping table match `prisma migrate deploy` exactly, and
#      the two are interchangeable in both directions).
# ──────────────────────────────────────────────────────────────

matrix_is_termux() {
  if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
    return 0
  fi
  return 1
}

# A placeholder the Prisma CLI accepts for `generate` (it is never executed).
# Kept inside the project so it survives across runs and needs no permissions.
matrix_engine_placeholder() {
  local root="${1:-.}"
  local dir="$root/node_modules/.cache"
  local file="$dir/matrix-schema-engine-placeholder"
  mkdir -p "$dir" 2>/dev/null || true
  if [ ! -f "$file" ]; then
    printf '#!/bin/sh\nexit 1\n' > "$file" 2>/dev/null || true
    chmod +x "$file" 2>/dev/null || true
  fi
  printf '%s' "$file"
}

# matrix_prisma_generate <prisma-cli> [root]
# On Termux: generate offline (no engine download/execution).
# Elsewhere: plain `prisma generate` (unchanged behavior).
matrix_prisma_generate() {
  local prisma="$1"
  local root="${2:-.}"
  if matrix_is_termux; then
    PRISMA_SCHEMA_ENGINE_BINARY="$(matrix_engine_placeholder "$root")" \
      "$prisma" generate
  else
    "$prisma" generate
  fi
}

# matrix_migrate <prisma-cli> [root]
# On Termux: node:sqlite runner (no native engine).
# Elsewhere: `prisma migrate deploy` (the conventional, supported path).
matrix_migrate() {
  local prisma="$1"
  local root="${2:-.}"
  if matrix_is_termux; then
    # Prefer the compiled runner; fall back to running the TypeScript source
    # directly with tsx. The fallback matters because this step can run before
    # `npm run build` (the compiled dist/ may not exist yet).
    local cli="$root/dist/src/db/migrate-cli.js"
    if [ -f "$cli" ]; then
      node "$cli" deploy
      return $?
    fi
    if [ -x "$root/node_modules/.bin/tsx" ]; then
      ( cd "$root" && ./node_modules/.bin/tsx src/db/migrate-cli.ts deploy )
      return $?
    fi
    echo "[matrix] ERRO: runner de migrations indisponível." >&2
    echo "[matrix] Rode 'npm install' e 'npm run build' antes de iniciar." >&2
    return 1
  fi
  "$prisma" migrate deploy
}
