import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';

// ── Matrix Music ──────────────────────────────────────────────
// No commercial audio is stored. Tracks reference an external provider
// (e.g. a licensed streaming API). The server only stores metadata,
// playlists and votes.

export interface TrackDto {
  id: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  provider: string;
  externalId: string | null;
  externalUrl: string | null;
  duration: number;
}

export async function listTracks(): Promise<TrackDto[]> {
  const tracks = await prisma.track.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  return tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    coverUrl: t.coverUrl,
    provider: t.provider,
    externalId: t.externalId,
    externalUrl: t.externalUrl,
    duration: t.duration,
  }));
}

export async function createPlaylist(userId: string, title: string, description = '', visibility = 'public') {
  return prisma.playlist.create({
    data: { ownerId: userId, title, description, visibility },
  });
}

export async function listMyPlaylists(userId: string) {
  return prisma.playlist.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'desc' } });
}

export async function addTrackToPlaylist(userId: string, playlistId: string, trackId: string, position: number) {
  const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
  if (!playlist || playlist.ownerId !== userId) throw ApiError.notFound('Playlist não encontrada.');
  return prisma.playlistTrack.create({
    data: { playlistId, trackId, position },
  });
}

export async function voteTrack(userId: string, trackId: string, direction: 'UP' | 'DOWN') {
  const track = await prisma.track.findUnique({ where: { id: trackId } });
  if (!track) throw ApiError.notFound('Música não encontrada.');
  return prisma.musicVote.upsert({
    where: { userId_trackId: { userId, trackId } },
    update: { direction },
    create: { userId, trackId, direction },
  });
}
