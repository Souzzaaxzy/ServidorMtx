import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { toApiError } from '../../utils/errors.js';
import { listNotifications, markAllRead, markRead, unreadCount } from './notification.service.js';

export const notificationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/notifications', { onRequest: [app.authenticate] }, async (request, reply) => {
    const page = await listNotifications(request.user!.id);
    return reply.send(page);
  });

  // Cheap badge endpoint: only the number, not the whole list.
  app.get('/notifications/unread-count', { onRequest: [app.authenticate] }, async (request, reply) => {
    return reply.send({ unreadCount: await unreadCount(request.user!.id) });
  });

  app.patch('/notifications/:id/read', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await markRead(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.patch('/notifications/read-all', { onRequest: [app.authenticate] }, async (request, reply) => {
    await markAllRead(request.user!.id);
    return reply.status(204).send();
  });
};
