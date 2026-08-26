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

describe('Profile counters (Amigos / Posts)', () => {
  it('returns real postsCount and friendsCount for the viewed user', async () => {
    const a = await createAndLoginUser(server, { nickname: 'stats_a' });
    const b = await createAndLoginUser(server, { nickname: 'stats_b' });

    // a creates two posts so the counter must be 2.
    for (const text of ['post one', 'post two']) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/posts',
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { text },
      });
      expect(res.statusCode).toBe(201);
    }

    // a and b become friends (accepted request) → counter must be 1.
    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${request.id}/accept`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });

    const profile = await server.inject({
      method: 'GET',
      url: `/api/users/${a.nickname}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(profile.statusCode).toBe(200);
    const body = JSON.parse(profile.payload);
    expect(body.user.postsCount).toBe(2);
    expect(body.user.friendsCount).toBe(1);

    // From b's perspective the same numbers are reciprocal.
    const reverse = await server.inject({
      method: 'GET',
      url: '/api/users/stats_b',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const reverseBody = JSON.parse(reverse.payload);
    expect(reverseBody.user.friendsCount).toBe(1);
    expect(reverseBody.user.postsCount).toBe(0);
  });

  it('posts count drops after deleting a post', async () => {
    const a = await createAndLoginUser(server, { nickname: 'delcount' });
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { text: 'count me' },
    });
    const post = JSON.parse(createRes.payload);

    await server.inject({
      method: 'DELETE',
      url: `/api/posts/${post.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const profile = await server.inject({
      method: 'GET',
      url: '/api/users/delcount',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(profile.payload).user.postsCount).toBe(0);
  });

  it('pending friend requests do NOT count as friends', async () => {
    const a = await createAndLoginUser(server, { nickname: 'pending_a' });
    const b = await createAndLoginUser(server, { nickname: 'pending_b' });
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const profile = await server.inject({
      method: 'GET',
      url: '/api/users/pending_a',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(profile.payload).user.friendsCount).toBe(0);
  });
});

describe('Friends list endpoint', () => {
  it('lists accepted friends with real pagination data', async () => {
    const a = await createAndLoginUser(server, { nickname: 'fl_a' });
    const b = await createAndLoginUser(server, { nickname: 'fl_b' });
    const c = await createAndLoginUser(server, { nickname: 'fl_c' });

    for (const other of [b, c]) {
      const send = await server.inject({
        method: 'POST',
        url: `/api/friend-requests/${other.id}`,
        headers: { authorization: `Bearer ${a.accessToken}` },
      });
      const request = JSON.parse(send.payload);
      await server.inject({
        method: 'POST',
        url: `/api/friend-requests/${request.id}/accept`,
        headers: { authorization: `Bearer ${other.accessToken}` },
      });
    }

    const page1 = await server.inject({
      method: 'GET',
      url: `/api/users/${a.id}/friends?page=1&pageSize=1`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const p1 = JSON.parse(page1.payload);
    expect(p1.total).toBe(2);
    expect(p1.friends).toHaveLength(1);

    const page2 = await server.inject({
      method: 'GET',
      url: `/api/users/${a.id}/friends?page=2&pageSize=1`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const p2 = JSON.parse(page2.payload);
    expect(p2.friends).toHaveLength(1);

    // The two pages together must cover both friends, no matter the order.
    const nicknames = [p1.friends[0].nickname, p2.friends[0].nickname].sort();
    expect(nicknames).toEqual(['fl_b', 'fl_c']);
  });

  it('friend list of the OTHER user is visible (not limited to own list)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'vis_a' });
    const b = await createAndLoginUser(server, { nickname: 'vis_b' });
    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${request.id}/accept`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });

    // a views b's list — must contain a.
    const res = await server.inject({
      method: 'GET',
      url: `/api/users/${b.id}/friends`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const body = JSON.parse(res.payload);
    expect(body.friends.map((f: { nickname: string }) => f.nickname)).toContain('vis_a');
  });

  it('only accepted friendships appear (pending never leaks)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'clean_a' });
    const b = await createAndLoginUser(server, { nickname: 'clean_b' });
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/users/${a.id}/friends`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(res.payload).friends).toHaveLength(0);
  });
});

describe('Friend accept notifications (both sides)', () => {
  it('creates FRIEND_ACCEPTED for the sender AND the acceptor', async () => {
    const a = await createAndLoginUser(server, { nickname: 'both_a' });
    const b = await createAndLoginUser(server, { nickname: 'both_b' });
    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${request.id}/accept`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });

    // sender a is notified that b accepted.
    const forSender = await prisma.notification.findFirst({
      where: { recipientId: a.id, actorId: b.id, type: 'FRIEND_ACCEPTED' },
    });
    expect(forSender).not.toBeNull();

    // acceptor b ALSO gets a persistent entry about a.
    const forAcceptor = await prisma.notification.findFirst({
      where: { recipientId: b.id, actorId: a.id, type: 'FRIEND_ACCEPTED' },
    });
    expect(forAcceptor).not.toBeNull();

    // And the actionable FRIEND_REQUEST card is gone.
    const requestNotes = await prisma.notification.count({
      where: { friendRequestId: request.id },
    });
    expect(requestNotes).toBe(0);
  });
});
