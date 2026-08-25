import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { toApiError } from '../../utils/errors.js';
import {
  acceptRequest,
  listPendingRequests,
  rejectRequest,
  sendFriendRequest,
  getFriendshipState,
} from './friend.service.js';

export const friendRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/friend-requests/:userId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      const item = await sendFriendRequest(request.user!.id, userId);
      return reply.status(201).send(item);
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.get('/friend-requests', { onRequest: [app.authenticate] }, async (request, reply) => {
    const requests = await listPendingRequests(request.user!.id);
    return reply.send({ requests });
  });

  app.post('/friend-requests/:id/accept', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await acceptRequest(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.post('/friend-requests/:id/reject', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await rejectRequest(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.get('/users/:id/friendship', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const state = await getFriendshipState(request.user!.id, id);
      return reply.send({ state });
    } catch (err) {
      throw toApiError(err);
    }
  });
};
