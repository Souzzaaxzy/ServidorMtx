import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { grantXp, XpReason } from '../../gamification/xp.service.js';
import { grantCoins, CoinReason } from '../../gamification/coin.service.js';

// ── Staff admin panel (base) ───────────────────────────────────
// All routes here are protected by role authorization at the route layer.
// Knowing the URL is never enough — access is gated by USER/MODERATOR/
// ADMIN/OWNER roles resolved server-side from the session.

export async function listUsers() {
  return prisma.user.findMany({
    select: {
      id: true,
      name: true,
      username: true,
      role: true,
      avatarUrl: true,
      bio: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getUserStats(userId: string) {
  const [xpTx, coinTx, posts, badges] = await Promise.all([
    prisma.xpTransaction.aggregate({ where: { userId }, _sum: { amount: true } }),
    prisma.coinTransaction.aggregate({ where: { userId }, _sum: { amount: true } }),
    prisma.post.count({ where: { userId } }),
    prisma.userBadge.count({ where: { userId } }),
  ]);
  return {
    userId,
    totalXp: xpTx._sum.amount ?? 0,
    coinBalance: coinTx._sum.amount ?? 0,
    postCount: posts,
    badgeCount: badges,
  };
}

// Admin-granted XP. Always recorded with reason ADMIN_GRANT + a source
// identifying the admin, so the ledger is fully auditable.
export async function adminGrantXp(adminId: string, userId: string, amount: number, note = '') {
  if (amount === 0) throw ApiError.invalidRequest('Quantidade inválida.');
  const total = await grantXp({
    userId,
    amount,
    reason: XpReason.ADMIN_GRANT,
    source: `admin:${adminId}${note ? `:${note}` : ''}`,
  });
  return { userId, amount, totalXp: total };
}

export async function adminGrantCoins(adminId: string, userId: string, amount: number, note = '') {
  if (amount === 0) throw ApiError.invalidRequest('Quantidade inválida.');
  const balance = await grantCoins({
    userId,
    amount,
    type: amount > 0 ? 'ADMIN_GRANT' : 'ADMIN_REMOVE',
    reason: amount > 0 ? CoinReason.ADMIN_GRANT : CoinReason.ADMIN_REMOVE,
  });
  return { userId, amount, coinBalance: balance };
}

export async function setUserRole(adminId: string, userId: string, role: 'USER' | 'MODERATOR' | 'ADMIN' | 'OWNER') {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { role },
    select: { id: true, username: true, role: true },
  });
  return user;
}
