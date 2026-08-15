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

# Pretty banner printed first so the panel console shows tooling + repo state
# immediately, before any .env is loaded.
mask_url() {
  # Mask the password inside a connection URL: postgresql://user:PASS@host...
  printf '%s' "$1" | sed -E 's#://([^:]+):[^@]+@#://\1:****@#'
}
diag_header() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "  MATRIX API — diagnóstico de ambiente"
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Data/hora     : $(date 2>/dev/null || echo '?')"
  echo "  Diretório     : $(pwd)"
  echo "  Node          : $(node --version 2>/dev/null || echo 'NÃO ENCONTRADO')"
  echo "  npm           : $(npm --version 2>/dev/null || echo 'NÃO ENCONTRADO')"
  echo "  git           : $(git --version 2>/dev/null || echo 'NÃO ENCONTRADO')"
  echo "  package.json  : $([ -f package.json ] && echo 'presente ✓' || echo 'AUSENTE ✗')"
  echo "  node_modules  : $([ -d node_modules ] && echo 'presente ✓' || echo 'ausente')"
  echo "  dist/         : $([ -d dist ] && echo 'presente ✓' || echo 'ausente')"
}
diag_vars() {
  echo "  ── Variáveis de ambiente ──"
  echo "  NODE_ENV      : ${NODE_ENV:-<vazio>}"
  echo "  PORT          : ${PORT:-<vazio>}"
  echo "  SERVER_PORT   : ${SERVER_PORT:-<vazio>}"
  echo "  DATABASE_URL  : $(mask_url "${DATABASE_URL:-<vazio>}")"
  echo "  DB_HOST       : ${DB_HOST:-<vazio>}"
  echo "  DB_PORT       : ${DB_PORT:-<vazio>}"
  echo "  POSTGRES_USER : ${POSTGRES_USER:-<vazio>}"
  echo "  POSTGRES_DB   : ${POSTGRES_DB:-<vazio>}"
  echo "  JWT_SECRET    : $([ -n "${JWT_SECRET:-}" ] && echo 'definido ✓' || echo '<vazio>')"
  echo "  ── Banco esperado pelo Prisma ──"
  echo "  provider      : $(sed -n '/datasource/,/^}/p' prisma/schema.prisma 2>/dev/null | grep -E '^\s*provider' || echo '?')"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
}
diag_header

# ── 1. Environment file ──────────────────────────────────────
if [ ! -f .env ]; then
  log "Criando .env a partir do .env.example"
  cp .env.example .env
  ok ".env criado (ajuste JWT_SECRET/POSTGRES_PASSWORD para produção)"
fi

# Load .env, but NEVER overwrite variables already set in the environment.
# This is critical for Pterodactyl: the panel injects DATABASE_URL,
# JWT_SECRET, SERVER_PORT, etc. as real env vars, and a plain `set -a; . ./.env`
# would clobber them with the .env.example defaults. dotenv (used by Node at
# runtime) has the same no-override behaviour, so we mirror it here.
load_env_no_override() {
  local key val
  while IFS='=' read -r key val || [ -n "$key" ]; do
    # Skip comments and blank lines.
    case "$key" in
      ''|\#*) continue ;;
    esac
    # Strip surrounding whitespace/quotes from key and value.
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    val="${val#\"}"; val="${val%\"}"
    val="${val#\'}"; val="${val%\'}"
    # Only set if not already present in the environment.
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < .env
}
load_env_no_override
diag_vars

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

# ── 3b. Probe external database connectivity + type check ─────
# In Pterodactyl (no Docker) we cannot use `pg_isready` from a container, so
# probe the TCP port directly with bash /dev/tcp. Also detect whether the
# configured URL is a MySQL URL — the Prisma schema expects PostgreSQL, so a
# MySQL URL means the panel gave a MySQL database and the app will fail.
DB_SCHEME="$(printf '%s' "$DB_URL" | sed -E 's#^([a-z]+)://.*#\1#')"
if [ "$DB_SCHEME" = "mysql" ] || [ "$DB_SCHEME" = "mariadb" ]; then
  warn "=============================================================="
  warn "  BANCO MySQL DETECTADO — o MATRIX API precisa de PostgreSQL!"
  warn "  O painel forneceu um banco MySQL, mas o Prisma está"
  warn "  configurado para PostgreSQL. Crie um banco PostgreSQL no"
  warn "  painel (ou use um Postgres externo) e atualize DATABASE_URL."
  warn "  DATABASE_URL atual: $(mask_url "$DB_URL")"
  warn "=============================================================="
  exit 1
fi

# Extract host:port from the URL for a TCP reachability probe.
DB_PROBE_HOST="$(printf '%s' "$DB_URL" | sed -nE 's#.*@([^:/]+).*#\1#p')"
DB_PROBE_PORT="$(printf '%s' "$DB_URL" | sed -nE 's#.*@[^:/]+:([0-9]+).*#\1#p')"
DB_PROBE_PORT="${DB_PROBE_PORT:-5432}"
if [ -n "${DB_PROBE_HOST:-}" ] && [ "$DB_PROBE_HOST" != "$DB_URL" ]; then
  log "Testando conexão com ${DB_PROBE_HOST}:${DB_PROBE_PORT}..."
  if (exec 3<>/dev/tcp/"$DB_PROBE_HOST"/"$DB_PROBE_PORT") 2>/dev/null; then
    ok "Porta ${DB_PROBE_HOST}:${DB_PROBE_PORT} acessível (TCP conectou)"
    exec 3>&- 2>/dev/null || true
  else
    warn "Não foi possível conectar a ${DB_PROBE_HOST}:${DB_PROBE_PORT} (TCP)."
    warn "Verifique no painel se o banco está ativo e se host/porta estão corretos."
  fi
fi

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
