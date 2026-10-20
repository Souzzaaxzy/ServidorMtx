#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# matrix_fetch_media_tools — baixa yt-dlp e ffmpeg como BINÁRIOS
# ESTÁTICOS quando o host não tem como instalá-los.
#
# POR QUE EXISTE: em container (Pterodactyl/Bronxys) NÃO há root, `apt` nem
# um `pip` que funcione — as tentativas de instalar por gerenciador de pacotes
# falham em silêncio e a música do perfil fica indisponível. Os binários
# oficiais estáticos não dependem de Python nem de root: baixar e executar.
#
# SEGURANÇA: estamos baixando e EXECUTANDO código de terceiros. Por isso:
#   * só HTTPS e só dos hosts oficiais (github.com/yt-dlp e BtbN/FFmpeg-Builds,
#     o build que o próprio yt-dlp recomenda);
#   * o SHA-256 é OBRIGATÓRIO: sem checksum publicado e conferido, o arquivo é
#     DESCARTADO (nunca executamos bytes não verificados);
#   * instalação em `data/bin/` (persistente, fora do git) e chmod 700;
#   * o arquivo é executado uma vez (`--version`) antes de ser aceito.
# ──────────────────────────────────────────────────────────────

# Diretório onde os binários baixados vivem (persistente entre reinícios).
MATRIX_MEDIA_BIN_DIR="${MATRIX_MEDIA_BIN_DIR:-$PWD/data/bin}"

# Arquitetura do host → sufixo dos assets oficiais.
matrix_media_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    armv7l | armv7) echo "armv7" ;;
    *) echo "" ;;
  esac
}

# Baixa um arquivo com HTTPS e timeout. Silencioso por padrão.
matrix_download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 900 --retry 2 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=900 -O "$out" "$url"
  else
    return 1
  fi
}

# Confere o SHA-256 de $1 contra a linha que contém $2 em $3 (arquivo de somas).
# Devolve 1 quando não há soma correspondente (nunca aceitamos sem conferir).
matrix_verify_sha256() {
  local file="$1" name="$2" sums_file="$3"
  local expected actual
  expected="$(grep -E "[[:space:]]\*?${name}$" "$sums_file" 2>/dev/null | head -1 | awk '{print $1}')"
  [ -n "$expected" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    return 1
  fi
  [ "$expected" = "$actual" ]
}

# Baixa e instala o yt-dlp estático. Devolve 0 em sucesso.
matrix_fetch_ytdlp() {
  local arch asset url tmp sums
  arch="$(matrix_media_arch)"
  [ -n "$arch" ] || { warn "Arquitetura $(uname -m) sem binário estático do yt-dlp"; return 1; }

  case "$arch" in
    x64) asset="yt-dlp_linux" ;;
    arm64) asset="yt-dlp_linux_aarch64" ;;
    *) warn "yt-dlp estático não publicado para $arch"; return 1 ;;
  esac

  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset"
  mkdir -p "$MATRIX_MEDIA_BIN_DIR" 2>/dev/null || return 1
  tmp="$(mktemp "$MATRIX_MEDIA_BIN_DIR/.ytdlp.XXXXXX")" || return 1
  sums="$tmp.sums"

  log "Baixando yt-dlp estático ($asset)…"
  if ! matrix_download "$url" "$tmp"; then
    rm -f "$tmp"; warn "Falha ao baixar o yt-dlp"; return 1
  fi
  # SHA-256 obrigatório: sem o arquivo de somas oficial, NÃO instalamos.
  if ! matrix_download "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" "$sums"; then
    rm -f "$tmp" "$sums"; warn "Sem checksums do yt-dlp — download descartado"; return 1
  fi
  if ! matrix_verify_sha256 "$tmp" "$asset" "$sums"; then
    rm -f "$tmp" "$sums"
    warn "SHA-256 do yt-dlp NÃO confere — download descartado por segurança"
    return 1
  fi
  rm -f "$sums"

  chmod 700 "$tmp" || { rm -f "$tmp"; return 1; }
  if ! "$tmp" --version >/dev/null 2>&1; then
    rm -f "$tmp"; warn "O yt-dlp baixado não executa neste host"; return 1
  fi
  mv -f "$tmp" "$MATRIX_MEDIA_BIN_DIR/yt-dlp" || return 1
  ok "yt-dlp instalado em $MATRIX_MEDIA_BIN_DIR/yt-dlp"
  return 0
}

# Baixa e instala o ffmpeg/ffprobe estáticos (build BtbN, o recomendado pelo
# próprio yt-dlp). O ffmpeg é OPCIONAL — sem ele o app toca a janela do trecho.
matrix_fetch_ffmpeg() {
  local arch asset url tmp sums dir
  arch="$(matrix_media_arch)"
  [ -n "$arch" ] || return 1

  case "$arch" in
    x64) asset="ffmpeg-master-latest-linux64-gpl.tar.xz" ;;
    arm64) asset="ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;;
    *) return 1 ;;
  esac

  url="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/$asset"
  mkdir -p "$MATRIX_MEDIA_BIN_DIR" 2>/dev/null || return 1
  tmp="$(mktemp "$MATRIX_MEDIA_BIN_DIR/.ffmpeg.XXXXXX")" || return 1
  sums="$tmp.sums"

  log "Baixando ffmpeg estático ($asset) — pode demorar"
  if ! matrix_download "$url" "$tmp"; then
    rm -f "$tmp"; warn "Falha ao baixar o ffmpeg"; return 1
  fi
  if ! matrix_download "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/checksums.sha256" "$sums"; then
    rm -f "$tmp" "$sums"; warn "Sem checksums do ffmpeg — download descartado"; return 1
  fi
  if ! matrix_verify_sha256 "$tmp" "$asset" "$sums"; then
    rm -f "$tmp" "$sums"
    warn "SHA-256 do ffmpeg NÃO confere — download descartado por segurança"
    return 1
  fi
  rm -f "$sums"

  dir="$(mktemp -d "$MATRIX_MEDIA_BIN_DIR/.ffx.XXXXXX")" || { rm -f "$tmp"; return 1; }
  if ! tar -xJf "$tmp" -C "$dir" --strip-components=1 2>/dev/null; then
    rm -rf "$dir" "$tmp"; warn "Não foi possível extrair o ffmpeg"; return 1
  fi
  rm -f "$tmp"
  if [ -x "$dir/bin/ffmpeg" ] && "$dir/bin/ffmpeg" -version >/dev/null 2>&1; then
    mv -f "$dir/bin/ffmpeg" "$MATRIX_MEDIA_BIN_DIR/ffmpeg" || true
    [ -x "$dir/bin/ffprobe" ] && mv -f "$dir/bin/ffprobe" "$MATRIX_MEDIA_BIN_DIR/ffprobe" 2>/dev/null || true
    chmod 700 "$MATRIX_MEDIA_BIN_DIR/ffmpeg" 2>/dev/null || true
    rm -rf "$dir"
    ok "ffmpeg instalado em $MATRIX_MEDIA_BIN_DIR/ffmpeg"
    return 0
  fi
  rm -rf "$dir"
  warn "O ffmpeg baixado não executa neste host"
  return 1
}
