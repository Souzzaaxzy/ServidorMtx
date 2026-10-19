#!/data/data/com.termux/files/usr/bin/bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — bootstrap para Termux (Android)
#
# POR QUE ISSO É NECESSÁRIO (leia antes de reclamar):
#   O Termux roda sobre o Android/bionic (não é glibc). O Prisma NÃO publica
#   binário para Android e o argon2 é compilado para glibc — os dois falham no
#   Termux "nativo" (dlopen: "is for EM_X86_64 instead of EM_AARCH64" /
#   "not accessible for the namespace"). A saída confiável é rodar a API dentro
#   de um userland glibc: o proot-distro (Debian) — que é o que este script faz.
#
# O QUE ELE FAZ:
#   1. instala o proot-distro no Termux;
#   2. instala um Debian arm64;
#   3. injeta e roda o bootstrap interno (termux/proot-bootstrap.sh), que
#      instala Node 22 + deps, clona o repo e executa o start.sh.
#
# USO (no Termux):
#   pkg update && pkg install curl -y
#   bash termux.sh
#   # ou direto, sem baixar o repo antes:
#   curl -fsSL https://raw.githubusercontent.com/Souzzaaxzy/ServidorMtx/main/termux/termux.sh | bash
#
# Variáveis opcionais:
#   DISTRO=debian          # distro do proot-distro
#   BRANCH=main            # branch do repositório
#   REPO_URL=...           # repositório a clonar
#   MATRIX_DIR=/root/ServidorMtx   # onde o repo fica DENTRO do Debian
# ──────────────────────────────────────────────────────────────
set -euo pipefail

DISTRO="${DISTRO:-debian}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/Souzzaaxzy/ServidorMtx.git}"
MATRIX_DIR="${MATRIX_DIR:-/root/ServidorMtx}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[WARN] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# ── Sanidade: precisa estar no Termux (não dentro do proot) ────
if [ ! -d /data/data/com.termux ]; then
  die "Este script deve rodar no TERMUX (fora do proot). Dentro do Debian use 'bash start.sh'."
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  MATRIX API — bootstrap Termux (via proot-distro/$DISTRO)"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. proot-distro ────────────────────────────────────────────
if ! command -v proot-distro >/dev/null 2>&1; then
  log "Instalando proot-distro (pkg install)"
  pkg update -y && pkg install -y proot-distro
fi
ok "proot-distro disponível"

# ── 2. Instalar a distro (se ainda não existir) ────────────────
if ! proot-distro login "$DISTRO" -- true >/dev/null 2>&1; then
  log "Instalando a distro '$DISTRO' (pode demorar)"
  proot-distro install "$DISTRO"
fi
ok "Distro '$DISTRO' pronta"

# ── 3. Localizar o bootstrap interno ───────────────────────────
# Preferimos o arquivo do próprio repo (quando rodado de dentro dele); se não
# existir (ex.: pipe do curl), baixamos do GitHub.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
INNER_LOCAL="${SCRIPT_DIR}/proot-bootstrap.sh"
INNER_URL="https://raw.githubusercontent.com/Souzzaaxzy/ServidorMtx/${BRANCH}/termux/proot-bootstrap.sh"

INNER_TMP="$(mktemp "${TMPDIR:-/tmp}/matrix-proot-XXXXXX.sh")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$INNER_LOCAL" ]; then
  cp "$INNER_LOCAL" "$INNER_TMP"
else
  log "Baixando bootstrap interno"
  curl -fsSL "$INNER_URL" -o "$INNER_TMP" || die "Não foi possível baixar $INNER_URL"
fi
chmod +x "$INNER_TMP"

# ── 4. Injetar e executar dentro do Debian ─────────────────────
# Sem --bind: a sintaxe de bind varia entre versões do proot-distro. Em vez
# disso, copiamos o script para /tmp (o proot compartilha /tmp por padrão) e
# rodamos de lá.
log "Executando o bootstrap dentro do $DISTRO"
cp "$INNER_TMP" "${TMPDIR:-/tmp}/matrix-proot-bootstrap.sh"
rm -f "$INNER_TMP"

proot-distro login "$DISTRO" --shared-tmp -- \
  env BRANCH="$BRANCH" REPO_URL="$REPO_URL" MATRIX_DIR="$MATRIX_DIR" \
  bash /tmp/matrix-proot-bootstrap.sh

ok "Bootstrap concluído."
