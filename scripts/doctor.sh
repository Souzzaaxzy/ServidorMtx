#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — verificação de ambiente ("doctor")
#
# Confere se a máquina cumpre os requisitos e informa exatamente o que falta,
# sem alterar nada. Funciona no Termux/Android e em Linux.
#
# Uso:  npm run doctor   (ou: bash scripts/doctor.sh)
# ──────────────────────────────────────────────────────────────
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
bad()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
hdr()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

PROBLEMS=0
fail() { bad "$1"; PROBLEMS=$((PROBLEMS + 1)); }

echo "═══════════════════════════════════════════════════════════════"
echo "  MATRIX API — verificação de ambiente"
echo "═══════════════════════════════════════════════════════════════"

hdr "Sistema"
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
  ok "Termux/Android detectado (TERMUX_VERSION=${TERMUX_VERSION:-desconhecida})"
  ok "Arquitetura: $(uname -m)"
else
  ok "Linux/Unix ($(uname -s) $(uname -m))"
fi
ok "Diretório do projeto: $(pwd)"

hdr "Node.js e npm"
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"; ok "Node $NODE_V"
  MAJ="$(node -p 'process.versions.node.split(".")[0]')"
  MIN="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$MAJ" -gt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 5 ]; }; then
    ok "node:sqlite disponível (>= 22.5)"
  else
    fail "node:sqlite exige Node >= 22.5 (driver do banco). Atualize o Node."
  fi
  if [ "$MAJ" -gt 24 ] || { [ "$MAJ" -eq 24 ] && [ "$MIN" -ge 7 ]; }; then
    ok "argon2 embutido no node:crypto (>= 24.7) — nenhum módulo nativo necessário"
  else
    warn "Node < 24.7: o hash de senha depende do pacote npm 'argon2' (nativo)."
    warn "Recomendado atualizar o Node (no Termux: pkg install nodejs-lts)."
  fi
else
  fail "Node.js não encontrado no PATH."
fi
command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || fail "npm não encontrado."

hdr "Argon2 (hash de senha)"
if node -e "process.exit(typeof require('node:crypto').argon2Sync === 'function' ? 0 : 1)" 2>/dev/null; then
  ok "Implementação ativa: node:crypto (embutida)"
elif node -e "require('argon2')" 2>/dev/null; then
  ok "Implementação ativa: pacote npm 'argon2'"
else
  fail "Nenhuma implementação de Argon2 — login/cadastro não funcionará."
fi

hdr "Música do perfil (yt-dlp + ffmpeg)"
# Opcional: sem isto a API roda normalmente e só a música do perfil fica
# indisponível (o endpoint responde com mensagem amigável).
YTDLP_FOUND=""
if [ -n "${YT_DLP_PATH:-}" ] && [ -x "${YT_DLP_PATH:-}" ]; then
  YTDLP_FOUND="$YT_DLP_PATH"
elif command -v yt-dlp >/dev/null 2>&1; then
  YTDLP_FOUND="$(command -v yt-dlp)"
elif python3 -m yt_dlp --version >/dev/null 2>&1; then
  YTDLP_FOUND="python3 -m yt_dlp"
fi
if [ -n "$YTDLP_FOUND" ]; then
  ok "yt-dlp: $YTDLP_FOUND"
else
  warn "yt-dlp ausente — música do perfil indisponível (Termux: pip install -U yt-dlp; Debian: pip install yt-dlp)"
fi
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg presente (necessário para cortar o trecho)"
else
  warn "ffmpeg ausente — o download do trecho falha (apt install ffmpeg)"
fi
# Runtime de JavaScript: o YouTube exige um. O yt-dlp só habilita `deno` por
# padrão; no Termux o Node do próprio servidor serve de fallback.
if [ -n "${YT_JS_RUNTIME:-}" ]; then
  ok "YT_JS_RUNTIME configurado (${YT_JS_RUNTIME})"
elif command -v deno >/dev/null 2>&1; then
  ok "Runtime JS: deno (preferido pelo yt-dlp)"
elif command -v node >/dev/null 2>&1; then
  ok "Runtime JS: node ($(command -v node)) — fallback do servidor"
else
  warn "Sem runtime de JavaScript — defina YT_JS_RUNTIME (o Node do servidor serve)"
fi
# Cookies do YouTube: é o que libera o bloqueio anti-bot em IP de servidor.
# Nunca imprimir o valor — só se está configurado.
if [ -n "${YT_COOKIES:-}" ]; then
  ok "YT_COOKIES configurado (bloqueio anti-bot do YouTube liberado)"
elif [ -n "${YT_COOKIES_FILE:-}" ]; then
  if [ -f "${YT_COOKIES_FILE}" ]; then
    ok "YT_COOKIES_FILE configurado (${YT_COOKIES_FILE})"
  else
    warn "YT_COOKIES_FILE aponta para arquivo inexistente (${YT_COOKIES_FILE})"
  fi
else
  warn "Sem cookies do YouTube — se o servidor estiver bloqueado (anti-bot), a busca falha (YT_COOKIES)"
fi

hdr "Dependências e build"
[ -d node_modules ] && ok "node_modules presente" || warn "node_modules ausente (npm install)"
[ -x node_modules/.bin/prisma ] && ok "Prisma CLI instalado" || warn "Prisma CLI ausente (npm install)"
[ -d src/generated ] && ok "Cliente Prisma gerado" || warn "Cliente Prisma ausente (npm run prisma:generate)"
if [ -f dist/src/app.js ]; then ok "Build presente (dist/src/app.js)"; else warn "Build ausente (npm run build)"; fi

hdr "Migrations"
# The Prisma CLI always needs a native schema-engine (no Android build), so on
# Termux we use the node:sqlite runner instead. Report which path applies.
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
  ok "Ambiente Termux → runner node:sqlite (npm run db:migrate)"
  if [ -f dist/src/db/migrate-cli.js ]; then
    ok "Runner compilado presente (dist/src/db/migrate-cli.js)"
  elif [ -x node_modules/.bin/tsx ]; then
    ok "Runner disponível via tsx (src/db/migrate-cli.ts)"
  else
    warn "Runner indisponível — rode 'npm install && npm run build'"
  fi
else
  ok "Ambiente Linux/outro → 'prisma migrate deploy' (fluxo convencional)"
fi
if command -v node >/dev/null 2>&1 && [ -f prisma/migrations/migration_lock.toml ]; then
  COUNT="$(ls -d prisma/migrations/*/ 2>/dev/null | wc -l | tr -d ' ')"
  ok "Migrations no repositório: $COUNT"
fi

hdr "Banco de dados (SQLite)"
DB_FILE="data/matrix.db"
if [ -f "$DB_FILE" ]; then
  ok "Arquivo do banco: $DB_FILE"
  if command -v node >/dev/null 2>&1; then
    TABLES="$(node -e "
      const { DatabaseSync } = require('node:sqlite');
      try {
        const db = new DatabaseSync('$DB_FILE');
        const r = db.prepare(\"SELECT COUNT(*) c FROM sqlite_master WHERE type='table'\").get();
        db.close(); process.stdout.write(String(r.c));
      } catch (e) { process.stdout.write('ERR'); }
    " 2>/dev/null)"
    if [ "$TABLES" = "ERR" ]; then
      fail "Não foi possível abrir o banco com node:sqlite."
    else
      ok "Banco legível: $TABLES tabelas"
    fi
  fi
else
  warn "Banco ainda não existe — será criado na primeira inicialização."
fi

hdr "Variáveis de ambiente"
if [ -n "${JWT_SECRET:-}" ]; then
  ok "JWT_SECRET configurado (process.env)"
elif [ -s data/.jwt_secret ]; then
  ok "JWT_SECRET persistido em data/.jwt_secret (gerado pelo start.sh)"
else
  warn "JWT_SECRET ausente — o start.sh gera um segredo persistente no 1º boot."
fi
ok "PORT = ${PORT:-${SERVER_PORT:-3000 (padrão)}}"
[ -n "${DATABASE_URL:-}" ] && ok "DATABASE_URL = $DATABASE_URL" || ok "DATABASE_URL = padrão (file:<cwd>/data/matrix.db)"

echo
if [ "$PROBLEMS" -eq 0 ]; then
  printf '\033[1;32m  Tudo pronto — nenhum problema encontrado.\033[0m\n'
  exit 0
fi
printf '\033[1;31m  %d problema(s) encontrado(s) — veja acima.\033[0m\n' "$PROBLEMS"
exit 1
