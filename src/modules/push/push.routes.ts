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
import {
  registerConnection,
  setUserVisible,
  unregisterConnection,
} from '../presence/presence.service.js';

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
  //
  // This socket is ALSO the presence signal: a live connection means the app
  // is running. The client additionally reports foreground/background with
  // `{kind:'active'}` / `{kind:'away'}`, so "app in the background = offline"
  // holds without any heartbeat guessing.
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
    registerConnection(userId);
    socket.on('message', (raw: unknown) => {
      // Only the lifecycle frames are accepted here; anything else is noise
      // from a client we do not understand and is ignored (never an error).
      try {
        const parsed = JSON.parse(String(raw)) as { kind?: unknown };
        if (parsed.kind === 'away') setUserVisible(userId, false);
        else if (parsed.kind === 'active') setUserVisible(userId, true);
      } catch {
        // Not JSON: ignore.
      }
    });
    socket.on('close', () => {
      removeSocket(userId, socket);
      unregisterConnection(userId);
    });
    socket.on('error', (err: unknown) => {
      logger.warn({ err }, 'push socket error');
      removeSocket(userId, socket);
      unregisterConnection(userId);
    });
  });
};
