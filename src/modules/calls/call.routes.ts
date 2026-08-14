import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { createRoom, listRooms, joinRoom, leaveRoom, endRoom, listParticipants } from './call.service.js';

// Matrix Calls routes (contracts only — no media transport).
//   GET    /calls
//   POST   /calls
//   POST   /calls/:id/join
//   POST   /calls/:id/leave
//   POST   /calls/:id/end
//   GET    /calls/:id/participants
export const callRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/calls', async (_request, reply) => {
    const rooms = await listRooms();
    return reply.send({ rooms });
  });

  app.post('/calls', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body as { title?: string };
    if (!body.title?.trim()) throw ApiError.invalidRequest('Título obrigatório.');
    const room = await createRoom(request.user!.id, body.title.trim());
    return reply.status(201).send({ room });
  });

  app.post('/calls/:id/join', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await joinRoom(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.post('/calls/:id/leave', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await leaveRoom(request.user!.id, id);
    return reply.status(204).send();
  });

  app.post('/calls/:id/end', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await endRoom(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.get('/calls/:id/participants', async (request, reply) => {
    const { id } = request.params as { id: string };
    const participants = await listParticipants(id);
    return reply.send({ participants });
  });
};
