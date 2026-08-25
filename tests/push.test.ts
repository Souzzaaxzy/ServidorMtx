import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';
import {
  addSocket,
  buildMessage,
  composeBody,
  dispatchNotification,
  removeSocket,
  socketsOf,
} from '../src/modules/push/push.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Push message composition', () => {
  it('renders the canonical PT-BR body for each notification type', () => {
    expect(composeBody('LIKE', 'joao')).toBe('@joao curtiu sua publicação.');
    expect(composeBody('COMMENT', 'joao')).toBe('@joao comentou na sua publicação.');
    expect(composeBody('FRIEND_REQUEST', 'joao')).toBe(
      '@joao enviou uma solicitação de amizade.',
    );
    expect(composeBody('FRIEND_ACCEPTED', 'joao')).toBe('Agora você e @joao são amigos.');
  });

  it('buildMessage embeds routing data for the client', () => {
    const message = buildMessage(
      { id: 'n1', type: 'LIKE', postId: 'p9', commentId: null, friendRequestId: null },
      'joao',
    );
    expect(message.kind).toBe('notification');
    expect(message.title).toBe('MATRIX');
    expect(message.data.postId).toBe('p9');
    expect(JSON.stringify(message)).toContain('p9');
  });
});

describe('Realtime socket hub', () => {
  it('tracks sockets per user and resets on remove', () => {
    const socket = { send: vi.fn() };
    addSocket('u-test-hub-1', socket);
    expect(socketsOf('u-test-hub-1')).toBe(1);
    removeSocket('u-test-hub-1', socket);
    expect(socketsOf('u-test-hub-1')).toBe(0);
  });
});

describe('Device token endpoints', () => {
  it('registers and unregisters a device token (upsert is idempotent)', async () => {
    const user = await createAndLoginUser(server, { username: 'devreg' });

    for (let i = 0; i < 2; i += 1) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/devices/register',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { token: 'tok-123', platform: 'android' },
      });
      expect(res.statusCode).toBe(204);
    }

    const rows = await prisma.device.findMany({ where: { token: 'tok-123' } });
    expect(rows).toHaveLength(1);

    const del = await server.inject({
      method: 'DELETE',
      url: '/api/devices/tok-123',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.device.count({ where: { token: 'tok-123' } })).toBe(0);
  });

  it('SECURITY: cannot unregister a token owned by another user (403)', async () => {
    const owner = await createAndLoginUser(server, { username: 'tok_owner' });
    const other = await createAndLoginUser(server, { username: 'tok_thief' });

    await server.inject({
      method: 'POST',
      url: '/api/devices/register',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { token: 'tok-owner-1' },
    });

    const del = await server.inject({
      method: 'DELETE',
      url: '/api/devices/tok-owner-1',
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(del.statusCode).toBe(403);
    expect(await prisma.device.count({ where: { token: 'tok-owner-1' } })).toBe(1);
  });

  it('rejects a device registration without a token (400)', async () => {
    const user = await createAndLoginUser(server, { username: 'devbadreq' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/devices/register',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { platform: 'android' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication on device routes (401)', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/devices/register' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Dispatch pipeline', () => {
  it('sends the message to every live socket of the recipient', async () => {
    const socketA = { send: vi.fn() };
    const socketB = { send: vi.fn() };
    const userIds = ['dispatch-u1'];
    socketsOf(userIds[0]);
    addSocket(userIds[0], socketA);
    addSocket(userIds[0], socketB);
    try {
      const sent = await dispatchNotification(userIds[0], {
        id: 'note-live-1',
        actorId: 'actor-does-not-exist-here-but-ok',
        type: 'LIKE',
        postId: 'p1',
        commentId: null,
        friendRequestId: null,
      });
      expect(sent).toBe(true);
      for (const socket of [socketA, socketB]) {
        expect(socket.send).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(socket.send.mock.calls[0][0] as string);
        expect(parsed.body).toContain('curtiu sua publicação');
      }
    } finally {
      removeSocket(userIds[0], socketA);
      removeSocket(userIds[0], socketB);
    }
  });

  it('dedupes: the same notification id is never dispatched twice', async () => {
    const socket = { send: vi.fn() };
    const userId = 'dispatch-dedupe';
    addSocket(userId, socket);
    const notification = {
      id: 'note-dedupe-42',
      actorId: 'some-actor',
      type: 'COMMENT',
      postId: 'p7',
      commentId: 'c9',
      friendRequestId: null,
    };
    expect(await dispatchNotification(userId, notification)).toBe(true);
    expect(await dispatchNotification(userId, notification)).toBe(false);
    expect(socket.send).toHaveBeenCalledTimes(1);
    removeSocket(userId, socket);
  });

});

describe('Unread badge endpoint', () => {
  it('returns only the unread number', async () => {
    const a = await createAndLoginUser(server, { username: 'badge_a' });
    const b = await createAndLoginUser(server, { username: 'badge_b' });
    const post = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { text: 'for badge' },
    });
    const postId = JSON.parse(post.payload).id as string;

    // b likes the post → a gets one unread LIKE notification.
    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/like`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/notifications/unread-count',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).unreadCount).toBe(1);
  });
});
