import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import {
  deleteProfileMusicFile,
  downloadMusicExcerpt,
  MAX_PROFILE_MUSIC_MS,
  MIN_PROFILE_MUSIC_MS,
  searchProfileMusic,
  type MusicSearchResult,
} from './profile-music.ytdlp.js';

// ── Música do perfil ─────────────────────────────────────────
// Uma música por perfil (Instagram-style). O áudio é um TRECHO baixado do
// YouTube e servido pelo próprio servidor; a linha guarda o que o app precisa
// para tocar e para creditar o autor.

export interface ProfileMusicDto {
  title: string;
  artist: string;
  coverUrl: string | null;
  audioUrl: string;
  /** Duração do trecho guardado (ms) — sempre <= MAX_PROFILE_MUSIC_MS. */
  durationMs: number;
  /** Início do trecho na faixa original (ms). */
  startMs: number;
  /** Página da faixa no YouTube (crédito ao autor). */
  sourceUrl: string;
  sourceId: string;
}

function toDto(row: {
  title: string;
  artist: string;
  coverUrl: string | null;
  audioUrl: string;
  durationMs: number;
  startMs: number;
  sourceUrl: string;
  sourceId: string;
}): ProfileMusicDto {
  return {
    title: row.title,
    artist: row.artist,
    coverUrl: row.coverUrl,
    audioUrl: row.audioUrl,
    durationMs: row.durationMs,
    startMs: row.startMs,
    sourceUrl: row.sourceUrl,
    sourceId: row.sourceId,
  };
}

/** Busca músicas (somente catálogo musical, já limpo). */
export async function searchMusic(query: string): Promise<MusicSearchResult[]> {
  return searchProfileMusic(query);
}

/**
 * Define a música do perfil do usuário.
 *
 * O trecho é re-validado AQUI (nunca confiamos no app): duração entre 5s e
 * 1 minuto e início não-negativo. O download acontece antes de tocar no
 * banco, então uma falha externa não deixa o perfil num estado meio-feito.
 *
 * Substituir a música remove o arquivo ANTERIOR depois de gravar o novo —
 * nessa ordem, uma falha no meio nunca deixa o perfil apontando para um
 * arquivo já apagado.
 */
export async function setProfileMusic(
  userId: string,
  input: {
    sourceId: string;
    title: string;
    artist: string;
    coverUrl?: string | null;
    startMs?: number;
    durationMs: number;
  },
): Promise<ProfileMusicDto> {
  const startMs = Math.round(Number(input.startMs ?? 0));
  const durationMs = Math.round(Number(input.durationMs));
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw ApiError.validation('Trecho inválido.');
  }
  if (!Number.isFinite(durationMs) || durationMs < MIN_PROFILE_MUSIC_MS) {
    throw ApiError.validation('O trecho deve ter pelo menos 5 segundos.');
  }
  if (durationMs > MAX_PROFILE_MUSIC_MS) {
    throw ApiError.validation('O trecho deve ter no máximo 1 minuto.');
  }
  const title = input.title.trim();
  if (title === '') throw ApiError.validation('Nome da música obrigatório.');
  if (title.length > 200) throw ApiError.validation('Nome da música muito longo.');
  const artist = (input.artist ?? '').trim().slice(0, 200);

  const previous = await prisma.profileMusic.findUnique({ where: { userId } });

  const stored = await downloadMusicExcerpt(input.sourceId, startMs, durationMs);

  const row = await prisma.profileMusic.upsert({
    where: { userId },
    update: {
      title,
      artist,
      coverUrl: input.coverUrl ?? null,
      audioUrl: stored.url,
      durationMs,
      startMs,
      sourceId: input.sourceId,
      sourceUrl: `https://www.youtube.com/watch?v=${input.sourceId}`,
    },
    create: {
      userId,
      title,
      artist,
      coverUrl: input.coverUrl ?? null,
      audioUrl: stored.url,
      durationMs,
      startMs,
      sourceId: input.sourceId,
      sourceUrl: `https://www.youtube.com/watch?v=${input.sourceId}`,
    },
  });

  // Só depois de o novo arquivo estar persistido no banco é que o antigo
  // pode ir embora — nunca antes (ver comentário acima).
  if (previous && previous.audioUrl !== row.audioUrl) {
    await deleteProfileMusicFile(previous.audioUrl);
  }

  return toDto(row);
}

/** A música do perfil de um usuário, ou null quando não há. */
export async function getProfileMusic(userId: string): Promise<ProfileMusicDto | null> {
  const row = await prisma.profileMusic.findUnique({ where: { userId } });
  return row ? toDto(row) : null;
}

/** Remove a música do perfil (idempotente) e apaga o arquivo do trecho. */
export async function clearProfileMusic(userId: string): Promise<void> {
  const row = await prisma.profileMusic.findUnique({ where: { userId } });
  if (!row) return;
  await prisma.profileMusic.delete({ where: { userId } });
  await deleteProfileMusicFile(row.audioUrl);
}
