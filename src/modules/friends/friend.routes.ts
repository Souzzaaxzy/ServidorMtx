import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { toApiError } from '../../utils/errors.js';
import {
  acceptRequest,
  cancelFriendRequest,
  listFriends,
  listPendingRequests,
  rejectRequest,
  removeFriend,
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

  // Cancels the PENDING request the CURRENT user sent to :userId (only the
  // sender may cancel; the row + its notification cascade-delete).
  app.delete('/friend-requests/:userId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      await cancelFriendRequest(request.user!.id, userId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
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

  // Friends of ANY user (own accepted list on the own profile; another
  // user's list on their profile). Page-based pagination; the same query
  // backs the profile "Amigos" counter, so list/number never diverge.
  app.get('/users/:id/friends', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { page?: string; pageSize?: string };
    const page = Number.parseInt(query.page ?? '1', 10) || 1;
    const pageSize = Number.parseInt(query.pageSize ?? '20', 10) || 20;
    const result = await listFriends(id, page, pageSize);
    return reply.send(result);
  });

  // Removes the ACCEPTED friendship between the current user and :userId.
  // Only one side of the friendship may remove it (validated server-side).
  app.delete('/users/:id/friends', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await removeFriend(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
