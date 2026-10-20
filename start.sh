#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — script de START tudo-em-um (Hostsquare / Pterodactyl / VPS)
#
# É o ÚNICO comando necessário para colocar a API online em uma máquina
# nova: instala TODAS as dependências, gera o cliente Prisma, compila o
# TypeScript, cria/migra o banco SQLite, popula se estiver vazio e sobe o
# servidor. Nas reinicializações ele pula o que já está pronto (rápido).
#
# Uso na Hostsquare:
#   • Start Command :  bash start.sh
#   • (se o painel pedir) rode uma vez: bash start.sh --install
#
# Flags:
#   --install   só instala/compila e sai (sem subir o servidor)
#   --help      mostra esta ajuda
#
# Passos (todos idempotentes):
#   1. diagnóstico    2. .env (opcional)   3. dependências (npm install)
#   4. data/ + uploads/   5. DATABASE_URL (SQLite)   6. prisma generate
#   7. validação (JWT_SECRET)   8. migrate deploy   9. build
#  10. seed (só se vazio)    11. exec node dist/src/app.js
#
# Sem Docker, sem PostgreSQL/psql, sem banco externo. O arquivo SQLite
# data/matrix.db NUNCA é apagado/resetado por este script.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Sempre operar da raiz do projeto (o script pode ser chamado de qualquer lugar).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Logging ───────────────────────────────────────────────────
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

# Prisma helpers (Termux-safe generate/migrate) — see scripts/lib-prisma.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/lib-prisma.sh"

# Media helpers: baixam yt-dlp/ffmpeg como binários ESTÁTICOS quando o host
# não tem gerenciador de pacotes (container Pterodactyl/Bronxys).
# Veja scripts/lib-media.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/lib-media.sh"

INSTALL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL_ONLY=1 ;;
    --help|-h)
      grep '^#' "$0" | sed -n '2,30p' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "Argumento desconhecido ignorado: $arg" ;;
  esac
done

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
echo "  Prisma Client  : $([ -d "$GENERATED" ] && echo 'OK ✓' || echo 'ausente')"
echo "  dist/          : $([ -f "$APP_ENTRY" ] && echo 'presente ✓' || echo 'ausente')"
echo "  PORT           : ${PORT:-${SERVER_PORT:-<não configurada, usará 3000>}}"
echo "  Database       : SQLite ($DB_FILE)"
echo "  Database file  : $([ -f "$DB_FILE" ] && echo 'presente ✓' || echo 'será criado na 1ª inicialização')"
echo "  JWT_SECRET     : $([ -n "${JWT_SECRET:-}" ] && echo 'configurado ✓' || echo 'NÃO CONFIGURADO (será gerado)')"
# YT_COOKIES: mostra só o ESTADO (o valor é credencial). É a primeira coisa a
# conferir quando o YouTube bloqueia por anti-bot. O arquivo drop-in
# data/cookies.txt é o caminho mais simples: basta copiar o cookies.txt
# exportado do navegador para a pasta data/ (sem variável nenhuma).
if [ -n "${YT_COOKIES:-}" ]; then
  echo "  YT_COOKIES     : presente ✓ (valor não é exibido)"
elif [ -n "${YT_COOKIES_FILE:-}" ]; then
  echo "  YT_COOKIES     : via arquivo (${YT_COOKIES_FILE})"
elif [ -f "$DATA_DIR/cookies.txt" ]; then
  if head -c 200 "$DATA_DIR/cookies.txt" 2>/dev/null | grep -qE '^# *(Netscape|HTTP Cookie File)'; then
    echo "  YT_COOKIES     : $DATA_DIR/cookies.txt encontrado ✓"
  else
    echo "  YT_COOKIES     : $DATA_DIR/cookies.txt existe mas NÃO é um cookies.txt do Netscape ✗"
  fi
else
  echo "  YT_COOKIES     : ausente (o YouTube pode bloquear por anti-bot)"
  echo "                   dica: copie o cookies.txt exportado do navegador para $DATA_DIR/"
fi
echo "  NODE_ENV       : ${NODE_ENV:-<vazio>}"
echo "═══════════════════════════════════════════════════════════════"

# Node/npm são pré-requisitos do runtime — a Hostsquare fornece o Node na imagem.
command -v node >/dev/null 2>&1 || die "node não encontrado no PATH — use uma imagem Node.js (>=20)."
command -v npm  >/dev/null 2>&1 || die "npm não encontrado no PATH."
[ -f package.json ] || die "package.json ausente — rode este script na raiz do projeto."

# ── 2. .env (OPCIONAL) ─────────────────────────────────────────
# Em produção as variáveis vêm do painel (process.env). Se existir um .env
# local, ele é carregado SEM sobrescrever o que o painel já injetou.
load_env_no_override() {
  local key val
  while IFS='=' read -r key val || [ -n "$key" ]; do
    case "$key" in ''|\#*) continue ;; esac
    key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    [ -z "${!key+x}" ] && export "$key=$val"
  done < .env
}
if [ -f .env ]; then
  load_env_no_override
  ok ".env presente (carregado; variáveis do painel não sobrescritas)"
else
  ok ".env ausente — usando process.env do painel"
fi

# Porta: PORT tem prioridade absoluta; SERVER_PORT (painéis tipo Pterodactyl)
# é o fallback; 3000 só em desenvolvimento local.
export PORT="${PORT:-${SERVER_PORT:-3000}}"

# ══════════════════════════════════════════════════════════════
# 3. DEPENDÊNCIAS (npm install)
# ══════════════════════════════════════════════════════════════
# Instala só quando falta node_modules OU algum binário/pacote crítico
# (instalação incompleta ou feita só com deps de produção). --include=dev
# garante tsc/typescript/prisma mesmo com NODE_ENV=production no painel.
needs_install() {
  [ ! -d node_modules ] && return 0
  for bin in node_modules/.bin/prisma node_modules/.bin/tsc; do
    [ -e "$bin" ] || return 0
  done
  [ -d node_modules/typescript ] || return 0
  return 1
}
if needs_install; then
  log "Instalando dependências (npm install --include=dev)"
  # Usa o lockfile quando possível (build reprodutível); cai para install se
  # o lockfile estiver fora de sincronia. O --omit=optional de fallback cobre
  # hosts (Termux/Android) onde o argon2 nativo opcional não compila.
  npm ci --include=dev || npm install --include=dev || npm install --include=dev --omit=optional
  ok "Dependências instaladas"
else
  ok "Dependências já instaladas (npm install ignorado)"
fi

# Argon2: o embutido no node:crypto (Node >= 24.7) dispensa módulo nativo; em
# Node mais antigo usa-se o pacote npm 'argon2'. Ambos geram/validam o mesmo
# hash PHC, então as senhas existentes continuam válidas.
if node -e "process.exit(typeof require('node:crypto').argon2Sync === 'function' ? 0 : 1)" 2>/dev/null; then
  ok "Argon2 embutido disponível (node:crypto)"
elif node -e "require('argon2')" 2>/dev/null; then
  ok "Argon2 do pacote npm disponível"
else
  die "Nenhuma implementação de Argon2 — use Node >= 24.7 ou libere o build do pacote 'argon2'."
fi

# O driver do banco é o módulo embutido node:sqlite (Node >= 22.5).
if ! node -e "require('node:sqlite')" 2>/dev/null; then
  die "node:sqlite indisponível — é necessário Node >= 22.5."
fi
ok "Driver node:sqlite disponível (sem binário nativo)"

# ── 3b. yt-dlp + ffmpeg (música do perfil) ─────────────────────
# OPCIONAL: sem eles a API sobe normalmente e só a música do perfil responde
# com uma mensagem amigável. Instalamos aqui porque é o boot que roda de
# verdade — deixar isso só no instalador do Termux significa que quem só faz
# `git pull && start.sh` nunca recebe as ferramentas.
#
# IMPORTANTE (Termux): o yt-dlp NÃO é pacote do `pkg`; a forma correta é
# `pip install -U yt-dlp` (o `pkg install yt-dlp` falha). O ffmpeg, esse sim,
# vem do `pkg`.
ensure_media_tools() {
  local need_ytdlp=1 need_ffmpeg=1

  # Binários baixados pelo próprio projeto (data/bin) têm prioridade: em
  # container não há como instalar por gerenciador de pacotes, e o download
  # estático é o único caminho.
  export PATH="$MATRIX_MEDIA_BIN_DIR:$PATH"
  if [ -z "${YT_DLP_PATH:-}" ] && [ -x "$MATRIX_MEDIA_BIN_DIR/yt-dlp" ]; then
    export YT_DLP_PATH="$MATRIX_MEDIA_BIN_DIR/yt-dlp"
  fi
  if [ -z "${FFMPEG_PATH:-}" ] && [ -x "$MATRIX_MEDIA_BIN_DIR/ffmpeg" ]; then
    export FFMPEG_PATH="$MATRIX_MEDIA_BIN_DIR/ffmpeg"
  fi

  if [ -n "${YT_DLP_PATH:-}" ] && [ -x "${YT_DLP_PATH:-}" ]; then
    need_ytdlp=0
  elif command -v yt-dlp >/dev/null 2>&1; then
    need_ytdlp=0
  elif python3 -m yt_dlp --version >/dev/null 2>&1; then
    need_ytdlp=0
  fi
  command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1 && need_ffmpeg=0

  [ "$need_ytdlp" = 0 ] && [ "$need_ffmpeg" = 0 ] && {
    ok "Música do perfil: yt-dlp e ffmpeg disponíveis"
    return 0
  }

  # ── 1) Caminho preferido: gerenciador de pacotes do host ────
  # Funciona quando há root (Termux/pkg, Debian/apt, Alpine/apk). Em
  # container Pterodactyl não há root nem esses gerenciadores — cai no
  # download estático abaixo.
  if matrix_is_termux; then
    if [ "$need_ffmpeg" = 1 ]; then
      log "Instalando ffmpeg (pkg install ffmpeg) — pode demorar"
      pkg install -y ffmpeg >/dev/null 2>&1 \
        || warn "ffmpeg não instalado pelo pkg — tentando binário estático"
    fi
    if [ "$need_ytdlp" = 1 ]; then
      log "Instalando yt-dlp (pip install -U yt-dlp)"
      # --break-system-packages: o Python do Termux é gerenciado pelo pkg e o
      # pip recusa instalar sem essa flag em ambientes "externally managed".
      python3 -m pip install -U --break-system-packages yt-dlp >/dev/null 2>&1 \
        || python3 -m pip install -U yt-dlp >/dev/null 2>&1 \
        || pip install -U --break-system-packages yt-dlp >/dev/null 2>&1 \
        || pip install -U yt-dlp >/dev/null 2>&1 \
        || warn "yt-dlp não instalado pelo pip — tentando binário estático"
    fi
  else
    if [ "$need_ffmpeg" = 1 ]; then
      if command -v apt-get >/dev/null 2>&1; then
        log "Instalando ffmpeg (apt-get)"
        (apt-get install -y ffmpeg >/dev/null 2>&1 \
          || sudo apt-get install -y ffmpeg >/dev/null 2>&1) \
          || warn "ffmpeg não instalado pelo apt — tentando binário estático"
      elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache ffmpeg >/dev/null 2>&1 \
          || warn "ffmpeg não instalado pelo apk — tentando binário estático"
      else
        log "Sem gerenciador de pacotes — baixando binários estáticos"
      fi
    fi
    if [ "$need_ytdlp" = 1 ]; then
      log "Instalando yt-dlp (pip)"
      (python3 -m pip install -U --break-system-packages yt-dlp >/dev/null 2>&1 \
        || python3 -m pip install -U yt-dlp >/dev/null 2>&1 \
        || pip install -U --break-system-packages yt-dlp >/dev/null 2>&1 \
        || pip install -U yt-dlp >/dev/null 2>&1 \
        || pip3 install -U yt-dlp >/dev/null 2>&1) \
        || warn "yt-dlp não instalado pelo pip — tentando binário estático"
    fi
  fi

  # ── 2) Plano B: BINÁRIOS ESTÁTICOS (sem root, sem Python) ────
  # Reconfere o estado: os gerenciadores acima podem ter funcionado.
  need_ytdlp=1; need_ffmpeg=1
  if [ -n "${YT_DLP_PATH:-}" ] && [ -x "${YT_DLP_PATH:-}" ]; then
    need_ytdlp=0
  elif command -v yt-dlp >/dev/null 2>&1; then
    need_ytdlp=0
  elif python3 -m yt_dlp --version >/dev/null 2>&1; then
    need_ytdlp=0
  fi
  command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1 && need_ffmpeg=0

  if [ "$need_ytdlp" = 1 ]; then
    # O yt-dlp é OBRIGATÓRIO para o recurso existir.
    if command -v matrix_fetch_ytdlp >/dev/null 2>&1; then
      matrix_fetch_ytdlp || true
      [ -x "$MATRIX_MEDIA_BIN_DIR/yt-dlp" ] && export YT_DLP_PATH="$MATRIX_MEDIA_BIN_DIR/yt-dlp"
    fi
  fi
  if [ "$need_ffmpeg" = 1 ]; then
    # O ffmpeg é OPCIONAL (sem ele o app toca a janela do trecho).
    if command -v matrix_fetch_ffmpeg >/dev/null 2>&1; then
      matrix_fetch_ffmpeg || true
      [ -x "$MATRIX_MEDIA_BIN_DIR/ffmpeg" ] && export FFMPEG_PATH="$MATRIX_MEDIA_BIN_DIR/ffmpeg"
    fi
  fi

  # Confere o resultado REAL (a instalação pode falhar silenciosamente).
  # O yt-dlp é OBRIGATÓRIO; o ffmpeg é OPCIONAL (sem ele o app toca a janela).
  if command -v yt-dlp >/dev/null 2>&1 || python3 -m yt_dlp --version >/dev/null 2>&1; then
    if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1; then
      ok "Música do perfil: yt-dlp + ffmpeg prontos"
    else
      ok "Música do perfil: yt-dlp pronto (sem ffmpeg — o app toca a janela do trecho)"
    fi
  else
    warn "Música do perfil indisponível: yt-dlp ausente (rode: npm run doctor)"
  fi
}
ensure_media_tools

# ── 4. Diretórios persistentes ─────────────────────────────────
mkdir -p "$DATA_DIR" uploads
ok "Diretórios prontos: $DATA_DIR/ e uploads/"
[ -f "$DB_FILE" ] && ok "Banco existente detectado: $DB_FILE (dados preservados)"

# ── 4b. Cookies do YouTube (drop-in, opcional) ─────────────────
# Um cookie jar é CREDENCIAL: ele autentica uma sessão logada. Se o operador
# copiou data/cookies.txt, restringimos a permissão (chmod 600) para que o
# arquivo não fique legível por outros usuários do host. Nunca apagamos o
# arquivo — ele é a configuração do operador.
if [ -f "$DATA_DIR/cookies.txt" ]; then
  chmod 600 "$DATA_DIR/cookies.txt" 2>/dev/null || true
  # Salvaguarda: se o chmod deixou o arquivo ilegível para ESTE processo (dono
  # diferente — ex.: copiado como root num host onde o servidor roda como
  # outro usuário), devolvemos a leitura. Melhor um cookie legível do que a
  # busca de música quebrada por causa da permissão.
  if ! head -c 1 "$DATA_DIR/cookies.txt" >/dev/null 2>&1; then
    chmod 644 "$DATA_DIR/cookies.txt" 2>/dev/null || true
    warn "Não foi possível restringir $DATA_DIR/cookies.txt (dono diferente) — permissão mantida"
  else
    ok "Cookies do YouTube: $DATA_DIR/cookies.txt (permissão restrita a 600)"
  fi
fi

# ── 5. DATABASE_URL (SQLite, caminho absoluto) ─────────────────
# Caminho absoluto remove a ambiguidade de resolução do `file:` entre o CLI
# (prisma/), o cliente dev (src/generated) e o compilado (dist/src/generated).
export DATABASE_URL="${DATABASE_URL:-file:$(pwd)/$DB_FILE}"
info "DATABASE_URL = $DATABASE_URL"

# ── 6. Cliente Prisma ──────────────────────────────────────────
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
  ok "Cliente Prisma atualizado (generate ignorado)"
fi

# ── 7. JWT_SECRET (única variável obrigatória) ─────────────────
# Ordem: process.env (painel/.env) → data/.jwt_secret (gerado UMA vez,
# chmod 600, persistente) → erro claro. Segredos NUNCA são impressos.
log "Validando JWT_SECRET"
JWT_SECRET_FILE="$DATA_DIR/.jwt_secret"
if [ -n "${JWT_SECRET:-}" ]; then
  ok "JWT_SECRET configurado (painel/.env)"
elif [ -f "$JWT_SECRET_FILE" ] && [ -s "$JWT_SECRET_FILE" ]; then
  JWT_SECRET="$(cat "$JWT_SECRET_FILE")"; export JWT_SECRET
  ok "JWT_SECRET carregado de $JWT_SECRET_FILE (persistente)"
elif SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' 2>/dev/null)" \
  && [ -n "$SECRET" ] \
  && (umask 177; printf '%s' "$SECRET" > "$JWT_SECRET_FILE" 2>/dev/null); then
  JWT_SECRET="$SECRET"; export JWT_SECRET; unset SECRET
  ok "JWT_SECRET gerado e salvo em $JWT_SECRET_FILE (persistente, chmod 600)"
else
  die "JWT_SECRET não configurado e não foi possível gerar em $JWT_SECRET_FILE (data/ sem escrita?). Defina JWT_SECRET no painel."
fi

if [ "$INSTALL_ONLY" -eq 1 ]; then
  # --install: ainda compila, mas não aplica migrations nem sobe o servidor.
  if [ ! -f "$APP_ENTRY" ] || [ "$SCHEMA" -nt "$APP_ENTRY" ]; then
    log "Compilando TypeScript (npm run build)"
    npm run build
    ok "Build concluído"
  fi
  ok "Instalação concluída (--install). Rode 'bash start.sh' para subir a API."
  exit 0
fi

# ── 8. Migrations (cria o SQLite na 1ª vez; nunca destrutivo) ───
if matrix_is_termux; then
  log "Aplicando migrations (runner node:sqlite — Termux, sem schema engine)"
else
  log "Aplicando migrations (prisma migrate deploy)"
fi
matrix_migrate "$PRISMA" .
ok "Migrations aplicadas"

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

# ── 9. Build ───────────────────────────────────────────────────
needs_build() {
  [ ! -f "$APP_ENTRY" ] && return 0
  while IFS= read -r -d '' src; do
    [ "$src" -nt "$APP_ENTRY" ] && return 0
  done < <(find src -type f -name '*.ts' -not -path 'src/generated/*' -print0 2>/dev/null)
  [ "$SCHEMA" -nt "$APP_ENTRY" ] && return 0
  return 1
}
if needs_build; then
  log "Compilando TypeScript (npm run build)"
  npm run build
  ok "Build concluído"
else
  ok "dist atualizado (build ignorado)"
fi
[ -f "$APP_ENTRY" ] || die "Entrypoint $APP_ENTRY não encontrado após o build."

# ── 10. Seed (só se o banco estiver vazio) ─────────────────────
if [ -f "$SEED_ENTRY" ]; then
  log "Verificando seed"
  node "$SEED_ENTRY" || warn "Seed ignorado/falhou (não bloqueia o start)"
  ok "Banco pronto"
else
  warn "Seed compilado ($SEED_ENTRY) ausente — pulando."
fi

# ── 11. Subir o servidor ───────────────────────────────────────
# exec → o Node vira o processo principal e recebe sinais (shutdown gracioso).
info "Entrypoint: node $APP_ENTRY"
ok "Bootstrap concluído — iniciando servidor na porta $PORT"
exec node "$APP_ENTRY"
