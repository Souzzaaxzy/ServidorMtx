#!/data/data/com.termux/files/usr/bin/bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — instalador para Termux (Android ARM64, SEM proot/Ubuntu)
#
# O que este script faz, em ordem:
#   1. confere o ambiente (Termux/Android, arquitetura, Node, npm);
#   2. instala os pacotes do Termux necessários (git, openssl, python, build);
#   3. clona/atualiza o repositório;
#   4. instala as dependências (npm install, tolerando o argon2 opcional);
#   5. gera o cliente Prisma (engine JS/WASM — sem binário nativo);
#   6. compila o TypeScript;
#   7. cria o banco SQLite e aplica as migrations (sem apagar dados);
#   8. informa como iniciar.
#
# NÃO precisa de: root, Ubuntu, proot-distro, Docker ou servidor externo.
# O Prisma roda com o query compiler em JS/WASM e o driver embutido
# node:sqlite; o hash de senha usa o argon2 do node:crypto (Node >= 24.7).
#
# Uso:
#   bash termux/termux-native.sh              # instala tudo
#   bash termux/termux-native.sh --no-clone   # já estou no repo, só instala
#   bash termux/termux-native.sh --help
# ──────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Souzzaaxzy/ServidorMtx.git}"
BRANCH="${BRANCH:-main}"
TARGET_DIR="${TARGET_DIR:-$HOME/ServidorMtx}"
NO_CLONE=0

for arg in "$@"; do
  case "$arg" in
    --no-clone) NO_CLONE=1 ;;
    --help|-h) grep '^#' "$0" | sed -n '2,28p' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2 ;;
  esac
done

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[WARN] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo "  MATRIX API — instalação nativa no Termux"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Ambiente ────────────────────────────────────────────────
[ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ] \
  || die "Este script é para o Termux. Em Linux use: npm install && bash start.sh"

case "$(uname -m)" in
  aarch64|arm64|armv7l|armv8l|x86_64|amd64) : ;;
  *) warn "Arquitetura não usual: $(uname -m) — continuando mesmo assim." ;;
esac

log "Instalando pacotes do Termux (git, openssl, python, build)"
pkg update -y >/dev/null 2>&1 || warn "pkg update falhou (seguindo)"
# openssl é exigido pelo Prisma CLI; python/make/clang permitem compilar
# módulos nativos opcionais (argon2) quando existir fonte compatível.
# yt-dlp/ffmpeg habilitam a MÚSICA DO PERFIL (busca no YouTube Music +
# corte do trecho). Sem eles a API sobe normalmente e só esse recurso
# responde com uma mensagem amigável.
pkg install -y git openssl ca-certificates python make clang >/dev/null 2>&1 \
  || warn "Alguns pacotes podem não ter sido instalados (seguindo)"
pkg install -y yt-dlp ffmpeg >/dev/null 2>&1 \
  || warn "yt-dlp/ffmpeg não instalados — a música do perfil ficará indisponível (pkg install yt-dlp ffmpeg)"
# O YouTube exige um runtime de JavaScript para o yt-dlp. O código já cai para
# o Node do próprio servidor, então isto é opcional (só melhora a extração).
pkg install -y deno >/dev/null 2>&1 \
  || warn "deno não instalado (opcional: o servidor usa o próprio Node como runtime JS)"
ok "Pacotes verificados"

command -v node >/dev/null 2>&1 || {
  err "Node.js não encontrado. Instale com:  pkg install nodejs"
  err "Para o argon2 embutido (recomendado) use Node >= 24.7:  pkg install nodejs-lts"
  die "Node ausente."
}
command -v npm >/dev/null 2>&1 || die "npm não encontrado (pkg install nodejs)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
log "Node detectado: $(node -v) | npm $(npm -v)"

# node:sqlite (driver) requer >= 22.5; argon2 embutido requer >= 24.7.
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  die "Node >= 22.5 é obrigatório (módulo node:sqlite). Atualize: pkg install nodejs"
fi
if [ "$NODE_MAJOR" -lt 24 ] || { [ "$NODE_MAJOR" -eq 24 ] && [ "$NODE_MINOR" -lt 7 ]; }; then
  warn "Node < 24.7: o argon2 embutido não existe. O hash de senha tentará usar o"
  warn "pacote npm 'argon2', que NÃO tem binário pronto para Android e precisa"
  warn "compilar. Recomendado:  pkg install nodejs-lts  (Node >= 24.7)"
fi

# ── 2. Repositório ─────────────────────────────────────────────
if [ "$NO_CLONE" -eq 0 ] && [ ! -f package.json ]; then
  log "Clonando o repositório em $TARGET_DIR"
  if [ -d "$TARGET_DIR/.git" ]; then
    git -C "$TARGET_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$TARGET_DIR" checkout -f "$BRANCH"
    git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
  else
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$TARGET_DIR"
  fi
  cd "$TARGET_DIR"
  ok "Repositório pronto em $TARGET_DIR"
elif [ -f package.json ]; then
  ok "Já na raiz do projeto ($(pwd))"
else
  die "package.json não encontrado. Rode de dentro do repo ou sem --no-clone."
fi

[ -f package.json ] || die "package.json ausente."

# ── 3. Dependências ────────────────────────────────────────────
log "Instalando dependências (npm install)"
# argon2 é opcional (optionalDependencies): se o build nativo falhar no
# Android, o npm continua. Em Node >= 24.7 nem é usado.
npm install --include=dev || npm install --include=dev --omit=optional
ok "Dependências instaladas"

# ── 4. Cliente Prisma + build ──────────────────────────────────
mkdir -p data
export DATABASE_URL="${DATABASE_URL:-file:$(pwd)/data/matrix.db}"

# Prisma helpers: on Termux, generate runs offline (the CLI would otherwise
# download an unusable native schema-engine) and migrations use the node:sqlite
# runner instead of the Prisma CLI.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/lib-prisma.sh"

log "Gerando o cliente Prisma (engine JS/WASM — sem binário nativo)"
matrix_prisma_generate ./node_modules/.bin/prisma .
ok "Cliente Prisma gerado"

log "Compilando TypeScript"
npm run build
ok "Build concluído"

# ── 5. Banco de dados ──────────────────────────────────────────
log "Aplicando migrations no SQLite (runner node:sqlite — não destrutivo)"
matrix_migrate ./node_modules/.bin/prisma .
ok "Banco pronto: $DATABASE_URL"

echo "═══════════════════════════════════════════════════════════════"
ok "Instalação concluída!"
echo "  Para iniciar a API:"
echo "      cd $(pwd)"
echo "      bash start.sh            # ou: npm run termux:start"
echo "  Verificação de ambiente:"
echo "      npm run doctor"
echo "  A API responde em http://127.0.0.1:3000 (ou na PORT definida)."
echo "═══════════════════════════════════════════════════════════════"
