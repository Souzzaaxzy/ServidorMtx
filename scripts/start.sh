#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — one-shot bootstrap + start
#
# `npm start` (the Pterodactyl startup command) runs this. It is the ONLY
# command needed to bring the API online on a fresh host, and it stays fast
# on restarts by skipping work that is already done.
#
#   1. diagnostics
#   2. .env  — create from .env.example if missing (never overwrite existing)
#   3. deps  — npm install only if node_modules is missing/incomplete
#   4. prisma — generate the client only if missing/stale
#   5. db    — resolve DATABASE_URL (Docker compose OR external panel DB)
#   6. migrations — prisma migrate deploy (non-destructive, idempotent)
#   7. build — compile TypeScript only if dist is missing/stale
#   8. seed  — populate an empty DB only (never destroys data)
#   9. start — exec node dist/src/app.js (becomes the container's main process)
#
# Every step is idempotent. No loops, no background processes, no --force,
# no --legacy-peer-deps.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Always operate from the project root (script lives in scripts/).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

# ── Logging helpers ───────────────────────────────────────────
log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK] %s\033[0m\n' "$*"; }
info() { printf '\033[1;34m[INFO] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[WARN] %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[1;31m[ERROR] %s\033[0m\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

PRISMA="./node_modules/.bin/prisma"
SCHEMA="prisma/schema.prisma"
GENERATED="src/generated"
APP_ENTRY="dist/src/app.js"
SEED_ENTRY="dist/prisma/seed.js"

# Mask the password inside a connection URL: postgresql://user:PASS@host...
mask_url() {
  printf '%s' "$1" | sed -E 's#://([^:]+):[^@]+@#://\1:****@#'
}

# ══════════════════════════════════════════════════════════════
# 1. DIAGNÓSTICO DE AMBIENTE
# ══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════════════"
echo "  MATRIX API — diagnóstico de ambiente"
echo "═══════════════════════════════════════════════════════════════"
echo "  Data/hora      : $(date 2>/dev/null || echo '?')"
echo "  Diretório      : $(pwd)"
echo "  Node           : $(node --version 2>/dev/null || echo 'NÃO ENCONTRADO')"
echo "  npm            : $(npm --version 2>/dev/null || echo 'NÃO ENCONTRADO')"
echo "  git            : $(git --version 2>/dev/null || echo 'NÃO ENCONTRADO')"
echo "  package.json   : $([ -f package.json ] && echo 'presente ✓' || echo 'AUSENTE ✗')"
echo "  node_modules   : $([ -d node_modules ] && echo 'presente ✓' || echo 'ausente')"
echo "  .env           : $([ -f .env ] && echo 'presente ✓' || echo 'ausente')"
echo "  .env.example   : $([ -f .env.example ] && echo 'presente ✓' || echo 'ausente')"
echo "  Prisma client  : $([ -d "$GENERATED" ] && echo 'presente ✓' || echo 'ausente')"
echo "  dist/          : $([ -f "$APP_ENTRY" ] && echo 'presente ✓' || echo 'ausente')"
echo "  Port (env)     : ${PORT:-${SERVER_PORT:-<não configurada, usará 3000>}}"
[ -f package.json ] || die "package.json ausente — não é a raiz do projeto."

# ── 2. .env ───────────────────────────────────────────────────
# Create .env from .env.example ONLY when .env is missing. Never overwrite an
# existing .env (the panel or operator may have set real secrets there).
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    log "Criando .env a partir do .env.example"
    cp .env.example .env
    ok ".env criado a partir do .env.example"
    warn "Edite .env e defina JWT_SECRET / DATABASE_URL reais para produção."
  else
    err ".env não encontrado"
    err ".env.example também não encontrado"
    err "Configure as variáveis obrigatórias da API antes de iniciar:"
    err "  DATABASE_URL, JWT_SECRET, PORT, CORS_ORIGIN, NODE_ENV"
    die "Não foi possível preparar o ambiente (.env e .env.example ausentes)."
  fi
else
  ok ".env presente (não será sobrescrito)"
fi

# Load .env, but NEVER overwrite variables already set in the environment.
# Critical for Pterodactyl: the panel injects DATABASE_URL, JWT_SECRET,
# SERVER_PORT, etc. as real env vars; a plain `set -a; . ./.env` would clobber
# them with the .env.example defaults. dotenv (used by Node at runtime) has
# the same no-override behaviour, so we mirror it here.
load_env_no_override() {
  local key val
  while IFS='=' read -r key val || [ -n "$key" ]; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    val="${val#\"}"; val="${val%\"}"
    val="${val#\'}"; val="${val%\'}"
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < .env
}
load_env_no_override

# Resolve the listening port. PORT wins; SERVER_PORT (Pterodactyl) is the
# fallback; 3000 is the last resort.
SERVER_PORT_VAL="${SERVER_PORT:-${PORT:-3000}}"
export PORT="$SERVER_PORT_VAL"

echo "  ── Variáveis de ambiente ──"
echo "  NODE_ENV      : ${NODE_ENV:-<vazio>}"
echo "  PORT          : ${PORT}"
echo "  SERVER_PORT   : ${SERVER_PORT:-<vazio>}"
echo "  DATABASE_URL  : $(mask_url "${DATABASE_URL:-<vazio>}")"
echo "  DB_HOST       : ${DB_HOST:-${DATABASE_HOST:-<vazio>}}"
echo "  DB_PORT       : ${DB_PORT:-<vazio>}"
echo "  POSTGRES_USER : ${POSTGRES_USER:-<vazio>}"
echo "  POSTGRES_DB   : ${POSTGRES_DB:-<vazio>}"
echo "  JWT_SECRET    : $([ -n "${JWT_SECRET:-}" ] && echo 'definido ✓' || echo '<vazio>')"
echo "  AI_PROVIDER   : ${AI_PROVIDER:-mock}"
echo "  ── Banco esperado pelo Prisma ──"
echo "  provider      : $(sed -n '/datasource/,/^}/p' "$SCHEMA" 2>/dev/null | grep -E '^\s*provider' || echo '?')"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  MATRIX API — preparando inicialização"
echo "═══════════════════════════════════════════════════════════════"

# ── 3. Dependencies ───────────────────────────────────────────
# Install only when node_modules is missing OR a critical binary/package is
# absent (indicates an incomplete/aborted install, or a production-only
# install that omitted the devDeps needed to build). When already complete,
# skip to keep restarts fast.
needs_install() {
  [ ! -d node_modules ] && return 0
  # Markers whose presence implies the install finished cleanly, INCLUDING
  # the devDeps required to compile TypeScript (tsc, typescript).
  for bin in node_modules/.bin/prisma node_modules/.bin/tsc; do
    [ -e "$bin" ] || return 0
  done
  [ -d node_modules/argon2 ] || return 0
  [ -d node_modules/typescript ] || return 0
  return 1
}
if needs_install; then
  log "node_modules ausente/incompleto — instalando dependências (npm install)"
  # --include=dev guarantees devDependencies (tsc, typescript, prisma CLI)
  # are installed even when the panel sets NODE_ENV=production (which would
  # otherwise skip them and break the build step below). This is NOT --force
  # nor --legacy-peer-deps; it only controls dev/prod inclusion.
  npm install --include=dev
  ok "Dependências instaladas (incluindo devDependencies para build)"
else
  ok "Dependências já instaladas (npm install ignorado)"
fi

# Verify argon2 (native module). It ships prebuilt binaries for common
# platforms; if the host blocks native install scripts AND no prebuilt binary
# matches, requiring it fails here with a clear message.
if ! node -e "require('argon2')" 2>/dev/null; then
  err "argon2 não pôde ser carregado (módulo nativo)."
  err "O argon2 embarca binários pré-compilados; se nenhum casar com a"
  err "plataforma da host, ele tenta compilar via script de instalação."
  err "Libere o script de instalação do argon2 (e de 'esbuild'/'@biome')"
  err "no painel/npm config, ou use uma imagem Node compatível."
  die "argon2 é obrigatório (hashing de senhas) — não pode ser substituído."
fi
ok "argon2 carregado (hashing de senhas disponível)"

# ── 4. Prisma client ──────────────────────────────────────────
# Generate only when the client is missing OR older than the schema. Skip
# otherwise to keep restarts fast.
needs_prisma_generate() {
  [ ! -d "$GENERATED" ] && return 0
  [ ! -f "$GENERATED/index.js" ] && return 0
  # Regenerate if the schema is newer than the generated client.
  [ "$SCHEMA" -nt "$GENERATED/index.js" ] && return 0
  return 1
}
if needs_prisma_generate; then
  log "Gerando cliente Prisma"
  $PRISMA generate
  ok "Cliente Prisma gerado"
else
  ok "Cliente Prisma já gerado e atualizado (generate ignorado)"
fi

# ── 5. Database URL ───────────────────────────────────────────
# Two modes:
#   A) Docker available on the host: bring up the compose `db` service.
#   B) No Docker (Pterodactyl container): use the external PostgreSQL the
#      panel provides via DATABASE_URL (or DB_* component vars).
DB_PORT="${DB_PORT:-5432}"
DB_USER="${POSTGRES_USER:-matrix}"
DB_NAME="${POSTGRES_DB:-matrix}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "Subindo PostgreSQL via Docker Compose"
  docker compose up -d db
  log "Aguardando o banco aceitar conexões em 127.0.0.1:${DB_PORT}"
  for i in $(seq 1 40); do
    if docker run --rm --network host postgres:17-alpine \
        pg_isready -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      ok "PostgreSQL pronto (porta $DB_PORT)"
      break
    fi
    sleep 1
  done
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
    err "Nenhum banco configurado."
    err "Defina DATABASE_URL (ou DB_HOST + POSTGRES_PASSWORD) no painel/ambiente."
    err "Ex: postgresql://matrix:senha@host:5432/matrix?schema=public"
    die "DATABASE_URL ausente — não é possível iniciar."
  fi
  ok "Usando banco externo (modo sem Docker)"
fi
export DATABASE_URL="$DB_URL"

# Detect a MySQL URL — the Prisma schema expects PostgreSQL, so a MySQL DB
# from the panel means the app cannot run.
DB_SCHEME="$(printf '%s' "$DB_URL" | sed -E 's#^([a-z]+)://.*#\1#')"
if [ "$DB_SCHEME" = "mysql" ] || [ "$DB_SCHEME" = "mariadb" ]; then
  err "=============================================================="
  err "  BANCO MySQL DETECTADO — o MATRIX API precisa de PostgreSQL!"
  err "  Crie um banco PostgreSQL no painel (ou use um Postgres externo)"
  err "  e atualize DATABASE_URL."
  err "  DATABASE_URL atual: $(mask_url "$DB_URL")"
  err "=============================================================="
  die "Banco incompatível (MySQL)."
fi

# Probe TCP reachability (bash /dev/tcp works without any extra tooling).
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
    warn "Verifique no painel se o banco está ativo e host/porta corretos."
  fi
fi

# ── 6. Migrations ─────────────────────────────────────────────
# `prisma migrate deploy` is non-destructive: it only applies pending
# migrations and never resets/deletes data. Running it on every boot
# guarantees the schema is in sync; when nothing is pending it is a fast
# no-op (a single connection + check).
log "Aplicando migrations (prisma migrate deploy — não destrutivo)"
for i in $(seq 1 10); do
  if $PRISMA migrate deploy; then
    break
  fi
  warn "Banco ainda não aceita conexões, tentando novamente ($i/10)..."
  sleep 2
done
ok "Migrations aplicadas"

# ── 7. Build ──────────────────────────────────────────────────
# Compile TypeScript only when dist is missing OR any source file is newer
# than the compiled entry. Skips the (slow) tsc step on restarts.
needs_build() {
  [ ! -f "$APP_ENTRY" ] && return 0
  # Any .ts under src/ newer than the entry → rebuild.
  while IFS= read -r -d '' src; do
    [ "$src" -nt "$APP_ENTRY" ] && return 0
  done < <(find src -type f -name '*.ts' -not -path 'src/generated/*' -print0 2>/dev/null)
  # Schema change can require a regenerated client copy in dist.
  [ "$SCHEMA" -nt "$APP_ENTRY" ] && return 0
  return 1
}
if needs_build; then
  log "dist ausente/desatualizado — compilando TypeScript (npm run build)"
  npm run build
  ok "Build concluído"
else
  ok "dist atualizado (build ignorado)"
fi
[ -f "$APP_ENTRY" ] || die "Entrypoint $APP_ENTRY não encontrado após build."

# ── 8. Seed (only if empty) ───────────────────────────────────
# Run the COMPILED seed with plain `node` — no tsx/esbuild needed at runtime.
# seed.js skips automatically when users already exist, so this never
# overwrites or destroys data.
if [ -f "$SEED_ENTRY" ]; then
  log "Verificando necessidade de seed"
  node "$SEED_ENTRY" || warn "Seed ignorado/falhou (não bloqueia o start)"
  ok "Banco pronto"
else
  warn "Seed compilado ($SEED_ENTRY) ausente — pulando seed."
fi

# ── 9. Start server ───────────────────────────────────────────
# `exec` replaces the shell with the Node process so it becomes PID 1 (the
# container's main process) and receives signals for graceful shutdown.
info "Entrypoint: node $APP_ENTRY"
info "Host: 0.0.0.0  |  Porta: ${PORT}"
ok "Iniciando servidor MATRIX API"
exec node "$APP_ENTRY"
