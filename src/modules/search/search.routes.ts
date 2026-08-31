import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  listRecentSearches,
  removeRecentSearch,
  saveRecentSearch,
  searchUsers,
} from './search.service.js';
import { searchQuerySchema, searchRecentsQuerySchema } from './search.schema.js';

export const searchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/users/search', async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    }
    const users = await searchUsers(parsed.data);
    return reply.send({ users });
  });

  // ── "Pesquisas recentes" (visited profiles) ──────────────────
  app.get('/search/recents', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = searchRecentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    }
    void parsed.data; // limit is optional (server defaults to 10).
    const recents = await listRecentSearches(request.user!.id, parsed.data);
    return reply.send(recents);
  });

  app.post('/search/recents/:userId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      await saveRecentSearch(request.user!.id, userId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/search/recents/:recentId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { recentId } = request.params as { recentId: string };
    try {
      await removeRecentSearch(request.user!.id, recentId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
