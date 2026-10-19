#!/bin/bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — bootstrap DENTRO do Debian (proot-distro no Termux)
#
# Não rode este script direto no Termux: ele é chamado pelo termux/termux.sh
# já dentro da distro glibc (é isso que faz Prisma e argon2 funcionarem).
#
# O que faz, em ordem (idempotente):
#   1. apt: openssl, ca-certificates, curl, git, xz-utils, python3, build-essential
#   2. instala o Node 22 oficial (tarball linux-arm64) em /usr/local
#   3. clona/atualiza o repositório em $MATRIX_DIR
#   4. executa o start.sh (instala deps, gera Prisma, compila, migra, sobe)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/Souzzaaxzy/ServidorMtx.git}"
MATRIX_DIR="${MATRIX_DIR:-/root/ServidorMtx}"
NODE_MAJOR="${NODE_MAJOR:-22}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[WARN] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo "  MATRIX API — bootstrap interno (Debian/proot)"
echo "  Arch: $(uname -m) | Distro: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo '?')"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Dependências do sistema ─────────────────────────────────
# openssl/ca-certificates: exigidos pelo engine do Prisma.
# python3 + build-essential: fallback caso algum módulo nativo precise compilar.
export DEBIAN_FRONTEND=noninteractive
log "Instalando pacotes do sistema (apt)"
apt-get update -y
apt-get install -y --no-install-recommends \
  openssl ca-certificates curl git xz-utils python3 make g++ procps
ok "Pacotes instalados"

# ── 2. Node 22 (tarball oficial linux-arm64) ───────────────────
# Evita o Node do apt (antigo) e o repositório Nodesource (que costuma não ter
# build para arm64 no Debian do proot). O tarball oficial é glibc e funciona.
case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH="arm64" ;;
  x86_64|amd64)  NODE_ARCH="x64" ;;
  *) die "Arquitetura não suportada: $(uname -m)" ;;
esac

node_major_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR" ] 2>/dev/null
}
if node_major_ok; then
  ok "Node já presente: $(node -v)"
else
  log "Instalando Node $NODE_MAJOR ($NODE_ARCH) em /usr/local"
  NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['version'] for x in d if x['version'].startswith('v${NODE_MAJOR}.')][0])")"
  [ -n "$NODE_VER" ] || die "Não foi possível resolver a versão do Node $NODE_MAJOR."
  TARBALL="node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
  log "Baixando $TARBALL"
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" -o "/tmp/${TARBALL}"
  tar -xJf "/tmp/${TARBALL}" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "/tmp/${TARBALL}"
  hash -r
  node_major_ok || die "Falha ao instalar o Node $NODE_MAJOR."
  ok "Node instalado: $(node -v) | npm $(npm -v)"
fi

# ── 3. Repositório ─────────────────────────────────────────────
if [ -d "$MATRIX_DIR/.git" ]; then
  log "Atualizando repositório existente ($MATRIX_DIR)"
  git -C "$MATRIX_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$MATRIX_DIR" checkout -f "$BRANCH"
  git -C "$MATRIX_DIR" reset --hard "origin/$BRANCH"
  ok "Repositório atualizado ($BRANCH)"
else
  log "Clonando $REPO_URL (branch $BRANCH)"
  mkdir -p "$(dirname "$MATRIX_DIR")"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$MATRIX_DIR"
  ok "Repositório clonado em $MATRIX_DIR"
fi

# ── 4. start.sh (instala tudo e sobe a API) ────────────────────
cd "$MATRIX_DIR"
[ -f start.sh ] || die "start.sh não encontrado em $MATRIX_DIR."
ok "Iniciando a API (bash start.sh) — Ctrl+C para parar"
exec bash start.sh
