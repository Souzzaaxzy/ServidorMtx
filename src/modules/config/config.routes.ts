import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getPublicConfig, getAllConfig, setConfig } from './config.service.js';

// Dynamic config routes.
//   GET /api/config          public config (no auth)
//   GET /api/config/all      all config (admin only)
//   PUT /api/config/:key     set a config value (admin only)
export const configRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/config', async (_request, reply) => {
    const config = await getPublicConfig();
    return reply.send(config);
  });

  app.get('/config/all', { onRequest: [app.requireRole('ADMIN')] }, async (_request, reply) => {
    const config = await getAllConfig();
    return reply.send({ config });
  });

  app.put('/config/:key', { onRequest: [app.requireRole('ADMIN')] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = request.body as { value?: unknown; public?: boolean };
    const entry = await setConfig(key, body.value, body.public ?? false);
    return reply.send({ entry });
  });
};
