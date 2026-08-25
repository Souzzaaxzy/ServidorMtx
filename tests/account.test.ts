import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../src/config/prisma.js';
import {
  buildTestServer,
  closeTestServer,
  createAndLoginUser,
} from './helpers.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Account — DELETE /api/auth/account', () => {
  it('removes the user AND cascades owned rows (posts/comments/likes/…)', async () => {
    const owner = await createAndLoginUser(server, { username: 'del_owner' });
    const actor = await createAndLoginUser(server, { username: 'del_actor' });

    const post = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { text: 'will be deleted' },
    });
    const postId = JSON.parse(post.payload).id as string;

    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload: { text: 'a comment' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/devices/register',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { token: 'del-owner-device', platform: 'android' },
    });

    const res = await server.inject({
      method: 'DELETE',
      url: '/api/auth/account',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    expect(await prisma.user.findUnique({ where: { id: owner.id } })).toBeNull();
    expect(await prisma.post.count({ where: { userId: owner.id } })).toBe(0);
    expect(await prisma.comment.count({ where: { postId } })).toBe(0);
    expect(await prisma.device.count({ where: { userId: owner.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: owner.id } })).toBe(0);
  });

  it('never lets a deleted account authenticate again', async () => {
    const user = await createAndLoginUser(server, { username: 'del_login' });
    await server.inject({
      method: 'DELETE',
      url: '/api/auth/account',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'del_login', password: user.password },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated deletion with 401', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/api/auth/account' });
    expect(res.statusCode).toBe(401);
  });

  it('removes friendships and notifications tied to the deleted user', async () => {
    const a = await createAndLoginUser(server, { username: 'del_a' });
    const b = await createAndLoginUser(server, { username: 'del_b' });

    // b sends a friend request to a, a accepts → friendship + notifications.
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${a.id}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const reqs = await server.inject({
      method: 'GET',
      url: '/api/friend-requests',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const requestId = JSON.parse(reqs.payload).requests[0].id as string;
    const accept = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${requestId}/accept`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(accept.statusCode).toBe(204);

    expect(await prisma.friendship.count({
      where: { OR: [{ userOneId: a.id }, { userTwoId: a.id }] },
    })).toBe(1);

    await server.inject({
      method: 'DELETE',
      url: '/api/auth/account',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    // Friendship + notifications of the deleted account disappear too; the
    // other user remains intact.
    expect(await prisma.friendship.count({
      where: { OR: [{ userOneId: a.id }, { userTwoId: a.id }] },
    })).toBe(0);
    expect(await prisma.notification.count({
      where: { OR: [{ recipientId: a.id }, { actorId: a.id }] },
    })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: b.id } })).not.toBeNull();
  });
});
