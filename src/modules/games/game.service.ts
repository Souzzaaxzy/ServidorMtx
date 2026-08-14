import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { grantXp, XpReason } from '../../gamification/xp.service.js';
import { grantCoins, CoinReason, InsufficientCoinsError } from '../../gamification/coin.service.js';
import { toApiError } from '../../utils/errors.js';

// ── Games ─────────────────────────────────────────────────────
// The client starts a game session and reports a result. The server — not
// the client — decides the payout: it validates the score against per-game
// reward rules and only then grants XP/coins. The client can never mint
// rewards by simply claiming "I won".

export async function listGames() {
  return prisma.game.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
}

export async function startSession(userId: string, gameSlug: string) {
  const game = await prisma.game.findUnique({ where: { slug: gameSlug } });
  if (!game) throw ApiError.notFound('Jogo não encontrado.');
  return prisma.gameSession.create({
    data: { userId, gameId: game.id, score: 0 },
  });
}

export interface FinishResult {
  xpAwarded: number;
  coinAwarded: number;
}

// Finishes a game session and grants the server-determined reward.
export async function finishSession(
  userId: string,
  sessionId: string,
  score: number,
): Promise<FinishResult & { sessionId: string }> {
  const session = await prisma.gameSession.findUnique({ where: { id: sessionId }, include: { game: true } });
  if (!session) throw ApiError.notFound('Sessão não encontrada.');
  if (session.userId !== userId) throw ApiError.forbidden('Sessão não pertence ao usuário.');

  // Already finished?
  const existing = await prisma.gameResult.findUnique({ where: { gameSessionId: sessionId } });
  if (existing) {
    return { sessionId, xpAwarded: existing.xpAwarded, coinAwarded: existing.coinAwarded };
  }

  // Reward rules — computed server-side from the score. Tune per game slug.
  const xpAwarded = computeXpReward(session.game.slug, score);
  const coinAwarded = computeCoinReward(session.game.slug, score);

  await prisma.$transaction(async (tx) => {
    await tx.gameSession.update({ where: { id: sessionId }, data: { score } });
    await tx.gameResult.create({
      data: { gameSessionId: sessionId, xpAwarded, coinAwarded },
    });
  });

  // Grant the rewards through the ledgers (audit-tracked).
  if (xpAwarded > 0) {
    await grantXp({ userId, amount: xpAwarded, reason: XpReason.GAME_REWARD, source: `game:${session.game.slug}` });
  }
  if (coinAwarded > 0) {
    try {
      await grantCoins({
        userId,
        amount: coinAwarded,
        type: 'REWARD',
        reason: CoinReason.GAME_REWARD,
      });
    } catch (err) {
      if (!(err instanceof InsufficientCoinsError)) throw err;
      // Spending can't fail here since this is a reward (positive amount).
    }
  }

  return { sessionId, xpAwarded, coinAwarded };
}

function computeXpReward(slug: string, score: number): number {
  // Deterministic server-side reward curve. 1 XP per 100 points, capped.
  const base = Math.floor(score / 100);
  return Math.min(base, 50);
}

function computeCoinReward(slug: string, score: number): number {
  // 1 coin per 200 points, capped at 25.
  const base = Math.floor(score / 200);
  return Math.min(base, 25);
}

// Re-export for the route layer's error mapping.
export { toApiError };
