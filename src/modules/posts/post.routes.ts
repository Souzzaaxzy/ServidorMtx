import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { createPost, deletePost, getFeed, getPostById } from './post.service.js';
import { createPostSchema, feedQuerySchema } from './post.schema.js';

export const postRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // GET /posts — chronological feed (newest first), cursor pagination.
  app.get('/posts', { onRequest: [app.optionalAuth] }, async (request, reply) => {
    const parsed = feedQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    }
    const userId = request.user?.id; // optional: feed is public, "liked" requires auth
    const page = await getFeed(userId, parsed.data);
    return reply.send(page);
  });

  app.get('/posts/:id', { onRequest: [app.optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const post = await getPostById(id, request.user?.id);
    return reply.send(post);
  });

  // POST /posts — create. Requires auth.
  app.post('/posts', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = createPostSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const post = await createPost(request.user!.id, parsed.data);
      return reply.status(201).send(post);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // DELETE /posts/:id — owner-only, verified server-side.
  app.delete('/posts/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deletePost(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
