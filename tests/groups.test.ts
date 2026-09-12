import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';
import { addSocket, removeSocket } from '../src/modules/push/push.service.js';

function m4aFixture(): Buffer {
  const box = Buffer.alloc(28);
  box.writeUInt32BE(28, 0);
  box.write('ftyp', 4, 'latin1');
  box.write('M4A ', 8, 'latin1');
  box.writeUInt32BE(0, 12);
  box.write('M4A ', 16, 'latin1');
  box.write('mp42', 20, 'latin1');
  box.write('isom', 24, 'latin1');
  return box;
}



function multipartBody(fileBytes: Buffer, filename: string): Buffer {
  const boundary = '----matrix-group-test-boundary-9f4a';
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; ' +
      `filename="${filename}"\r\n` +
      'Content-Type: audio/mp4\r\n\r\n',
    'utf8',
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([preamble, fileBytes, epilogue]);
}

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

  it('persists a group VOICE reply with replyToMessageId reference', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'gvox_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'gvox_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Voice Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const baseRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'base mensagem' },
    });
    const baseId = JSON.parse(baseRes.payload as string).message.id as string;

    const audio = m4aFixture();
    const res = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/voice?durationMs=3000&replyToMessageId=${baseId}`,
      headers: {
        authorization: `Bearer ${peer.accessToken}`,
        'content-type': 'multipart/form-data; boundary=----matrix-group-test-boundary-9f4a',
      },
      payload: multipartBody(audio, 'group_reply.m4a'),
    });
    expect(res.statusCode).toBe(201);
    const msg = JSON.parse(res.payload as string).message as {
      id: string;
      type: string;
      replyTo: { id: string; exists: boolean } | null;
    };
    expect(msg.type).toBe('voice');
    expect(msg.replyTo?.id).toBe(baseId);
    expect(msg.replyTo?.exists).toBe(true);

    const stored = await prisma.message.findUnique({
      where: { id: msg.id },
      select: { replyToMessageId: true },
    });
    expect(stored?.replyToMessageId).toBe(baseId);

    const pageRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=20`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const page = JSON.parse(pageRes.payload as string);
    const reply = page.messages.find((m: { id: string }) => m.id === msg.id);
    expect(reply.replyTo?.id).toBe(baseId);
    expect(reply.replyTo?.senderNickname).toBe('gvox_owner');
    expect(reply.type).toBe('voice');

    const otherGroup = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Other Crew', participantIds: [peer.id] },
    });
    expect(otherGroup.statusCode).toBe(201);
    const otherGroupId = JSON.parse(otherGroup.payload).group.id;
    const badRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${otherGroupId}/voice?durationMs=3000&replyToMessageId=${baseId}`,
      headers: {
        authorization: `Bearer ${peer.accessToken}`,
        'content-type': 'multipart/form-data; boundary=----matrix-group-test-boundary-9f4a',
      },
      payload: multipartBody(audio, 'bad_reply.m4a'),
    });
    expect(badRes.statusCode).toBe(400);
  });

  it('owner bans a member: access and messaging are revoked, owner is immune', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ban_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'ban_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Ban Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // Owner bans the peer.
    const banRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/ban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(banRes.statusCode).toBe(200);

    // Banned member loses access: cannot list, read messages or send.
    const peerList = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const listed = JSON.parse(peerList.payload).groups.filter((g: { id: string }) => g.id === group.id);
    expect(listed).toHaveLength(0);

    const peerRead = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(peerRead.statusCode).toBe(403);

    const peerSend = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: { content: 'tentando' },
    });
    expect(peerSend.statusCode).toBe(403);

    // A NON-owner cannot ban (server re-validates).
    const other = await createAndLoginUser(server, { nickname: 'ban_other' });
    const otherBan = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/ban`,
      headers: { authorization: `Bearer ${other.accessToken}` } as never,
    });
    expect(otherBan.statusCode).toBe(403);

    // The OWNER can never be banned (even by a forged/other owner attempt).
    const ownerBan = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${owner.id}/ban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(ownerBan.statusCode).toBe(400);

    // The owner still sees the groupand can message normally.
    const ownerList = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(JSON.parse(ownerList.payload).groups.some((g: { id: string }) => g.id === group.id)).toBe(true);
  });

  it('group message deletion permissions: member cannot delete others, owner can, everyone receives realtime', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'delg_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'delg_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Del Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // The peer sends a message.
    const peerMsg = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: { content: 'mensagem do peer' },
    });
    const peerMessageId = JSON.parse(peerMsg.payload).message.id;

    // A NON-owner COMMON member cannot delete another member's message
    // FOR EVERYONE (server re-validates the sender/owner).
    const other = await createAndLoginUser(server, { nickname: 'delg_other' });
    await makeFriends(owner, other);
    await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { userId: other.id },
    });
    const forbidden = await server.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/messages/${peerMessageId}/everyone`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    // The owner CAN delete another member's message FOR EVERYONE. The
    // broadcast reaches BOTH the peer and the owner's other sockets.

    const peerSocket = { send: vi.fn() };
    addSocket(peer.id, peerSocket);
    const ownerSocket2 = { send: vi.fn() };
    addSocket(owner.id, ownerSocket2);
    try {
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/groups/${group.id}/messages/${peerMessageId}/everyone`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(delRes.statusCode).toBe(204);

      for (const socket of [peerSocket, ownerSocket2]) {
        expect(socket.send).toHaveBeenCalledTimes(1);
        const frame = JSON.parse(socket.send.mock.calls[0][0] as string);
        expect(frame.kind).toBe('chat_message_deleted');
        expect(frame.data.messageId).toBe(peerMessageId);
      }
    } finally {
      removeSocket(peer.id, peerSocket);
      removeSocket(owner.id, ownerSocket2);
    }

    // A member may delete their OWN message for everyone (no owner needed).
    const peerSend2 = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: { content: 'própria mensagem' },
    });
    const peerOwnId = JSON.parse(peerSend2.payload).message.id;
    const peerOwnDel = await server.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/messages/${peerOwnId}/everyone`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(peerOwnDel.statusCode).toBe(204);
  });
});
