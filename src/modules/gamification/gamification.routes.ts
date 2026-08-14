import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { getUserLevel, getXpTotal } from '../../gamification/xp.service.js';
import { getCoinBalance } from '../../gamification/coin.service.js';

// Gamification routes (read-only public profile + own status).
//   GET /gamification/me           own full status (auth)
//   GET /gamification/ranking      top users by XP
export const gamificationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/gamification/me', { onRequest: [app.authenticate] }, async (request, reply) => {
    const userId = request.user!.id;
    const [level, coins, xp] = await Promise.all([
      getUserLevel(userId),
      getCoinBalance(userId),
      getXpTotal(userId),
    ]);
    return reply.send({ ...level, coins, xp });
  });

  app.get('/gamification/ranking', async (_request, reply) => {
    const rows = await prisma.xpTransaction.groupBy({
      by: ['userId'],
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 50,
    });
    const userIds = rows.map((r) => r.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, name: true, avatarUrl: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const ranking = rows.map((r, i) => {
      const u = userMap.get(r.userId);
      return {
        position: i + 1,
        userId: r.userId,
        username: u?.username ?? 'unknown',
        name: u?.name ?? '',
        avatarUrl: u?.avatarUrl ?? null,
        xp: r._sum.amount ?? 0,
      };
    });
    return reply.send({ ranking });
  });
};
