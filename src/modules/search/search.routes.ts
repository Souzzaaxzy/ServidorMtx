import type { FastifyPluginAsync } from 'fastify';
import { ApiError } from '../../utils/errors.js';
import { searchUsers } from './search.service.js';
import { searchQuerySchema } from './search.schema.js';

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users/search', async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    }
    const users = await searchUsers(parsed.data);
    return reply.send({ users });
  });
};
