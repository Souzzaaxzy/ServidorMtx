import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { toApiError } from '../../utils/errors.js';
import { toggleLike } from './like.service.js';

export const likeRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // POST toggles the like on. Both verbs delegate to the same toggle so the
  // client can use whichever is convenient; the returned `liked` flag is
  // authoritative.
  app.post('/posts/:id/like', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await toggleLike(request.user!.id, id);
      return reply.send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/posts/:id/like', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await toggleLike(request.user!.id, id);
      return reply.send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });
};
