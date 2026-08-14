import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { createComment, deleteComment, listComments } from './comment.service.js';
import { createCommentSchema, listCommentsQuerySchema } from './comment.schema.js';

export const commentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/posts/:id/comments', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = listCommentsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    const page = await listComments(id, parsed.data);
    return reply.send(page);
  });

  app.post('/posts/:id/comments', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = createCommentSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    try {
      const comment = await createComment(request.user!.id, id, parsed.data);
      return reply.status(201).send(comment);
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/comments/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteComment(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
