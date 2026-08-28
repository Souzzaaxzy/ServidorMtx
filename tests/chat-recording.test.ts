import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { addSocket, removeSocket } from '../src/modules/push/push.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

async function makeFriends(a: { id: string; accessToken: string }, b: { id: string; accessToken: string }) {
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
}

async function openConversation(a: { accessToken: string }, b: { id: string }) {
  const res = await server.inject({
    method: 'POST',
    url: `/api/conversations/${b.id}`,
    headers: { authorization: `Bearer ${a.accessToken}` },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.payload).conversation as { id: string };
}

describe('Chat — voice recording indicator (gravando áudio)', () => {
  it('signals recording start/stop to the peer with chat_recording frames', async () => {
    const a = await createAndLoginUser(server, { nickname: 'rec_a' });
    const b = await createAndLoginUser(server, { nickname: 'rec_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const socket = { send: vi.fn() };
    addSocket(b.id, socket);
    try {
      const start = await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/recording`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { typing: true },
      });
      expect(start.statusCode).toBe(204);

      const stop = await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/recording`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { typing: false },
      });
      expect(stop.statusCode).toBe(204);

      expect(socket.send).toHaveBeenCalledTimes(2);
      const startFrame = JSON.parse(socket.send.mock.calls[0][0] as string);
      expect(startFrame.kind).toBe('chat_recording');
      expect(startFrame.data).toEqual({ conversationId: conv.id, recording: true });
      const stopFrame = JSON.parse(socket.send.mock.calls[1][0] as string);
      expect(stopFrame.kind).toBe('chat_recording');
      expect(stopFrame.data).toEqual({ conversationId: conv.id, recording: false });
    } finally {
      removeSocket(b.id, socket);
    }
  });

  it('rejects invalid payload and unauthenticated calls', async () => {
    const a = await createAndLoginUser(server, { nickname: 'rec_inv_a' });
    const b = await createAndLoginUser(server, { nickname: 'rec_inv_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const invalid = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/recording`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { typing: 'yes' },
    });
    expect(invalid.statusCode).toBe(400);

    const unauth = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/recording`,
      payload: { typing: true },
    });
    expect(unauth.statusCode).toBe(401);
  });

  it('only conversation members can signal recording (403 for outsiders)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'rec_m1' });
    const b = await createAndLoginUser(server, { nickname: 'rec_m2' });
    const eve = await createAndLoginUser(server, { nickname: 'rec_m3' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    // Eve is a friend of A but NOT a member of the (A,B) conversation.

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/recording`,
      headers: { authorization: `Bearer ${eve.accessToken}` },
      payload: { typing: true },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});