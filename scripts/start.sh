#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — one-shot bootstrap + start (SQLite edition)
#
# `npm start` (the Pterodactyl/Bronxys startup command) runs this. It is the
# ONLY command needed to bring the API online on a fresh host, and it stays
# fast on restarts by skipping work that is already done.
#
#   1. diagnostics
#   2. .env  — load if present (OPTIONAL; never required, never overwritten).
#              In production (Pterodactyl/Bronxys) variables come from process.env.
#   3. deps  — npm install only if node_modules is missing/incomplete
#   4. data  — create the persistent data/ dir (SQLite lives here)
#   5. db    — resolve DATABASE_URL (defaults to the local SQLite file)
#   6. prisma — generate the client only if missing/stale
#   7. validate — check required process.env (JWT_SECRET, PORT); DB is optional
#   8. migrations — prisma migrate deploy (creates the DB on first boot)
#   9. build — compile TypeScript only if dist is missing/stale
#  10. seed  — populate an empty DB only (never destroys data)
#  11. start — exec node dist/src/app.js (becomes the container's main process)
#
# Every step is idempotent. No loops, no background processes, no --force,
# no --legacy-peer-deps. No PostgreSQL, no psql, no external database.
# The SQLite file at data/matrix.db is NEVER deleted or reset by this script.
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
DATA_DIR="data"
DB_FILE="$DATA_DIR/matrix.db"

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
echo "  .env           : $([ -f .env ] && echo 'presente ✓' || echo 'ausente (opcional)')"
echo "  .env.example   : $([ -f .env.example ] && echo 'presente ✓' || echo 'ausente (opcional)')"
echo "  Prisma Client  : $([ -d "$GENERATED" ] && echo 'OK ✓' || echo 'ausente')"
echo "  dist/          : $([ -f "$APP_ENTRY" ] && echo 'presente ✓' || echo 'ausente')"
echo "  PORT           : ${PORT:-${SERVER_PORT:-<não configurada, usará 3000>}}"
echo "  SQLite         : configurado ✓"
echo "  Database       : $DB_FILE"
echo "  Database file  : $([ -f "$DB_FILE" ] && echo 'presente ✓' || echo 'será criado na primeira inicialização')"
echo "  JWT_SECRET     : $([ -n "${JWT_SECRET:-}" ] && echo 'configurado ✓' || echo 'NÃO CONFIGURADO')"
echo "  NODE_ENV       : ${NODE_ENV:-<vazio>}"
[ -f package.json ] || die "package.json ausente — não é a raiz do projeto."

# ── 2. .env (OPTIONAL) ─────────────────────────────────────────
# .env is a convenience for local development. In production (Pterodactyl/
# Bronxys) the panel injects every variable through process.env, so .env is
# NOT required. .env.example is documentation only and is never copied.
#
# If .env exists, load it — but NEVER overwrite variables already set in the
# environment (the panel injects JWT_SECRET, PORT, etc. as real env vars; a
# plain `set -a; . ./.env` would clobber them).
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
if [ -f .env ]; then
  load_env_no_override
  ok ".env presente (carregado, variáveis do painel não sobrescritas)"
else
  ok ".env ausente — usando variáveis de ambiente (process.env) diretamente"
fi

# Resolve the listening port. PORT has ABSOLUTE priority; SERVER_PORT (the
# variable Pterodactyl injects with the allocated port) is the fallback;
# 3000 is the last resort for LOCAL DEVELOPMENT only. The user never needs
# to configure the port manually on the panel.
export PORT="${PORT:-${SERVER_PORT:-3000}}"

echo "  ── Resumo ──"
echo "  Banco          : SQLite (local, sem PostgreSQL/psql)"
echo "  Arquivo do DB  : $DB_FILE"
echo "  Porta          : $PORT (obtida do ambiente)"
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

# ── 4. Data directory (persistent SQLite storage) ─────────────
# Create data/ if it does not exist. NEVER delete or reset the DB file —
# it holds all users, posts, comments, etc. and must survive restarts.
# uploads/ is the local file-storage root used when STORAGE_ENDPOINT is
# empty (the @fastify/static plugin warns if the directory is missing).
mkdir -p "$DATA_DIR" uploads
ok "Diretório de dados pronto: $DATA_DIR/"
if [ -f "$DB_FILE" ]; then
  ok "Banco SQLite existente detectado: $DB_FILE (dados preservados)"
else
  info "Banco SQLite ausente — será criado na etapa de migrations"
fi

# ── 5. Database URL (SQLite, absolute path) ───────────────────
# The schema uses a local SQLite file. DATABASE_URL is OPTIONAL: if the
# panel does not set it, we default to an ABSOLUTE path to the local file.
# Prisma resolves `file:` paths relative to the schema.prisma directory,
# which differs between the CLI (prisma/), the dev client (src/generated)
# and the compiled client (dist/src/generated) — an absolute path removes
# all that ambiguity so every component opens the exact same file.
export DATABASE_URL="${DATABASE_URL:-file:$(pwd)/$DB_FILE}"
info "DATABASE_URL = $DATABASE_URL"

# ── 6. Prisma client ──────────────────────────────────────────
# Generate only when the client is missing OR older than the schema. Skip
# otherwise to keep restarts fast.
needs_prisma_generate() {
  [ ! -d "$GENERATED" ] && return 0
  [ ! -f "$GENERATED/index.js" ] && return 0
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

# ── 7. Validação de variáveis obrigatórias ─────────────────────
# JWT_SECRET is the ONLY hard requirement (it signs auth tokens). It is read
# from process.env (injected by the panel). Secrets are NEVER printed —
# only "configurado"/"ausente". The port is NEVER validated here: it always
# resolves from PORT / SERVER_PORT / 3000 above, so the user does not need
# to configure it manually. DATABASE_URL is NOT required (SQLite local).
log "Validando variáveis de ambiente obrigatórias"
VALIDATION_ERRORS=0
if [ -n "${JWT_SECRET:-}" ]; then
  ok "JWT_SECRET configurado"
else
  err "JWT_SECRET não configurado"
  VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))
fi
info "PORT = ${PORT} (obtida automaticamente do ambiente — não precisa configurar)"
# NODE_ENV is recommended but not fatal (defaults handled by the app).
if [ -n "${NODE_ENV:-}" ]; then
  ok "NODE_ENV configurado (${NODE_ENV})"
else
  info "NODE_ENV ausente (o servidor usará o padrão)"
fi
# CORS_ORIGIN is optional (defaults to '*' in the app) — report only.
if [ -n "${CORS_ORIGIN:-}" ]; then
  ok "CORS_ORIGIN configurado"
else
  info "CORS_ORIGIN ausente (o servidor usará o padrão '*')"
fi
# DATABASE_URL is optional (defaults to the local SQLite file).
ok "DATABASE_URL configurado (SQLite: $DATABASE_URL)"
# AI (Akame) is optional — mock provider is used when AI_API_KEY is empty.
if [ -n "${AI_API_KEY:-}" ]; then
  ok "AI_API_KEY configurado (provedor real: ${AI_PROVIDER:-mock})"
else
  info "AI_API_KEY ausente — Akame usará o provedor mock (sem chamadas externas)"
fi

if [ "$VALIDATION_ERRORS" -gt 0 ]; then
  err "=============================================================="
  err "  JWT_SECRET não configurado. Configure esta variável no painel"
  err "  da Pterodactyl/Bronxys (Server → Variables):"
  err "    JWT_SECRET -> segredo longo e aleatório para assinar tokens"
  err "                (gere com: openssl rand -hex 32)"
  err "  A porta é obtida automaticamente do ambiente — NÃO precisa"
  err "  configurar PORT manualmente."
  err "  Opcionais: NODE_ENV=production, CORS_ORIGIN, AI_API_KEY/AI_PROVIDER."
  err "  O banco é SQLite local (data/matrix.db) — NÃO precisa de DATABASE_URL."
  err "=============================================================="
  die "Configuração incompleta — defina JWT_SECRET no painel e reinicie."
fi
ok "Todas as variáveis obrigatórias estão configuradas"

# ── 8. Migrations (creates the SQLite DB on first boot) ───────
# `prisma migrate deploy` is non-destructive: it only applies pending
# migrations and NEVER resets/deletes data. On a fresh host it creates
# data/matrix.db with the full schema; on subsequent boots it is a fast
# no-op. The DB file is never deleted or reset by this step.
log "Aplicando migrations (prisma migrate deploy — não destrutivo)"
$PRISMA migrate deploy
ok "Migrations aplicadas"

# SQLite health check: confirm Prisma can actually open the DB. The client
# reads process.env.DATABASE_URL (same as the server), so we do NOT override
# the URL — this guarantees the health check opens the exact same file the
# server will use.
if ! node -e "
  const { PrismaClient } = require('./src/generated');
  const p = new PrismaClient();
  p.\$queryRaw\`SELECT 1 AS ok\`.then(() => { process.stdout.write('[OK] Banco SQLite acessível\n'); return p.\$disconnect(); }).catch((e) => { process.stderr.write('[ERROR] Não foi possível abrir o banco SQLite: ' + e.message + '\n'); process.exit(1); });
" 2>&1; then
  die "Banco SQLite inacessível — verifique permissões em $DATA_DIR/"
fi
ok "Banco SQLite acessível (health check OK)"

# ── 9. Build ──────────────────────────────────────────────────
# Compile TypeScript only when dist is missing OR any source file is newer
# than the compiled entry. Skips the (slow) tsc step on restarts.
needs_build() {
  [ ! -f "$APP_ENTRY" ] && return 0
  while IFS= read -r -d '' src; do
    [ "$src" -nt "$APP_ENTRY" ] && return 0
  done < <(find src -type f -name '*.ts' -not -path 'src/generated/*' -print0 2>/dev/null)
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

# ── 10. Seed (only if empty) ──────────────────────────────────
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

# ── 11. Start server ──────────────────────────────────────────
# `exec` replaces the shell with the Node process so it becomes PID 1 (the
# container's main process) and receives signals for graceful shutdown.
# The [MATRIX] startup banner (ambiente/banco/porta/host) is printed by the
# app itself (dist/src/app.js) so it also appears with `npm run start:server`.
info "Entrypoint: node $APP_ENTRY"
ok "Bootstrap concluído — iniciando servidor"
exec node "$APP_ENTRY"
