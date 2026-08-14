import { prisma } from '../config/prisma.js';
import type { CoinReason, CoinTransactionType } from '../generated/index.js';

// ── Matrix Coins ledger ────────────────────────────────────────
// Coins are a virtual currency tracked as an append-only ledger. The
// `matrix_coins` row holds a cached balance but the source of truth is the
// SUM of coin_transactions. The client can never mint coins — only the
// server, via this module, records movements and enforces non-negative
// balances on spends.

export interface GrantCoinsInput {
  userId: string;
  amount: number;
  type: CoinTransactionType;
  reason: CoinReason;
}

export async function grantCoins(input: GrantCoinsInput): Promise<number> {
  if (input.amount === 0) return await getCoinBalance(input.userId);

  if (input.amount < 0) {
    // Spend / remove: enforce a non-negative balance.
    const balance = await getCoinBalance(input.userId);
    if (balance + input.amount < 0) {
      throw new InsufficientCoinsError(balance, -input.amount);
    }
  }

  await prisma.coinTransaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      type: input.type,
      reason: input.reason,
    },
  });

  const newBalance = await getCoinBalance(input.userId);
  await prisma.matrixCoin.upsert({
    where: { userId: input.userId },
    update: { balance: newBalance },
    create: { userId: input.userId, balance: newBalance },
  });
  return newBalance;
}

export async function getCoinBalance(userId: string): Promise<number> {
  const result = await prisma.coinTransaction.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

export class InsufficientCoinsError extends Error {
  readonly balance: number;
  readonly needed: number;
  constructor(balance: number, needed: number) {
    super('Saldo insuficiente de Matrix Coins.');
    this.name = 'InsufficientCoinsError';
    this.balance = balance;
    this.needed = needed;
  }
}

export const COIN_REWARDS = {
  POST_CREATED: 5,
} as const;

export { CoinReason, CoinTransactionType } from '../generated/index.js';
