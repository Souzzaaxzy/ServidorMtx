import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError } from '../../utils/errors.js';
import { listUsers, getUserStats, adminGrantXp, adminGrantCoins, setUserRole } from './admin.service.js';

// Staff admin routes — every route chains authenticate + requireRole so a
// URL alone never grants access.
//   GET    /admin/users
//   GET    /admin/users/:id/stats
//   POST   /admin/users/:id/xp
//   POST   /admin/users/:id/coins
//   PATCH  /admin/users/:id/role
export const adminRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const staff = [app.authenticate, app.requireRole('MODERATOR', 'ADMIN', 'OWNER')];
  const adminOnly = [app.authenticate, app.requireRole('ADMIN', 'OWNER')];

  app.get('/admin/users', { onRequest: staff }, async (_request, reply) => {
    const users = await listUsers();
    return reply.send({ users });
  });

  app.get('/admin/users/:id/stats', { onRequest: staff }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const stats = await getUserStats(id);
    return reply.send({ stats });
  });

  app.post('/admin/users/:id/xp', { onRequest: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { amount?: number; note?: string };
    if (typeof body.amount !== 'number') throw ApiError.invalidRequest('amount obrigatório.');
    const result = await adminGrantXp(request.user!.id, id, body.amount, body.note);
    return reply.send({ result });
  });

  app.post('/admin/users/:id/coins', { onRequest: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { amount?: number; note?: string };
    if (typeof body.amount !== 'number') throw ApiError.invalidRequest('amount obrigatório.');
    const result = await adminGrantCoins(request.user!.id, id, body.amount, body.note);
    return reply.send({ result });
  });

  app.patch('/admin/users/:id/role', { onRequest: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { role?: 'USER' | 'MODERATOR' | 'ADMIN' | 'OWNER' };
    if (!body.role) throw ApiError.invalidRequest('role obrigatório.');
    const user = await setUserRole(request.user!.id, id, body.role);
    return reply.send({ user });
  });
};
