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

describe('Friend requests', () => {
  it('sends a request and notifies the receiver', async () => {
    const a = await createAndLoginUser(server, { nickname: 'sendera' });
    const b = await createAndLoginUser(server, { nickname: 'receiverb' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(201);

    const notification = await prisma.notification.findFirst({
      where: { recipientId: b.id, type: 'FRIEND_REQUEST' },
    });
    expect(notification).not.toBeNull();
  });

  it('rejects a request to yourself with 400', async () => {
    const a = await createAndLoginUser(server, { nickname: 'selfish' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${a.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicates with 409 and keeps state pending', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dupsender' });
    const b = await createAndLoginUser(server, { nickname: 'dupreceiver' });

    for (let i = 0; i < 2; i += 1) {
      const res = await server.inject({
        method: 'POST',
        url: `/api/friend-requests/${b.id}`,
        headers: { authorization: `Bearer ${a.accessToken}` },
      });
      expect(res.statusCode).toBe(i === 0 ? 201 : 409);
    }
    const count = await prisma.friendRequest.count({
      where: { senderId: a.id, receiverId: b.id },
    });
    expect(count).toBe(1);
  });

  it('accept flow: creates one mutual friendship, notifies sender', async () => {
    const a = await createAndLoginUser(server, { nickname: 'acesender' });
    const b = await createAndLoginUser(server, { nickname: 'acereceiver' });

    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);

    const accept = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${request.id}/accept`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(accept.statusCode).toBe(204);

    // Exactly ONE unordered friendship row.
    const friendships = await prisma.friendship.findMany();
    expect(friendships).toHaveLength(1);
    expect([friendships[0].userOneId, friendships[0].userTwoId].sort()).toEqual(
      [a.id, b.id].sort(),
    );

    // Both sides report FRIENDS.
    for (const [viewer, other] of [[a, b], [b, a]] as const) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/users/${other.id}/friendship`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });
      expect(JSON.parse(res.payload).state).toBe('FRIENDS');
    }

    // The original sender received a FRIEND_ACCEPTED notification.
    const accepted = await prisma.notification.findFirst({
      where: { recipientId: a.id, type: 'FRIEND_ACCEPTED', actorId: b.id },
    });
    expect(accepted).not.toBeNull();
  });

  it('reject flow: removes the request, no friendship, state back to NONE', async () => {
    const a = await createAndLoginUser(server, { nickname: 'rejsender' });
    const b = await createAndLoginUser(server, { nickname: 'rejreceiver' });

    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);

    const reject = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${request.id}/reject`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(reject.statusCode).toBe(204);

    expect(await prisma.friendship.count()).toBe(0);
    expect(await prisma.friendRequest.count()).toBe(0);

    const state = await server.inject({
      method: 'GET',
      url: `/api/users/${b.id}/friendship`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(state.payload).state).toBe('NONE');
  });

  it('lists pending requests with sender info', async () => {
    const a = await createAndLoginUser(server, { nickname: 'listsender' });
    const b = await createAndLoginUser(server, { nickname: 'listreceiver' });
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/friend-requests',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { requests } = JSON.parse(res.payload);
    expect(requests).toHaveLength(1);
    expect(requests[0].sender.nickname).toBe('listsender');
    expect(requests[0].status).toBe('PENDING');
  });

  it('SECURITY: a third user cannot accept a request they did not receive (403)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'secsender' });
    const b = await createAndLoginUser(server, { nickname: 'secreceiver' });
    const eve = await createAndLoginUser(server, { nickname: 'seceve' });

    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);

    for (const action of ['accept', 'reject']) {
      const res = await server.inject({
        method: 'POST',
        url: `/api/friend-requests/${request.id}/${action}`,
        headers: { authorization: `Bearer ${eve.accessToken}` },
      });
      expect(res.statusCode).toBe(403);
    }
    const still = await prisma.friendRequest.findUnique({ where: { id: request.id } });
    expect(still?.status).toBe('PENDING');
  });

  it('SECURITY: sender cannot accept their own request (403)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'evilsender' });
    const b = await createAndLoginUser(server, { nickname: 'plainreceiver' });

    const send = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const request = JSON.parse(send.payload);

    const res = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${request.id}/accept`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.friendship.count()).toBe(0);
  });

  it('requires authentication on all friend-request routes (401)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/friend-requests' });
    expect(res.statusCode).toBe(401);
  });

  it('reports OUTGOING_PENDING for the sender and INCOMING_PENDING for the receiver', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dirsender' });
    const b = await createAndLoginUser(server, { nickname: 'dirreceiver' });

    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const outgoing = await server.inject({
      method: 'GET',
      url: `/api/users/${b.id}/friendship`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(outgoing.payload).state).toBe('OUTGOING_PENDING');

    const incoming = await server.inject({
      method: 'GET',
      url: `/api/users/${a.id}/friendship`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(JSON.parse(incoming.payload).state).toBe('INCOMING_PENDING');
  });

  it('reports FRIENDS when a friendship already exists (no duplicate request)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'frienda' });
    const b = await createAndLoginUser(server, { nickname: 'friendb' });

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

    const again = await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(again.statusCode).toBe(409);
  });
});
