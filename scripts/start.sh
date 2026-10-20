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

# ── Prisma helpers (Termux-safe generate/migrate) ──────────────
# Sourced unconditionally: it defines matrix_is_termux / matrix_prisma_generate
# / matrix_migrate, used by the generate and migration steps below.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-prisma.sh
. "$SCRIPT_DIR/lib-prisma.sh"

# Media helpers: baixam yt-dlp/ffmpeg como binários ESTÁTICOS quando o host
# não tem gerenciador de pacotes (container Pterodactyl/Bronxys). Sem isto a
# música do perfil fica indisponível em container — não há root nem pip.
# shellcheck source=./lib-media.sh
. "$SCRIPT_DIR/lib-media.sh"

# ── Environment detection (Termux/Android vs regular Linux) ────
# The API now runs on EITHER without native Prisma binaries: the client uses
# the Rust-free engine (engineType=client) plus the node:sqlite adapter, so
# Android/bionic no longer blocks startup. We only report the environment here.
IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
  IS_TERMUX=1
fi

# node:sqlite requires Node >= 22.5 (stable from 23.4/22.13); argon2 is built
# into node:crypto from Node >= 24.7. On older Node the npm `argon2` package is
# used instead, so the API still works — but on Termux there is no prebuilt
# bionic binary, hence the hard requirement there.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
node_has_sqlite() { [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; }; }
node_has_argon2() { [ "$NODE_MAJOR" -gt 24 ] || { [ "$NODE_MAJOR" -eq 24 ] && [ "$NODE_MINOR" -ge 7 ]; }; }

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
if [ "$IS_TERMUX" -eq 1 ]; then
  echo "  Ambiente       : Termux/Android ($(uname -m))"
else
  echo "  Ambiente       : Linux ($(uname -m))"
fi
echo "  Prisma engine  : cliente JS/WASM (engineType=client) — sem binário nativo ✓"
echo "  SQLite driver  : node:sqlite (embutido no Node) $([ "$(node_has_sqlite && echo 1 || echo 0)" = 1 ] && echo '✓' || echo '✗ Node >= 22.5 necessário')"
if [ "$(node_has_argon2 && echo 1 || echo 0)" = 1 ]; then
  echo "  Hash de senha  : argon2 embutido (node:crypto) ✓"
else
  echo "  Hash de senha  : pacote npm 'argon2' (Node < 24.7)"
fi
[ -f package.json ] || die "package.json ausente — não é a raiz do projeto."

# node:sqlite is required: it is the driver adapter's backend. Fail early with
# an actionable message instead of a confusing module error later.
if ! node_has_sqlite; then
  err "Este projeto requer Node >= 22.5 (o driver usa o módulo embutido node:sqlite)."
  err "Node detectado: $(node --version 2>/dev/null || echo 'ausente')"
  err "No Termux: pkg install nodejs-lts  (ou atualize o Node para >= 24.7 e"
  err "ganhe também o argon2 embutido, sem precisar compilar nada)."
  die "Node incompatível."
fi

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
  [ -d node_modules/typescript ] || return 0
  # The npm argon2 package is OPTIONAL now (the built-in node:crypto argon2 is
  # preferred), so its absence is not treated as an incomplete install.
  return 1
}
if needs_install; then
  log "node_modules ausente/incompleto — instalando dependências (npm install)"
  # --include=dev guarantees devDependencies (tsc, typescript, prisma CLI)
  # are installed even when the panel sets NODE_ENV=production (which would
  # otherwise skip them and break the build step below). This is NOT --force
  # nor --legacy-peer-deps; it only controls dev/prod inclusion.
  # `|| npm install --omit=optional` tolerates hosts (Termux) where the
  # optional native argon2 cannot build — it is not needed there.
  npm install --include=dev || npm install --include=dev --omit=optional
  ok "Dependências instaladas (incluindo devDependencies para build)"
else
  ok "Dependências já instaladas (npm install ignorado)"
fi

# Verify that SOME Argon2 implementation is available: the built-in
# node:crypto.argon2 (Node >= 24.7) or the npm `argon2` package. Both produce
# and verify the same PHC hashes, so existing passwords keep working.
argon2_source=""
if node -e "process.exit(typeof require('node:crypto').argon2Sync === 'function' ? 0 : 1)" 2>/dev/null; then
  argon2_source="node:crypto (embutido)"
elif node -e "require('argon2')" 2>/dev/null; then
  argon2_source="pacote npm 'argon2'"
else
  err "Nenhuma implementação de Argon2 disponível — o hash de senhas não funciona."
  if [ "$IS_TERMUX" -eq 1 ]; then
    err "No Termux use Node >= 24.7 (o argon2 vem embutido no node:crypto):"
    err "  pkg install nodejs-lts   # ou 'pkg install nodejs' se já for >= 24.7"
  else
    err "Instale o Node >= 24.7 (argon2 embutido) ou libere o build do pacote"
    err "'argon2' no npm (requer python3/make/g++)."
  fi
  die "Argon2 é obrigatório (hashing de senhas) — não pode ser substituído."
fi
ok "Argon2 disponível ($argon2_source)"

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

# ── 4b. yt-dlp + ffmpeg (música do perfil) ─────────────────────
# OPCIONAL: sem eles a API sobe normal e só a música do perfil responde com
# mensagem amigável. Em container (Pterodactyl/Bronxys) NÃO há root, `apt`
# nem `pip` utilizável — por isso o plano B é baixar os binários ESTÁTICOS
# oficiais (SHA-256 conferido) para data/bin. Roda ANTES de subir o servidor
# para o Node já encontrá-los.
matrix_ensure_media_tools() {
  export PATH="$MATRIX_MEDIA_BIN_DIR:$PATH"
  if [ -z "${YT_DLP_PATH:-}" ] && [ -x "$MATRIX_MEDIA_BIN_DIR/yt-dlp" ]; then
    export YT_DLP_PATH="$MATRIX_MEDIA_BIN_DIR/yt-dlp"
  fi
  if [ -z "${FFMPEG_PATH:-}" ] && [ -x "$MATRIX_MEDIA_BIN_DIR/ffmpeg" ]; then
    export FFMPEG_PATH="$MATRIX_MEDIA_BIN_DIR/ffmpeg"
  fi

  local need_ytdlp=1 need_ffmpeg=1
  [ -n "${YT_DLP_PATH:-}" ] && [ -x "${YT_DLP_PATH:-}" ] && need_ytdlp=0
  [ "$need_ytdlp" = 1 ] && command -v yt-dlp >/dev/null 2>&1 && need_ytdlp=0
  [ "$need_ytdlp" = 1 ] && python3 -m yt_dlp --version >/dev/null 2>&1 && need_ytdlp=0
  command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1 && need_ffmpeg=0

  if [ "$need_ytdlp" = 0 ] && [ "$need_ffmpeg" = 0 ]; then
    ok "Música do perfil: yt-dlp e ffmpeg disponíveis"
    return 0
  fi

  # 1) Gerenciador de pacotes, quando houver (root).
  if [ "$need_ytdlp" = 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      (apt-get install -y ffmpeg >/dev/null 2>&1 \
        || sudo apt-get install -y ffmpeg >/dev/null 2>&1) || true
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache ffmpeg >/dev/null 2>&1 || true
    fi
    (python3 -m pip install -U --break-system-packages yt-dlp >/dev/null 2>&1 \
      || python3 -m pip install -U yt-dlp >/dev/null 2>&1 \
      || pip install -U --break-system-packages yt-dlp >/dev/null 2>&1) || true
  fi
  command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1 && need_ffmpeg=0
  if [ -n "${YT_DLP_PATH:-}" ] && [ -x "${YT_DLP_PATH:-}" ]; then
    need_ytdlp=0
  elif command -v yt-dlp >/dev/null 2>&1 || python3 -m yt_dlp --version >/dev/null 2>&1; then
    need_ytdlp=0
  fi

  # 2) Plano B: BINÁRIOS ESTÁTICOS (sem root, sem Python).
  if [ "$need_ytdlp" = 1 ]; then
    log "Baixando yt-dlp estático (sem gerenciador de pacotes)"
    matrix_fetch_ytdlp || true
    [ -x "$MATRIX_MEDIA_BIN_DIR/yt-dlp" ] && export YT_DLP_PATH="$MATRIX_MEDIA_BIN_DIR/yt-dlp"
  fi
  if [ "$need_ffmpeg" = 1 ]; then
    matrix_fetch_ffmpeg || true
    [ -x "$MATRIX_MEDIA_BIN_DIR/ffmpeg" ] && export FFMPEG_PATH="$MATRIX_MEDIA_BIN_DIR/ffmpeg"
  fi

  if [ -x "$MATRIX_MEDIA_BIN_DIR/yt-dlp" ] \
    || command -v yt-dlp >/dev/null 2>&1 \
    || python3 -m yt_dlp --version >/dev/null 2>&1; then
    if [ -x "$MATRIX_MEDIA_BIN_DIR/ffmpeg" ] \
      || { command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1; }; then
      ok "Música do perfil: yt-dlp + ffmpeg prontos"
    else
      ok "Música do perfil: yt-dlp pronto (sem ffmpeg — o app toca a janela do trecho)"
    fi
  else
    warn "Música do perfil indisponível: yt-dlp ausente (rode: npm run doctor)"
  fi
}
matrix_ensure_media_tools

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
  matrix_prisma_generate "$PRISMA" .
  ok "Cliente Prisma gerado"
else
  ok "Cliente Prisma já gerado e atualizado (generate ignorado)"
fi

# ── 7. Validação de variáveis obrigatórias ─────────────────────
# JWT_SECRET is the ONLY hard requirement (it signs auth tokens). Priority:
#   1. process.env (panel Variables or .env) — always wins;
#   2. a secret PERSISTED at data/.jwt_secret (auto-generated ONCE on the
#      first boot, chmod 600, gitignored — reused on every restart so
#      existing tokens are never invalidated);
#   3. clear error pointing to the panel (only if 1 and 2 are impossible,
#      e.g. data/ is not writable — extremely unlikely).
# Secrets are NEVER printed — only "configurado"/"gerado". The port is
# NEVER validated here: it always resolves from PORT / SERVER_PORT / 3000
# above, so the user does not need to configure it manually. DATABASE_URL
# is NOT required (SQLite local).
log "Validando variáveis de ambiente obrigatórias"
VALIDATION_ERRORS=0
JWT_SECRET_FILE="$DATA_DIR/.jwt_secret"
if [ -n "${JWT_SECRET:-}" ]; then
  ok "JWT_SECRET configurado (painel/.env)"
elif [ -f "$JWT_SECRET_FILE" ] && [ -s "$JWT_SECRET_FILE" ]; then
  JWT_SECRET="$(cat "$JWT_SECRET_FILE")"
  export JWT_SECRET
  ok "JWT_SECRET carregado de $JWT_SECRET_FILE (persistente)"
elif SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' 2>/dev/null)" \
  && [ -n "$SECRET" ] \
  && (umask 177; printf '%s' "$SECRET" > "$JWT_SECRET_FILE" 2>/dev/null); then
  JWT_SECRET="$SECRET"
  export JWT_SECRET
  ok "JWT_SECRET gerado e salvo em $JWT_SECRET_FILE (persistente, chmod 600)"
  unset SECRET
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
  err "  JWT_SECRET não configurado e não foi possível gerar um segredo"
  err "  persistente em $JWT_SECRET_FILE (diretório data/ sem escrita?)."
  err "  Configure JWT_SECRET no painel da Pterodactyl/Bronxys"
  err "  (Server → Variables) com uma string longa e aleatória"
  err "  (gere com: openssl rand -hex 32)."
  err "  A porta é obtida automaticamente do ambiente — NÃO precisa"
  err "  configurar PORT manualmente."
  err "  Opcionais: NODE_ENV=production, CORS_ORIGIN, AI_API_KEY/AI_PROVIDER."
  err "  O banco é SQLite local (data/matrix.db) — NÃO precisa de DATABASE_URL."
  err "=============================================================="
  die "Configuração incompleta — defina JWT_SECRET no painel e reinicie."
fi
ok "Todas as variáveis obrigatórias estão configuradas"

# ── 8. Migrations (creates the SQLite DB on first boot) ───────
# Non-destructive: only pending migrations are applied, and the DB is NEVER
# reset/deleted. On a fresh host it creates data/matrix.db with the full
# schema; on later boots it is a fast no-op.
# Termux/Android → offline node:sqlite runner (the Prisma CLI cannot run its
# native schema engine there). Other systems → `prisma migrate deploy`.
if matrix_is_termux; then
  log "Aplicando migrations (runner node:sqlite — Termux, sem schema engine)"
else
  log "Aplicando migrations (prisma migrate deploy — não destrutivo)"
fi
matrix_migrate "$PRISMA" .
ok "Migrations aplicadas"

# SQLite health check: open the EXACT file the server will use and read it.
# Uses node:sqlite directly (the same driver the adapter uses), so this does
# not depend on the generated client or any native binary.
if ! node -e "
  const { DatabaseSync } = require('node:sqlite');
  const url = process.env.DATABASE_URL || 'file:$(pwd)/$DB_FILE';
  const db = new DatabaseSync(url.replace(/^file:/, ''));
  const row = db.prepare('SELECT COUNT(*) AS c FROM sqlite_master WHERE type = ?').get('table');
  db.close();
  process.stdout.write('[OK] Banco SQLite acessível (' + row.c + ' tabelas)\n');
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
