import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  clearProfileMusic,
  getProfileMusic,
  searchMusic,
  setProfileMusic,
} from './profile-music.service.js';

// Música do perfil.
//   GET    /music/profile/search?q=...   (auth) → até 3 resultados
//   GET    /music/profile                (auth) → a música do próprio perfil
//   PUT    /music/profile                (auth) → define o trecho (<= 1 min)
//   DELETE /music/profile                (auth) → remove a música
//
// A busca e o download acontecem SEMPRE no servidor — o APK nunca fala com o
// YouTube, e nenhuma credencial externa existe.
export const profileMusicRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/music/profile/search', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { q } = request.query as { q?: string };
    try {
      const results = await searchMusic(q ?? '');
      return reply.send({ results });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.get('/music/profile', { onRequest: [app.authenticate] }, async (request, reply) => {
    const music = await getProfileMusic(request.user!.id);
    return reply.send({ music });
  });

  app.put('/music/profile', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      sourceId?: unknown;
      title?: unknown;
      artist?: unknown;
      coverUrl?: unknown;
      startMs?: unknown;
      durationMs?: unknown;
    };
    if (typeof body.sourceId !== 'string' || body.sourceId.trim() === '') {
      throw ApiError.validation('Selecione uma música.');
    }
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw ApiError.validation('Nome da música obrigatório.');
    }
    if (body.durationMs === undefined || body.durationMs === null) {
      throw ApiError.validation('Informe a duração do trecho.');
    }
    try {
      const music = await setProfileMusic(request.user!.id, {
        sourceId: body.sourceId.trim(),
        title: body.title,
        artist: typeof body.artist === 'string' ? body.artist : '',
        coverUrl: typeof body.coverUrl === 'string' ? body.coverUrl : null,
        startMs: body.startMs === undefined || body.startMs === null ? 0 : Number(body.startMs),
        durationMs: Number(body.durationMs),
      });
      return reply.status(201).send({ music });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/music/profile', { onRequest: [app.authenticate] }, async (request, reply) => {
    await clearProfileMusic(request.user!.id);
    return reply.status(204).send();
  });
};
