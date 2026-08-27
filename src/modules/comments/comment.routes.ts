import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  createComment,
  deleteComment,
  listCommentReplies,
  listComments,
  replyToComment,
  toggleCommentLike,
} from './comment.service.js';
import {
  commentIdParamsSchema,
  createCommentSchema,
  listCommentsQuerySchema,
  parentCommentParamsSchema,
} from './comment.schema.js';

export const commentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Top-level comments of a post (parentCommentId = null), oldest first.
  // Works for anonymous viewers; with a valid token the per-viewer `liked`
  // flag is populated.
  app.get('/posts/:id/comments', { onRequest: [app.optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = listCommentsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    const page = await listComments(id, parsed.data, request.user?.id);
    return reply.send(page);
  });

  // Create a top-level comment on a post.
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

  // Replies of a top-level comment, oldest first — same shape as comments.
  app.get('/comments/:parentId/replies', { onRequest: [app.optionalAuth] }, async (request, reply) => {
    const { parentId } = parentCommentParamsSchema.parse(request.params);
    const parsed = listCommentsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    const page = await listCommentReplies(parentId, parsed.data, request.user?.id);
    return reply.send(page);
  });

  // Reply to a comment (or to a reply — it is re-parented onto the top comment).
  app.post('/comments/:parentId/replies', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { parentId } = parentCommentParamsSchema.parse(request.params);
    const parsed = createCommentSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    try {
      const comment = await replyToComment(request.user!.id, parentId, parsed.data);
      return reply.status(201).send(comment);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Toggle a like on a comment/reply (server is the source of truth).
  app.post('/comments/:id/like', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = commentIdParamsSchema.parse(request.params);
    try {
      const result = await toggleCommentLike(request.user!.id, id);
      return reply.send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/comments/:id/like', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = commentIdParamsSchema.parse(request.params);
    try {
      const result = await toggleCommentLike(request.user!.id, id);
      return reply.send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/comments/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = commentIdParamsSchema.parse(request.params);
    try {
      await deleteComment(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
