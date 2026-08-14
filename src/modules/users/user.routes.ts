import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { getProfile, updateProfile } from './user.service.js';
import { updateProfileSchema } from './user.schema.js';

export const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/users/:username', { onRequest: [app.optionalAuth] }, async (request, reply) => {
    const { username } = request.params as { username: string };
    try {
      const profile = await getProfile(username, request.user?.id);
      return reply.send(profile);
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.patch('/users/me', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const user = await updateProfile(request.user!.id, parsed.data);
      return reply.send({ user });
    } catch (err) {
      throw toApiError(err);
    }
  });
};
