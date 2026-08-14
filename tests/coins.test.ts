import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { grantCoins, getCoinBalance, InsufficientCoinsError } from '../src/gamification/coin.service.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Matrix Coins ledger', () => {
  it('records every movement and the balance is the sum', async () => {
    const u = await createAndLoginUser(server, { username: 'coin_user' });

    await grantCoins({ userId: u.id, amount: 100, type: 'EARN', reason: 'ACHIEVEMENT' });
    await grantCoins({ userId: u.id, amount: 30, type: 'EARN', reason: 'REWARD' });
    await grantCoins({ userId: u.id, amount: -20, type: 'SPEND', reason: 'PURCHASE' });

    const balance = await getCoinBalance(u.id);
    expect(balance).toBe(110);

    const txs = await prisma.coinTransaction.findMany({
      where: { userId: u.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(txs).toHaveLength(3);
    expect(txs.map((t) => t.amount)).toEqual([100, 30, -20]);
  });

  it('refuses to overspend (non-negative balance)', async () => {
    const u = await createAndLoginUser(server, { username: 'overspend' });
    await grantCoins({ userId: u.id, amount: 50, type: 'EARN', reason: 'REWARD' });

    await expect(
      grantCoins({ userId: u.id, amount: -100, type: 'SPEND', reason: 'PURCHASE' }),
    ).rejects.toBeInstanceOf(InsufficientCoinsError);

    // Balance unchanged after a failed spend.
    expect(await getCoinBalance(u.id)).toBe(50);
  });

  it('grants coins when a post is created', async () => {
    const u = await createAndLoginUser(server, { username: 'coin_post' });
    await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'coin post' },
    });

    const balance = await getCoinBalance(u.id);
    // POST_CREATED coin reward is 5 (server-controlled).
    expect(balance).toBe(5);
  });
});
