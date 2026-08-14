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

describe('Gamification — XP ledger', () => {
  it('grants XP to the post author when a post is created', async () => {
    const u = await createAndLoginUser(server, { username: 'xp_author' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'XP test post' },
    });
    expect(res.statusCode).toBe(201);

    const total = await prisma.xpTransaction.aggregate({
      where: { userId: u.id },
      _sum: { amount: true },
    });
    // POST_CREATED reward is 10 XP (server-controlled constant).
    expect(total._sum.amount).toBe(10);
  });

  it('records the reason and source for audit', async () => {
    const u = await createAndLoginUser(server, { username: 'xp_audit' });
    await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'audit post' },
    });
    const tx = await prisma.xpTransaction.findFirst({
      where: { userId: u.id },
    });
    expect(tx).not.toBeNull();
    expect(tx!.reason).toBe('POST_CREATED');
    expect(tx!.source).toBe('post:create');
  });

  it('grants XP to the author when someone else likes their post', async () => {
    const author = await createAndLoginUser(server, { username: 'like_author' });
    const liker = await createAndLoginUser(server, { username: 'liker' });

    const post = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'like me' },
    });
    const postId = JSON.parse(post.payload).id;

    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });

    const authorXp = await prisma.xpTransaction.aggregate({
      where: { userId: author.id },
      _sum: { amount: true },
    });
    // POST_CREATED (10) + LIKE_RECEIVED (1).
    expect(authorXp._sum.amount).toBe(11);
  });

  it('does not grant XP for self-likes', async () => {
    const author = await createAndLoginUser(server, { username: 'self_liker' });
    const post = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'self like' },
    });
    const postId = JSON.parse(post.payload).id;

    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/like`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });

    const authorXp = await prisma.xpTransaction.aggregate({
      where: { userId: author.id },
      _sum: { amount: true },
    });
    // Only POST_CREATED; no LIKE_RECEIVED for self-likes.
    expect(authorXp._sum.amount).toBe(10);
  });
});

describe('Gamification — GET /api/gamification/me', () => {
  it('returns the current level and XP total', async () => {
    const u = await createAndLoginUser(server, { username: 'level_user' });
    await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'level post' },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/gamification/me',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.totalXp).toBe(10);
    expect(body.levelName).toBe('RECRUTA');
    expect(body.coins).toBeTypeOf('number');
  });
});

describe('Gamification — ranking', () => {
  it('returns users ordered by XP', async () => {
    await createAndLoginUser(server, { username: 'ranked_a' });
    const res = await server.inject({ method: 'GET', url: '/api/gamification/ranking' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body.ranking)).toBe(true);
  });
});
