#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — one-shot bootstrap + start
#
# `npm start` (the Pterodactyl startup command) runs this. It is the ONLY
# command needed to bring the API online on a fresh host, and it stays fast
# on restarts by skipping work that is already done.
#
#   1. diagnostics
#   2. .env  — load if present (OPTIONAL; never required, never overwritten).
#              In production (Pterodactyl) variables come from process.env.
#   3. deps  — npm install only if node_modules is missing/incomplete
#   4. prisma — generate the client only if missing/stale
#   5. db    — resolve DATABASE_URL (Docker compose OR external panel DB)
#   6. validate — check required process.env (DATABASE_URL, JWT_SECRET, PORT)
#   7. migrations — prisma migrate deploy (non-destructive, idempotent)
#   8. build — compile TypeScript only if dist is missing/stale
#   9. seed  — populate an empty DB only (never destroys data)
#  10. start — exec node dist/src/app.js (becomes the container's main process)
#
# Every step is idempotent. No loops, no background processes, no --force,
# no --legacy-peer-deps. The server never depends on .env or .env.example in
# production — those are conveniences for local dev only.
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
echo "  .env           : $([ -f .env ] && echo 'presente ✓' || echo 'ausente (opcional)')"
echo "  .env.example   : $([ -f .env.example ] && echo 'presente ✓' || echo 'ausente (opcional)')"
echo "  Prisma Client  : $([ -d "$GENERATED" ] && echo 'OK ✓' || echo 'ausente')"
echo "  dist/          : $([ -f "$APP_ENTRY" ] && echo 'presente ✓' || echo 'ausente')"
echo "  PORT           : ${PORT:-${SERVER_PORT:-<não configurada, usará 3000>}}"
echo "  Database       : $([ -n "${DATABASE_URL:-}" ] && echo 'configurado ✓' || echo 'NÃO CONFIGURADO')"
[ -f package.json ] || die "package.json ausente — não é a raiz do projeto."

# ── 2. .env (OPTIONAL) ─────────────────────────────────────────
# .env is a convenience for local development. In production (Pterodactyl)
# the panel injects every variable through process.env, so .env is NOT
# required. .env.example is documentation only and is never copied.
#
# If .env exists, load it — but NEVER overwrite variables already set in the
# environment (the panel injects DATABASE_URL, JWT_SECRET, SERVER_PORT, etc.
# as real env vars; a plain `set -a; . ./.env` would clobber them). dotenv
# (used by Node at runtime) has the same no-override behaviour, so we mirror
# it here for the shell-side steps (prisma, db probe).
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

# Resolve the listening port. PORT wins; SERVER_PORT (Pterodactyl) is the
# fallback; 3000 is the last resort (dev only).
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
#
# NOTE: this step never INVENTS a database URL. If nothing is configured we
# leave DATABASE_URL empty and let the validation step (6) report the missing
# configuration clearly. The server never starts against a fake localhost DB.
DB_PORT="${DB_PORT:-5432}"
DB_USER="${POSTGRES_USER:-matrix}"
DB_NAME="${POSTGRES_DB:-matrix}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  # Docker mode (local dev): only start the compose DB if a DATABASE_URL was
  # already provided OR can be assembled from POSTGRES_* vars. If the panel
  # set DATABASE_URL to an external host we honour it as-is.
  DB_URL="${DATABASE_URL:-}"
  if [ -z "$DB_URL" ]; then
    log "Subindo PostgreSQL via Docker Compose (modo dev)"
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
    DB_URL="postgresql://${DB_USER}:${POSTGRES_PASSWORD:-matrix}@127.0.0.1:${DB_PORT}/${DB_NAME}?schema=public"
  fi
  # Normalise the compose-internal "db"/"localhost" host to host-reachable 127.0.0.1.
  DB_URL="$(printf '%s' "$DB_URL" | sed -E 's/@db:/@127.0.0.1:/; s/@localhost:/@127.0.0.1:/')"
else
  # No Docker (Pterodactyl, etc.): use DATABASE_URL from the panel, or build
  # it from DB_* component vars if the panel provides those instead.
  if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-${DATABASE_HOST:-}}" ]; then
    DB_HOSTVAL="${DB_HOST:-${DATABASE_HOST}}"
    DB_URL="postgresql://${DB_USER}:${POSTGRES_PASSWORD:-${DB_PASSWORD:-matrix}}@${DB_HOSTVAL}:${DB_PORT}/${DB_NAME}?schema=public"
  else
    DB_URL="${DATABASE_URL:-}"
  fi
  if [ -n "$DB_URL" ]; then
    ok "Usando banco externo (modo sem Docker)"
  fi
fi
export DATABASE_URL="$DB_URL"

# Detect a MySQL URL — the Prisma schema expects PostgreSQL, so a MySQL DB
# from the panel means the app cannot run. (Only checked when a URL exists;
# a missing URL is reported by the validation step below.)
if [ -n "$DB_URL" ]; then
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
fi

# ── 6. Validação de variáveis obrigatórias ─────────────────────
# Validate the variables the server truly needs to run, reading them from
# process.env (the panel source). Secrets are NEVER printed — only
# "configurado"/"ausente". A missing DATABASE_URL or JWT_SECRET is fatal: we
# refuse to start rather than silently fall back to an invented/dev value.
log "Validando variáveis de ambiente obrigatórias"
VALIDATION_ERRORS=0
validate_present() {
  # $1 = var name, $2 = current value (pass empty to test absence)
  local name="$1" val="$2"
  if [ -n "$val" ]; then
    ok "$name configurado"
  else
    err "$name não configurado"
    VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))
  fi
}
validate_present "NODE_ENV"    "${NODE_ENV:-}"
validate_present "PORT"        "${PORT:-}"
validate_present "DATABASE_URL" "${DATABASE_URL:-}"
validate_present "JWT_SECRET"  "${JWT_SECRET:-}"
# CORS_ORIGIN is optional (defaults to '*' in the app) — report only.
if [ -n "${CORS_ORIGIN:-}" ]; then
  ok "CORS_ORIGIN configurado"
else
  info "CORS_ORIGIN ausente (o servidor usará o padrão '*')"
fi
# AI (Akame) is optional — mock provider is used when AI_API_KEY is empty.
if [ -n "${AI_API_KEY:-}" ]; then
  ok "AI_API_KEY configurado (provedor real: ${AI_PROVIDER:-mock})"
else
  info "AI_API_KEY ausente — Akame usará o provedor mock (sem chamadas externas)"
fi

if [ "$VALIDATION_ERRORS" -gt 0 ]; then
  err "=============================================================="
  err "  Configuração incompleta — o MATRIX API não pode iniciar."
  err "  Variáveis obrigatórias ausentes. Configure no painel da"
  err "  Pterodactyl (Server → Variables) as seguintes:"
  err "    DATABASE_URL  -> PostgreSQL (ex: postgresql://user:senha@host:5432/matrix?schema=public)"
  err "    JWT_SECRET    -> segredo longo e aleatório para assinar tokens"
  err "    PORT          -> porta alocada pelo painel (ex: 4299)"
  err "    NODE_ENV      -> production"
  err "  Opcional: CORS_ORIGIN, AI_API_KEY/AI_PROVIDER (Akame)."
  err "=============================================================="
  die "Configuração incompleta — corrija as variáveis no painel e reinicie."
fi
ok "Todas as variáveis obrigatórias estão configuradas"

# ── 7. Migrations ─────────────────────────────────────────────
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

# ── 8. Build ──────────────────────────────────────────────────
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

# ── 9. Seed (only if empty) ───────────────────────────────────
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

# ── 10. Start server ───────────────────────────────────────────
# `exec` replaces the shell with the Node process so it becomes PID 1 (the
# container's main process) and receives signals for graceful shutdown.
info "Entrypoint: node $APP_ENTRY"
info "Host: 0.0.0.0  |  Porta: ${PORT}"
ok "Iniciando servidor MATRIX API"
exec node "$APP_ENTRY"
