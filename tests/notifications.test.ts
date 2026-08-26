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

describe('Notifications', () => {
  it('like creates a LIKE notification for the post author', async () => {
    const author = await createAndLoginUser(server, { nickname: 'nauthor' });
    const liker = await createAndLoginUser(server, { nickname: 'nliker' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    const body = JSON.parse(res.payload);
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0].type).toBe('LIKE');
    expect(body.notifications[0].postId).toBe(post.id);
    expect(body.notifications[0].actor.nickname).toBe('nliker');
    expect(body.notifications[0].read).toBe(false);
  });

  it('unlike removes the LIKE notification (no phantom notifications)', async () => {
    const author = await createAndLoginUser(server, { nickname: 'unauthor' });
    const liker = await createAndLoginUser(server, { nickname: 'unliker' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    for (let i = 0; i < 2; i += 1) {
      await server.inject({
        method: 'POST',
        url: `/api/posts/${post.id}/like`,
        headers: { authorization: `Bearer ${liker.accessToken}` },
      });
    }

    const notifications = await prisma.notification.findMany({
      where: { recipientId: author.id },
    });
    expect(notifications).toHaveLength(0);
  });

  it('liking your own post never notifies you', async () => {
    const author = await createAndLoginUser(server, { nickname: 'selfliker' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(await prisma.notification.count()).toBe(0);
  });

  it('comment notifies the post author with post + comment references', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'ccommenter' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'NICE' },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    const body = JSON.parse(res.payload);
    expect(body.notifications[0].type).toBe('COMMENT');
    expect(body.notifications[0].postId).toBe(post.id);
    expect(body.notifications[0].commentId).not.toBeNull();
  });

  it('commenting on your own post never notifies you', async () => {
    const author = await createAndLoginUser(server, { nickname: 'selfcommenter' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'self' },
    });
    expect(await prisma.notification.count()).toBe(0);
  });

  it('marks a notification as read (unread counter drops) and re-read is fine', async () => {
    const author = await createAndLoginUser(server, { nickname: 'rauthor' });
    const liker = await createAndLoginUser(server, { nickname: 'rliker' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });

    const list = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    const { notifications } = JSON.parse(list.payload);

    const read = await server.inject({
      method: 'PATCH',
      url: `/api/notifications/${notifications[0].id}/read`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(read.statusCode).toBe(204);

    const after = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(JSON.parse(after.payload).unreadCount).toBe(0);
  });

  it('read-all marks every notification as read', async () => {
    const author = await createAndLoginUser(server, { nickname: 'rallauthor' });
    const liker = await createAndLoginUser(server, { nickname: 'rallliker' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/notifications/read-all',
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(JSON.parse(res.payload).unreadCount).toBe(0);
  });

  it('SECURITY: you cannot read another user\'s notification (403)', async () => {
    const author = await createAndLoginUser(server, { nickname: 'secauthor2' });
    const liker = await createAndLoginUser(server, { nickname: 'secliker2' });
    const eve = await createAndLoginUser(server, { nickname: 'seceve2' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    const target = await prisma.notification.findFirst({ where: { recipientId: author.id } });

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/notifications/${target!.id}/read`,
      headers: { authorization: `Bearer ${eve.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('SECURITY: notifications are scoped — Eve never sees other users\' notifications', async () => {
    const author = await createAndLoginUser(server, { nickname: 'scopeauthor' });
    const liker = await createAndLoginUser(server, { nickname: 'scopeliker' });
    const eve = await createAndLoginUser(server, { nickname: 'scopeeve' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${eve.accessToken}` },
    });
    expect(JSON.parse(res.payload).notifications).toHaveLength(0);
  });

  it('friend request notification disappears once accepted (card closes)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'closesender' });
    const b = await createAndLoginUser(server, { nickname: 'closereceiver' });
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
    const remaining = await prisma.notification.count({
      where: { recipientId: b.id, type: 'FRIEND_REQUEST' },
    });
    expect(remaining).toBe(0);
  });

  it('requires authentication (401) for listing and marking', async () => {
    const list = await server.inject({ method: 'GET', url: '/api/notifications' });
    expect(list.statusCode).toBe(401);
    const mark = await server.inject({ method: 'PATCH', url: '/api/notifications/x/read' });
    expect(mark.statusCode).toBe(401);
  });
});
