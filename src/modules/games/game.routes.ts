import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { listGames, startSession, finishSession } from './game.service.js';

// Games routes.
//   GET    /games
//   POST   /games/:slug/sessions          start a session
//   POST   /games/sessions/:id/finish     finish + grant server-validated reward
export const gameRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/games', async (_request, reply) => {
    const games = await listGames();
    return reply.send({ games });
  });

  app.post('/games/:slug/sessions', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    try {
      const session = await startSession(request.user!.id, slug);
      return reply.status(201).send({ session });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.post('/games/sessions/:id/finish', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { score?: number };
    if (typeof body.score !== 'number' || body.score < 0) {
      throw ApiError.invalidRequest('Score inválido.');
    }
    try {
      const result = await finishSession(request.user!.id, id, body.score);
      return reply.send({ result });
    } catch (err) {
      throw toApiError(err);
    }
  });
};
