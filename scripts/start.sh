#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — one-shot bootstrap + start
#
# `npm start` runs this. It provisions everything the server needs to run
# online on a fresh host, then launches the server:
#
#   1. create .env from .env.example if missing
#   2. install Node dependencies (npm install)
#   3. start a local PostgreSQL (docker compose) if Docker is available
#   4. generate the Prisma client
#   5. apply database migrations
#   6. compile TypeScript -> dist/
#   7. seed the database (only if it is empty — never destroys data)
#   8. start the compiled server (node dist/src/app.js)
#
# Safe to run repeatedly: every step is idempotent.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Always operate from the project root (script lives in scripts/).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

# Pretty logs.
log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }

PRISMA="./node_modules/.bin/prisma"

# ── 1. Environment file ──────────────────────────────────────
if [ ! -f .env ]; then
  log "Criando .env a partir do .env.example"
  cp .env.example .env
  ok ".env criado (ajuste JWT_SECRET/POSTGRES_PASSWORD para produção)"
fi

# Load .env so the steps below see DATABASE_URL, ports, etc.
# shellcheck disable=SC1091
set -a; . ./.env; set +a

# ── 2. Dependencies ──────────────────────────────────────────
if [ ! -d node_modules ] || [ ! -f node_modules/.bin/prisma ]; then
  log "Instalando dependências (npm install)"
  npm install --legacy-peer-deps
fi
ok "Dependências instaladas"

# ── 3. PostgreSQL ─────────────────────────────────────────────
# Two modes:
#   A) Docker available on the host: bring up the compose `db` service and use
#      it (port exposed on the host).
#   B) No Docker (e.g. Pterodactyl container): assume an external PostgreSQL
#      reachable via DATABASE_URL / DB_* env vars (provided by the panel).
DB_PORT="${DB_PORT:-5432}"
DB_USER="${POSTGRES_USER:-matrix}"
DB_NAME="${POSTGRES_DB:-matrix}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "Subindo PostgreSQL via Docker Compose"
  docker compose up -d db
  log "Aguardando o banco aceitar conexões em 127.0.0.1:${DB_PORT}"
  # Wait until the port is actually reachable from the host (not just inside
  # the container). The compose healthcheck flips to healthy before the host
  # port is fully wired, so probe the host side directly.
  for i in $(seq 1 40); do
    if docker run --rm --network host postgres:17-alpine \
        pg_isready -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      ok "PostgreSQL pronto (porta $DB_PORT)"
      break
    fi
    sleep 1
  done
  # Normalise the compose-internal "db" host to the host-reachable 127.0.0.1.
  # Use 127.0.0.1 (not "localhost"): "localhost" may resolve to IPv6 ::1 first,
  # which Docker does not bind, causing "Can't reach database server".
  DB_URL="${DATABASE_URL:-postgresql://${DB_USER}:${POSTGRES_PASSWORD:-matrix}@127.0.0.1:${DB_PORT}/${DB_NAME}?schema=public}"
  DB_URL="$(printf '%s' "$DB_URL" | sed -E 's/@db:/@127.0.0.1:/; s/@localhost:/@127.0.0.1:/')"
else
  # No Docker (Pterodactyl, etc.): build DATABASE_URL from DB_* vars if the
  # panel provides them as separate components instead of a single URL.
  if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-${DATABASE_HOST:-}}" ]; then
    DB_HOSTVAL="${DB_HOST:-${DATABASE_HOST}}"
    DB_URL="postgresql://${DB_USER}:${POSTGRES_PASSWORD:-${DB_PASSWORD:-matrix}}@${DB_HOSTVAL}:${DB_PORT}/${DB_NAME}?schema=public"
  else
    DB_URL="${DATABASE_URL:-}"
  fi
  if [ -z "$DB_URL" ]; then
    warn "Nenhum banco configurado."
    warn "Defina DATABASE_URL (ou DB_HOST + POSTGRES_PASSWORD) no painel/ambiente."
    warn "Ex: postgresql://matrix:senha@host:5432/matrix?schema=public"
    exit 1
  fi
  ok "Usando banco externo (modo sem Docker)"
fi
export DATABASE_URL="$DB_URL"

# ── 4. Prisma client ─────────────────────────────────────────
log "Gerando cliente Prisma"
$PRISMA generate
ok "Cliente Prisma gerado"

# ── 5. Migrations ─────────────────────────────────────────────
log "Aplicando migrations"
# Retry: the freshly-started Postgres may still be warming up even after the
# port probe succeeds (first-connection init can take a moment).
for i in $(seq 1 10); do
  if $PRISMA migrate deploy; then
    break
  fi
  warn "Banco ainda não aceita conexões, tentando novamente ($i/10)..."
  sleep 2
done
ok "Migrations aplicadas"

# ── 6. Build ──────────────────────────────────────────────────
log "Compilando TypeScript"
npm run build
ok "Build concluído"

# ── 7. Seed (only if empty) ───────────────────────────────────
log "Verificando necessidade de seed"
# seed.ts skips automatically when users already exist, so this is safe.
./node_modules/.bin/tsx prisma/seed.ts || warn "Seed ignorado/falhou (não bloqueia o start)"
ok "Banco pronto"

# ── 8. Start server ───────────────────────────────────────────
# Pterodactyl exposes the allocated port as SERVER_PORT; PORT takes priority
# when set. The server also reads SERVER_PORT internally as a fallback.
SERVER_PORT_VAL="${SERVER_PORT:-${PORT:-3000}}"
export PORT="$SERVER_PORT_VAL"
log "Iniciando servidor MATRIX API na porta ${PORT}"
ok "Servidor online em http://0.0.0.0:${PORT}"
exec node dist/src/app.js
