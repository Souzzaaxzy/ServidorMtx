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

describe('Groups', () => {
  it('creates a group and messages flow end-to-end', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'group_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'group_peer' });
    await makeFriends(owner, peer);

    // Create the group (POST /api/groups).
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: 'Matrix Crew',
        description: 'nosso grupo',
        participantIds: [peer.id],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const group = JSON.parse(createRes.payload).group;
    expect(group.group.name).toBe('Matrix Crew');

    // Owner posts a message;the response embeds the sender (app-shaped).
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'Bora!' },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = JSON.parse(sendRes.payload).message;
    expect(msg.content).toBe('Bora!');
    expect(msg.mine).toBe(true);
    expect(msg.sender.nickname).toBe('group_owner');

    // Peer list: unread badge + preview.

    const peerList = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const listed = JSON.parse(peerList.payload).groups.find((g: { id: string }) => g.id === group.id);
    expect(listed.unreadCount).toBe(1);
    expect(listed.lastMessage.content).toBe('Bora!');

    // Peer reads the page (sender embedded, chronological).
    const pageRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(pageRes.statusCode).toBe(200);
    const page = JSON.parse(pageRes.payload);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].sender.nickname).toBe('group_owner');
    expect(page.hasMore).toBe(false);

    // Peer marks read; unread clears + badge endpoint.


    const readRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/read`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(readRes.statusCode).toBe(204);
    const unreadRes = await server.inject({
      method: 'GET',
      url: '/api/groups/unread-count',
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(JSON.parse(unreadRes.payload).unreadCount).toBe(0);

    // Peer replies while the owner has a live socket; a `chat_message`
    // frame with the group id and the OTHER user's sender row is delivered.,

    let msg2: { id: string };
    const ownerSocket = { send: vi.fn() };
    addSocket(owner.id, ownerSocket);
    try {
      const msg2Res = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/messages`,
        headers: { authorization: `Bearer ${peer.accessToken}` },
        payload: { content: 'E ai?' },
      });
      expect(msg2Res.statusCode).toBe(201);
      msg2 = JSON.parse(msg2Res.payload).message;
      expect(ownerSocket.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(ownerSocket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_message');
      expect(frame.data.groupId).toBe(group.id);
      expect(frame.data.message.sender.nickname).toBe('group_peer');
      expect(frame.data.message.mine).toBe(false);
    } finally {
      removeSocket(owner.id, ownerSocket);
    }

    // Typing/recording signals reach the other members sockets.



    const peerSocket = { send: vi.fn() };
    addSocket(peer.id, peerSocket);
    try {
      await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/typing`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { typing: true },
      });
      await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/recording`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { recording: true },
      });
      expect(peerSocket.send).toHaveBeenCalledTimes(2);
      const kinds = (peerSocket.send.mock.calls as Array<[string]>).map(
        (c) => JSON.parse(c[0]) as {
          kind: string;
          data: { groupId: string; userId?: string; nickname?: string | null; typing?: boolean; recording?: boolean };
        },
      );
      const typingFrame = kinds.find((k) => k.kind === 'chat_typing')!;
      const recordingFrame = kinds.find((k) => k.kind === 'chat_recording')!;
      expect(typingFrame.kind).toBe('chat_typing');
      expect(typingFrame.data.groupId).toBe(group.id);
      expect(typingFrame.data.userId).toBe(owner.id);
      expect(typingFrame.data.nickname).toBe('group_owner');
      expect(typingFrame.data.typing).toBe(true);
      expect(recordingFrame.kind).toBe('chat_recording');
      expect(recordingFrame.data.groupId).toBe(group.id);
      expect(recordingFrame.data.userId).toBe(owner.id);
      expect(recordingFrame.data.nickname).toBe('group_owner');
      expect(recordingFrame.data.recording).toBe(true);
    } finally {
      removeSocket(peer.id, peerSocket);
    }

    // Owner deletes the peer's reply for EVERYONE; owner's other devices
    // (registered socket) drop the bubble live too ((same frame as DM)..

    const ownerSocket2 = { send: vi.fn() };
    addSocket(owner.id, ownerSocket2);
    try {
      await server.inject({
        method: 'DELETE',
        url: `/api/groups/${group.id}/messages/${msg2.id}/everyone`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(ownerSocket2.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(ownerSocket2.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_message_deleted');
      expect(frame.data.messageId).toBe(msg2.id);
    } finally {
      removeSocket(owner.id, ownerSocket2);
    }

    // Delete FOR ME (peer's view) is idempotent.



    const hideRes = await server.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/messages/${msg.id}`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(hideRes.statusCode).toBe(204);

    // Hide THE GROUP FOR ME removes it only from the peer's list.



    const hideGroupRes = await server.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(hideGroupRes.statusCode).toBe(204);
    const peerListHidden = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const hiddenGroups = JSON.parse(peerListHidden.payload).groups.filter((g: { id: string }) => g.id === group.id);
    expect(hiddenGroups).toHaveLength(0);

    // Owner still sees the group (hide is per-user).
    const ownerList = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(JSON.parse(ownerList.payload).groups.some((g: { id: string }) => g.id === group.id)).toBe(true);
  });
});
