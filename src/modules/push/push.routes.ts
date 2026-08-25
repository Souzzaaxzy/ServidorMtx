import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toApiError } from '../../utils/errors.js';
import { verifyAccessToken } from '../../utils/auth.js';
import { logger } from '../../config/logger.js';
import {
  addSocket,
  registerDevice,
  removeSocket,
  unregisterDevice,
  unregisterAllDevices,
} from './push.service.js';

const registerSchema = z.object({
  token: z.string().min(1).max(512),
  platform: z.string().max(32).default('android'),
});

export const pushRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Binds a device push token to the authenticated user. Re-registering the
  // same token is an idempotent upsert (the app re-registers on every
  // login, so duplicate rows would otherwise accumulate).
  app.post('/devices/register', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: 'Token de dispositivo inválido.' },
      });
    }
    try {
      await registerDevice(
        request.user!.id,
        parsed.data.token,
        parsed.data.platform,
      );
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Removes ONE device token (owned by the caller). Logout uses this; an
  // idempotent no-op for a token that is already gone.
  app.delete('/devices/:token', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      await unregisterDevice(request.user!.id, token);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Drops every token of the caller (e.g. "log out of all devices").
  app.delete('/devices', { onRequest: [app.authenticate] }, async (request, reply) => {
    try {
      await unregisterAllDevices(request.user!.id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Realtime push channel (WebSocket). Auth: access token in the query
  // string (WS handshake has no header support on some Android clients).
  // Each frame is a JSON PushMessage; the socket is dropped on close.
  app.get('/push/stream', { websocket: true }, (socket, request) => {
    const { token } = request.query as { token?: string };
    let userId: string;
    try {
      userId = verifyAccessToken(token ?? '').sub;
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    addSocket(userId, socket);
    socket.on('close', () => removeSocket(userId, socket));
    socket.on('error', (err: unknown) => {
      logger.warn({ err }, 'push socket error');
      removeSocket(userId, socket);
    });
  });
};
