import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { listTracks, createPlaylist, listMyPlaylists, addTrackToPlaylist, voteTrack } from './music.service.js';

// Matrix Music routes.
//   GET    /music/tracks
//   POST   /music/playlists
//   GET    /music/playlists
//   POST   /music/playlists/:id/tracks
//   POST   /music/tracks/:id/vote
export const musicRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/music/tracks', async (_request, reply) => {
    const tracks = await listTracks();
    return reply.send({ tracks });
  });

  app.post('/music/playlists', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body as { title?: string; description?: string; visibility?: string };
    if (!body.title?.trim()) throw ApiError.invalidRequest('Título obrigatório.');
    const playlist = await createPlaylist(
      request.user!.id,
      body.title.trim(),
      body.description ?? '',
      body.visibility ?? 'public',
    );
    return reply.status(201).send({ playlist });
  });

  app.get('/music/playlists', { onRequest: [app.authenticate] }, async (request, reply) => {
    const playlists = await listMyPlaylists(request.user!.id);
    return reply.send({ playlists });
  });

  app.post('/music/playlists/:id/tracks', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { trackId?: string; position?: number };
    if (!body.trackId) throw ApiError.invalidRequest('trackId obrigatório.');
    try {
      const entry = await addTrackToPlaylist(request.user!.id, id, body.trackId, body.position ?? 0);
      return reply.status(201).send({ entry });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.post('/music/tracks/:id/vote', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { direction?: 'UP' | 'DOWN' };
    const direction = body.direction ?? 'UP';
    try {
      const vote = await voteTrack(request.user!.id, id, direction);
      return reply.send({ vote });
    } catch (err) {
      throw toApiError(err);
    }
  });
};
