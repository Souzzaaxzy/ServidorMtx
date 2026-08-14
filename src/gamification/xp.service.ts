import { prisma } from '../config/prisma.js';
import type { XpReason } from '../generated/index.js';

// ── XP ledger ──────────────────────────────────────────────────
// XP is an append-only ledger. Every change is recorded as an
// XpTransaction row with its reason + source, so the full history is
// auditable and the current total is the SUM(amount). The client can never
// grant itself XP — only the server, via this module, decides the amount.

export interface GrantXpInput {
  userId: string;
  amount: number;
  reason: XpReason;
  source?: string;
}

export async function grantXp(input: GrantXpInput): Promise<number> {
  if (input.amount === 0) return await getXpTotal(input.userId);
  await prisma.xpTransaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      reason: input.reason,
      source: input.source ?? input.reason,
    },
  });
  return await getXpTotal(input.userId);
}

export async function getXpTotal(userId: string): Promise<number> {
  const result = await prisma.xpTransaction.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

export interface UserLevel {
  levelId: number;
  levelName: string;
  totalXp: number;
  currentLevelMin: number;
  nextLevelMin: number | null;
}

// Resolves a user's level from the cumulative XP total. Levels are defined
// in the `levels` table (RECRUTA → LENDA MATRIX). Seeded by migration.
export async function getUserLevel(userId: string): Promise<UserLevel> {
  const totalXp = await getXpTotal(userId);
  const levels = await prisma.level.findMany({ orderBy: { minXp: 'asc' } });
  let current = levels[0] ?? null;
  let next: (typeof levels)[number] | null = null;
  for (let i = 0; i < levels.length; i++) {
    if (totalXp >= levels[i].minXp) {
      current = levels[i];
      next = levels[i + 1] ?? null;
    }
  }
  return {
    levelId: current?.id ?? 0,
    levelName: current?.name ?? 'RECRUTA',
    totalXp,
    currentLevelMin: current?.minXp ?? 0,
    nextLevelMin: next?.minXp ?? null,
  };
}

export const XP_REWARDS = {
  POST_CREATED: 10,
  COMMENT_CREATED: 2,
  LIKE_RECEIVED: 1,
} as const;

export { XpReason } from '../generated/index.js';
