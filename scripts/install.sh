#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# MATRIX API — Pterodactyl installation script
#
# Runs once when the server is created in the panel. It clones the repo
# (if not already present), installs dependencies, generates the Prisma
# client, and compiles TypeScript — so the runtime `npm start` only needs
# to apply migrations + start the server.
#
# In Pterodactyl the install container mounts the server volume at
# /mnt/server. This script works from whichever directory it is invoked in.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Souzzaaxzy/ServidorMtx.git}"
BRANCH="${BRANCH:-main}"

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

# Pterodactyl mounts the server data directory here during install.
cd /mnt/server 2>/dev/null || cd "$(pwd)"

# ── Clone if the repo is not already present ──────────────────
if [ ! -f package.json ]; then
  log "Clonando repositório: $REPO_URL (branch $BRANCH)"
  # Clone into a temp dir then move contents into place (Pterodactyl's
  # /mnt/server is not empty-friendly for `git clone .`).
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" /tmp/matrix-src
  # Move everything including hidden files into the server directory.
  shopt -s dotglob
  mv /tmp/matrix-src/* .
  shopt -u dotglob
  rmdir /tmp/matrix-src 2>/dev/null || true
  ok "Repositório clonado"
else
  log "package.json já presente — pulando clone"
fi

# ── Install dependencies ──────────────────────────────────────
# --include=dev ensures devDependencies (tsc, typescript, prisma CLI) are
# installed even when NODE_ENV=production is set by the panel — they are
# required to compile TypeScript below.
log "Instalando dependências (npm install)"
npm install --include=dev
ok "Dependências instaladas"

# ── Generate Prisma client ────────────────────────────────────
log "Gerando cliente Prisma"
./node_modules/.bin/prisma generate
ok "Cliente Prisma gerado"

# ── Build ─────────────────────────────────────────────────────
log "Compilando TypeScript"
npm run build
ok "Build concluído"

ok "Instalação do MATRIX API concluída!"
ok "Configure apenas JWT_SECRET nas variáveis do servidor no painel."
ok "A porta é obtida automaticamente do painel e o banco é SQLite local (data/matrix.db) — DATABASE_URL não é necessária."
