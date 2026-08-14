import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Games — server-validated rewards', () => {
  it('lists active games', async () => {
    await prisma.game.upsert({
      where: { slug: 'quiz_test' },
      update: {},
      create: { slug: 'quiz_test', name: 'Quiz', description: 'Test quiz', active: true },
    });
    const res = await server.inject({ method: 'GET', url: '/api/games' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).games.some((g: { slug: string }) => g.slug === 'quiz_test')).toBe(true);
  });

  it('starts a session and the server decides the payout', async () => {
    const u = await createAndLoginUser(server, { username: 'gamer' });
    await prisma.game.upsert({
      where: { slug: 'quiz_payout' },
      update: {},
      create: { slug: 'quiz_payout', name: 'Quiz', description: '', active: true },
    });

    const start = await server.inject({
      method: 'POST',
      url: '/api/games/quiz_payout/sessions',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(start.statusCode).toBe(201);
    const sessionId = JSON.parse(start.payload).session.id;

    const finish = await server.inject({
      method: 'POST',
      url: `/api/games/sessions/${sessionId}/finish`,
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { score: 1000 },
    });
    expect(finish.statusCode).toBe(200);
    const result = JSON.parse(finish.payload).result;
    // The client cannot choose the payout — the server computes it from score.
    expect(result.xpAwarded).toBeGreaterThan(0);
    expect(result.coinAwarded).toBeGreaterThan(0);

    // The reward was actually granted through the auditable ledgers.
    const xpTotal = await prisma.xpTransaction.aggregate({
      where: { userId: u.id, reason: 'GAME_REWARD' },
      _sum: { amount: true },
    });
    expect(xpTotal._sum.amount).toBe(result.xpAwarded);
  });

  it('rejects finishing a session that belongs to another user', async () => {
    const owner = await createAndLoginUser(server, { username: 'session_owner' });
    const other = await createAndLoginUser(server, { username: 'session_other' });
    await prisma.game.upsert({
      where: { slug: 'quiz_ownership' },
      update: {},
      create: { slug: 'quiz_ownership', name: 'Quiz', description: '', active: true },
    });

    const start = await server.inject({
      method: 'POST',
      url: '/api/games/quiz_ownership/sessions',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const sessionId = JSON.parse(start.payload).session.id;

    const finish = await server.inject({
      method: 'POST',
      url: `/api/games/sessions/${sessionId}/finish`,
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { score: 100 },
    });
    expect(finish.statusCode).toBe(403);
  });

  it('does not double-grant when finishing twice', async () => {
    const u = await createAndLoginUser(server, { username: 'double_finish' });
    await prisma.game.upsert({
      where: { slug: 'quiz_double' },
      update: {},
      create: { slug: 'quiz_double', name: 'Quiz', description: '', active: true },
    });
    const start = await server.inject({
      method: 'POST',
      url: '/api/games/quiz_double/sessions',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    const sessionId = JSON.parse(start.payload).session.id;

    await server.inject({
      method: 'POST',
      url: `/api/games/sessions/${sessionId}/finish`,
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { score: 500 },
    });
    const second = await server.inject({
      method: 'POST',
      url: `/api/games/sessions/${sessionId}/finish`,
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { score: 999 },
    });
    // Second finish returns the original (idempotent), no extra reward.
    const xpTotal = await prisma.xpTransaction.aggregate({
      where: { userId: u.id, reason: 'GAME_REWARD' },
      _sum: { amount: true },
    });
    expect(second.statusCode).toBe(200);
    expect(xpTotal._sum.amount).toBe(JSON.parse(second.payload).result.xpAwarded);
  });
});
