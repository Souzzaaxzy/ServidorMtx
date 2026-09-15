import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  createStory,
  deleteStory,
  listActiveStories,
  markStoryViewed,
  purgeExpiredStories,
  replyToStory,
  toggleStoryLike,
} from './story.service.js';
import { createStorySchema, replyStorySchema } from './story.schema.js';

export const storyRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // GET /stories — ACTIVE stories (not expired), grouped by author, ordered
  // with unviewed authors first. Public like the feed (optionalAuth): the
  // viewed/mine flags simply stay false for anonymous callers.
  //
  // Expired stories are purged here (server-side) so a story never shows up
  // as active past its 24h and abandoned media is swept without a scheduler.
  app.get('/stories', { onRequest: [app.optionalAuth] }, async (request, reply) => {
    await purgeExpiredStories().catch(() => void 0);
    const groups = await listActiveStories(request.user?.id);
    return reply.send(groups);
  });

  // POST /stories — create. Requires auth. Expiry (24h) is computed on the
  // server; the client can never choose it.
  app.post('/stories', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = createStorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const story = await createStory(request.user!.id, parsed.data);
      return reply.status(201).send(story);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // POST /stories/:id/view — marks the story as seen by the session user.
  // Idempotent (upsert).
  app.post('/stories/:id/view', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await markStoryViewed(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // POST /stories/:id/like — toggles the session user's like. Same semantics
  // as the post feed (one row per user+story; never duplicates).
  app.post('/stories/:id/like', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await toggleStoryLike(request.user!.id, id);
      return reply.send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // POST /stories/:id/reply — the reply becomes a REAL direct message to the
  // story's AUTHOR (existing conversation + realtime infrastructure; the
  // recipient is never taken from the client).
  app.post('/stories/:id/reply', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = replyStorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const result = await replyToStory(request.user!.id, id, parsed.data.text);
      return reply.status(201).send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // DELETE /stories/:id — owner-only (verified server-side: a user can never
  // delete someone else's story).
  app.delete('/stories/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteStory(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
