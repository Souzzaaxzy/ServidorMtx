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

  it('ban realtime: the banned user receives a chat_group_banned frame', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'banrt_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'banrt_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'RT Ban Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // The peer keeps an open socket on the group chat.
    const peerSocket = { send: vi.fn() };
    addSocket(peer.id, peerSocket);
    try {
      const banRes = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/members/${peer.id}/ban`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(banRes.statusCode).toBe(200);

      // The banned user's live socket MUST have received the kick frame.
      expect(peerSocket.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(peerSocket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_group_banned');
      expect(frame.data.groupId).toBe(group.id);
      expect(typeof frame.data.groupName).toBe('string');
    } finally {
      removeSocket(peer.id, peerSocket);
    }
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

  it('ban → re-add blocked (banned ≠ member), unban → active again, messages tagged banned', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'cycle_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'cycle_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Cycle Crew', participantIds: [peer.id] },
    });
    expect(createRes.statusCode).toBe(201);
    const group = JSON.parse(createRes.payload).group;

    // The peer sends a message BEFORE the ban — it must survive the ban and
    // be tagged as belonging to a currently-banned sender.
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: { content: 'mensagem pré-banimento' },
    });
    expect(sendRes.statusCode).toBe(201);
    const messageId = JSON.parse(sendRes.payload).message.id;
    expect(JSON.parse(sendRes.payload).message.sender.banned).toBe(false);

    // Owner bans the peer.
    const banRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/ban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(banRes.statusCode).toBe(200);
    expect(JSON.parse(banRes.payload).group.group.memberCount).toBe(1);

    // Group info: the peer is NOT in the active members and IS in
    // bannedMembers (state separation, history preserved).
    const infoRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(infoRes.statusCode).toBe(200);
    const info = JSON.parse(infoRes.payload);
    expect(info.group.memberCount).toBe(1);
    expect(info.members.some((m: { id: string }) => m.id === peer.id)).toBe(false);
    expect(info.bannedMembers.some((m: { id: string }) => m.id === peer.id)).toBe(true);

    // The pre-ban message is still readable and its sender is flagged banned.
    const pageRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const page = JSON.parse(pageRes.payload);
    const oldMessage = page.messages.find((m: { id: string }) => m.id === messageId);
    expect(oldMessage).toBeDefined();
    expect(oldMessage.sender.banned).toBe(true);

    // Attempting to re-add the BANNED peer must NOT say "já participa do
    // grupo" — the system must recognize the banned (non-active) state.
    const readdRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { userId: peer.id },
    });
    expect(readdRes.statusCode).toBe(400);
    const readdError = JSON.parse(readdRes.payload).error?.message ?? '';
    expect(readdError).toContain('banido');
    expect(readdError).not.toContain('já participa');

    // A NON-owner cannot unban.
    const outsider = await createAndLoginUser(server, { nickname: 'cycle_out' });
    const outsiderUnban = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/unban`,
      headers: { authorization: `Bearer ${outsider.accessToken}` } as never,
    });
    expect(outsiderUnban.statusCode).toBe(403);

    // Owner unbans → the peer is an ACTIVE member again.
    const unbanRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/unban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(unbanRes.statusCode).toBe(200);
    expect(JSON.parse(unbanRes.payload).group.group.memberCount).toBe(2);

    const afterInfo = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    })).payload);
    expect(afterInfo.members.some((m: { id: string }) => m.id === peer.id)).toBe(true);
    expect(afterInfo.bannedMembers).toHaveLength(0);

    // The same message now renders with banned=false again.
    const afterPage = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    })).payload);
    const afterOld = afterPage.messages.find((m: { id: string }) => m.id === messageId);
    expect(afterOld.sender.banned).toBe(false);

    // Unbanning a NON-banned member is rejected.
    const doubleUnban = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/unban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(doubleUnban.statusCode).toBe(400);

    // Re-adding the peer now (active member) yields the standard message.
    const readdActive = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { userId: peer.id },
    });
    expect(readdActive.statusCode).toBe(400);
    expect(JSON.parse(readdActive.payload).error?.message).toContain('já participa');
  });

  it('ban realtime broadcast carries bannedUserIds for other members', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'bw_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'bw_peer' });
    const watcher = await createAndLoginUser(server, { nickname: 'bw_watcher' });
    await makeFriends(owner, peer);
    await makeFriends(owner, watcher);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Broadcast Crew', participantIds: [peer.id, watcher.id] },
    });
    expect(createRes.statusCode).toBe(201);
    const group = JSON.parse(createRes.payload).group;

    const watcherSocket = { send: vi.fn() };
    addSocket(watcher.id, watcherSocket);
    try {
      const banRes = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/members/${peer.id}/ban`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(banRes.statusCode).toBe(200);

      // The OTHER member receives a chat_group_updated frame whose payload
      // lists the banned user id, so open screens can tag messages live.
      const frame = JSON.parse(watcherSocket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_group_updated');
      expect(frame.data.bannedUserIds).toEqual([peer.id]);
      expect(frame.data.group.memberCount).toBe(2); // owner + watcher
    } finally {
      removeSocket(watcher.id, watcherSocket);
    }
  });

  it('owner permanently deletes the group: members/messages/hides removed, everyone receives realtime, group rejects messages', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'delg_owner2' });
    const peer = await createAndLoginUser(server, { nickname: 'delg_peer2' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Delete Crew', participantIds: [peer.id] },
    });
    expect(createRes.statusCode).toBe(201);
    const group = JSON.parse(createRes.payload).group;

    // Some messages flow so deletion has rows to clean up.
    await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'mensagem do dono' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: { content: 'mensagem do membro' },
    });
    // Peer hides the group "para mim" → GroupHidden row must be cleaned too.
    await server.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });

    // Every participant keeps a live socket to receive the deletion frame.
    const ownerSocket = { send: vi.fn() };
    const peerSocket = { send: vi.fn() };
    addSocket(owner.id, ownerSocket);
    addSocket(peer.id, peerSocket);
    try {
      // A NON-owner (peer) cannot delete the group — forge-proof.
      const forbidden = await server.inject({
        method: 'DELETE',
        url: `/api/groups/${group.id}/permanent`,
        headers: { authorization: `Bearer ${peer.accessToken}` },
      });
      expect(forbidden.statusCode).toBe(403);

      // Owner deletes the group permanently.
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/groups/${group.id}/permanent`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(delRes.statusCode).toBe(204);

      // Group row is GONE — no stale re-listing. The info endpoint refuses
      // (403: membership is gone too / 404: row deleted — both prove the
      // group no longer exists for any member).
      const infoRes = await server.inject({
        method: 'GET',
        url: `/api/groups/${group.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(infoRes.statusCode).not.toBe(200);

      // Membership rows removed — the peer is no longer a member.
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/groups',
        headers: { authorization: `Bearer ${peer.accessToken}` },
      });
      const listed = JSON.parse(listRes.payload).groups;
      expect(listed.some((g: { id: string }) => g.id === group.id)).toBe(false);

      // The group can NEVER receive messages again (rejected: the group is
      // gone and the owner's membership was deleted too).
      const sendAfter = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/messages`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { content: 'depois da exclusão' },
      });
      expect(sendAfter.statusCode).not.toBe(201);

      // Every live participant's socket got the deletion frame (owner's own
      // other devices included).
      expect(ownerSocket.send).toHaveBeenCalledTimes(1);
      expect(peerSocket.send).toHaveBeenCalledTimes(1);
      const ownerFrame = JSON.parse(ownerSocket.send.mock.calls[0][0] as string);
      const peerFrame = JSON.parse(peerSocket.send.mock.calls[0][0] as string);
      expect(ownerFrame.kind).toBe('chat_group_deleted');
      expect(ownerFrame.data.groupId).toBe(group.id);
      expect(peerFrame.kind).toBe('chat_group_deleted');
      expect(peerFrame.data.groupId).toBe(group.id);
    } finally {
      removeSocket(owner.id, ownerSocket);
      removeSocket(peer.id, peerSocket);
    }
  });

  it('member leaves the group: removed for them, kept for others, realtime to both sides', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'leave_owner' });
    const member = await createAndLoginUser(server, { nickname: 'leave_member' });
    const other = await createAndLoginUser(server, { nickname: 'leave_other' });
    await makeFriends(owner, member);
    await makeFriends(owner, other);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Leave Crew', participantIds: [member.id, other.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const memberSocket = { send: vi.fn() };
    const otherSocket = { send: vi.fn() };
    addSocket(member.id, memberSocket);
    addSocket(other.id, otherSocket);
    try {
      // The OWNER cannot leave — leaving would orphan the group.
      const ownerLeave = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/leave`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(ownerLeave.statusCode).toBe(403);

      // Active member leaves successfully.
      const leaveRes = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/leave`,
        headers: { authorization: `Bearer ${member.accessToken}` },
      });
      expect(leaveRes.statusCode).toBe(204);

      // The leaving user is removed from the group and cannot message/read.
      const listMine = await server.inject({
        method: 'GET',
        url: '/api/groups',
        headers: { authorization: `Bearer ${member.accessToken}` },
      });
      const myList = JSON.parse(listMine.payload).groups;
      expect(myList.some((g: { id: string }) => g.id === group.id)).toBe(false);
      const sendAfter = await server.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/messages`,
        headers: { authorization: `Bearer ${member.accessToken}` },
        payload: { content: 'depois de sair' },
      });
      expect(sendAfter.statusCode).toBe(403);

      // The OTHER members still see the group.
      const listOther = await server.inject({
        method: 'GET',
        url: '/api/groups',
        headers: { authorization: `Bearer ${other.accessToken}` },
      });
      const otherList = JSON.parse(listOther.payload).groups;
      expect(otherList.some((g: { id: string }) => g.id === group.id)).toBe(true);

      // Realtime: the leaver's sockets get chat_group_deleted; the other
      // member gets the chat_group_updated refresh (fresh member count).
      expect(memberSocket.send).toHaveBeenCalledTimes(1);
      const memberFrame = JSON.parse(memberSocket.send.mock.calls[0][0] as string);
      expect(memberFrame.kind).toBe('chat_group_deleted');
      expect(memberFrame.data.groupId).toBe(group.id);
      const otherFrame = JSON.parse(otherSocket.send.mock.calls[0][0] as string);
      expect(otherFrame.kind).toBe('chat_group_updated');
      expect(otherFrame.data.group.memberCount).toBe(2); // owner + other
    } finally {
      removeSocket(member.id, memberSocket);
      removeSocket(other.id, otherSocket);
    }
  });

  it('leave is rejected for a user who is not an active member (banned)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'leave2_owner' });
    const member = await createAndLoginUser(server, { nickname: 'leave2_member' });
    await makeFriends(owner, member);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Leave2 Crew', participantIds: [member.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // The owner bans the member → they are no longer an ACTIVE member.
    const banRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${member.id}/ban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(banRes.statusCode).toBe(200);

    // A banned user cannot call "Sair do grupo".
    const leaveRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/leave`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(leaveRes.statusCode).toBe(403);
  });

  it('persists a group MEDIA message (image) with a reply reference and exposes it to peers', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'gmed_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'gmed_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Media Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const baseRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'base para foto' },
    });
    const baseId = JSON.parse(baseRes.payload).message.id;

    const mediaRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/media`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        kind: 'image',
        url: 'https://cdn.matrix.app/static/img1.png',
        replyToMessageId: baseId,
      },
    });
    expect(mediaRes.statusCode).toBe(201);
    const msg = JSON.parse(mediaRes.payload).message;
    expect(msg.type).toBe('image');
    expect(msg.imageUrl).toBe('https://cdn.matrix.app/static/img1.png');
    expect(msg.replyTo?.id).toBe(baseId);

    // The peer sees the image message (type + url).
    const page = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const found = JSON.parse(page.payload).messages.find(
      (m: { id: string }) => m.id === msg.id,
    );
    expect(found.type).toBe('image');
    expect(found.imageUrl).toBe('https://cdn.matrix.app/static/img1.png');
  });

  it('rejects group media sent by a NON-member (403) and invalid reply (400)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'gmed2_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'gmed2_peer' });
    const outsider = await createAndLoginUser(server, { nickname: 'gmed2_out' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Media2 Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // Outsider (not a member) cannot send media.
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/media`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { kind: 'image', url: 'https://cdn/x.png' },
    });
    expect(forbidden.statusCode).toBe(403);

    // Invalid reply target is rejected.
    const bad = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/media`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { kind: 'video', url: 'https://cdn/x.mp4', replyToMessageId: 'nao-existe' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('persists and resolves individual mentions (@user) with real user ids', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ment_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'ment_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Mention Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // Owner sends a message mentioning the peer by real id.
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @joao, olha isso!',
        mentionUserIds: [peer.id],
      },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = JSON.parse(sendRes.payload).message;
    expect(msg.mentioned).toBe(false); // owner view: not mentioned
    expect(msg.mentions).toHaveLength(1);
    expect(msg.mentions[0].userId).toBe(peer.id);
    expect(msg.mentions[0].nickname).toBe('ment_peer');

    // Peer view: the message resolves as `mentioned` (highlight).
    const pageRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const page = JSON.parse(pageRes.payload);
    const peerView = page.messages.find((m: { id: string }) => m.id === msg.id);
    expect(peerView.mentioned).toBe(true);
    expect(peerView.mentions.some((x: { userId: string }) => x.userId === peer.id)).toBe(true);
  });

  it('rejects a mention for a user who is NOT an active member of the group', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ment2_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'ment2_peer' });
    const outsider = await createAndLoginUser(server, { nickname: 'ment2_out' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Ment2 Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // outsider is not a member → mentioning them is refused server-side.
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @forasteiro!',
        mentionUserIds: [outsider.id],
      },
    });
    expect(sendRes.statusCode).toBe(400);

    // A NON-EXISTENT user is also refused.
    const badRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'oi', mentionUserIds: ['nao-existe'] },
    });
    expect(badRes.statusCode).toBe(400);
  });

  it('@todos is ONLY allowed for the owner; a common member forging it is rejected', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'all_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'all_peer' });
    const other = await createAndLoginUser(server, { nickname: 'all_other' });
    await makeFriends(owner, peer);
    await makeFriends(owner, other);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'All Crew', participantIds: [peer.id, other.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // Owner can send @todos.
    const okRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: '@todos olhem isso', mentionAll: true },
    });
    expect(okRes.statusCode).toBe(201);
    const msg = JSON.parse(okRes.payload).message;
    expect(msg.mentionAll).toBe(true);
    // For any member the viewer is "mentioned" by @todos.
    expect(msg.mentioned).toBe(true);

    // A COMMON member forging the payload is rejected by the SERVER.
    const forged = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: { content: '@todos hack', mentionAll: true },
    });
    expect(forged.statusCode).toBe(403);
  });

  // ── RANGE-ANCHORED mentions (selection-based) — the ONLY form a real
  // client sends. The server re-validates every range against the content
  // so a mention is NEVER inferred from "@nickname" text coincidence and a
  // forged payload is rejected before persisting anything. ──

  it('range-anchored @user mention persists with the exact token range', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'rng_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'rng_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Rng Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // "Oi @rng_peer, veja" → the "@rng_peer" token spans [3, 12).
    const content = 'Oi @rng_peer, veja';
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content,
        mentions: [{ userId: peer.id, start: 3, end: 12 }],
      },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = JSON.parse(sendRes.payload).message;
    expect(msg.mentions).toHaveLength(1);
    expect(msg.mentions[0].userId).toBe(peer.id);
    expect(msg.mentions[0].nickname).toBe('rng_peer');
    expect(msg.mentions[0].start).toBe(3);
    expect(msg.mentions[0].end).toBe(12);

    // The persisted row carries the range; the peer view resolves it too.
    const rows = await prisma.messageMention.findMany({
      where: { messageId: msg.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].rangeStart).toBe(3);
    expect(rows[0].rangeEnd).toBe(12);

    const pageRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const page = JSON.parse(pageRes.payload);
    const peerView = page.messages.find((m: { id: string }) => m.id === msg.id);
    expect(peerView.mentioned).toBe(true);
  });

  it('typing "@nickname" MANUALLY (no range) persists NO mention rows', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'man_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'man_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Man Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // The sender types "@man_peer" by hand — the payload has NO mentions.
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'Oi @man_peer, tudo bem?' },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = JSON.parse(sendRes.payload).message;
    expect(msg.mentions).toHaveLength(0);
    expect(msg.mentionAll).toBe(false);
    expect(msg.mentioned).toBe(false);
  });

  it('typing "@todos" MANUALLY (no range) does NOT create mentionAll', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'mat_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'mat_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Mat Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // The OWNER types @todos manually — still plain text (the server never
    // infers a mention from content).
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: '@todos atenção' },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = JSON.parse(sendRes.payload).message;
    expect(msg.mentions).toHaveLength(0);
    expect(msg.mentionAll).toBe(false);
  });

  it('rejects a range that does NOT match the nickname text (forged range)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'frg_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'frg_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Frg Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // The sender TYPES "@frg_peer" but claims a DIFFERENT (shorter) range —
    // the substring at [3, 6) is "@fr" not "@frg_peer" → rejected.
    const bad = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @frg_peer, veja',
        mentions: [{ userId: peer.id, start: 3, end: 6 }],
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a range pointing at a user NOT in the group', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'odt_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'odt_peer' });
    const outsider = await createAndLoginUser(server, { nickname: 'odt_out' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Odt Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const bad = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @odt_out!',
        mentions: [{ userId: outsider.id, start: 3, end: 11 }],
      },
    });
    expect(bad.statusCode).toBe(400);

    // A NON-EXISTENT user id is equally rejected.
    const none = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @fantasma',
        mentions: [{ userId: 'nao-existe', start: 3, end: 12 }],
      },
    });
    expect(none.statusCode).toBe(400);
  });

  it('rejects overlapping mention ranges (tampered payload)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ovr_owner' });
    const a = await createAndLoginUser(server, { nickname: 'ovr_a' });
    const b = await createAndLoginUser(server, { nickname: 'ovr_b' });
    await makeFriends(owner, a);
    await makeFriends(owner, b);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Ovr Crew', participantIds: [a.id, b.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const bad = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @ovr_a @ovr_b',
        mentions: [
          { userId: a.id, start: 3, end: 9 },
          // Overlaps the first range — a real client can never produce this.
          { userId: b.id, start: 8, end: 15 },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects mixing range mentions with legacy ids (tampered payload)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'mix_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'mix_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Mix Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const bad = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @mix_peer',
        mentions: [{ userId: peer.id, start: 3, end: 12 }],
        mentionUserIds: [peer.id],
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a range pointing at the SENDER (self-mention)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'slf_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'slf_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Slf Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const bad = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @slf_owner',
        mentions: [{ userId: owner.id, start: 3, end: 13 }],
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('@todos via RANGE works for the owner and is rejected for a member', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'rta_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'rta_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Rta Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // Owner selects @todos in the menu → a range-anchored all-mention.
    const ok = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: '@todos olhem',
        mentions: [{ all: true, start: 0, end: 6 }],
      },
    });
    expect(ok.statusCode).toBe(201);
    const msg = JSON.parse(ok.payload).message;
    expect(msg.mentionAll).toBe(true);
    expect(msg.mentions).toHaveLength(0); // @todos never rides inside mentions[]

    // A common member forging a range-anchored @todos is rejected.
    const forged = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: {
        content: '@todos hack',
        mentions: [{ all: true, start: 0, end: 6 }],
      },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('bans a mentioned user: older message ranges survive (history stays consistent)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'bnh_owner' });
    const peer = await createAndLoginUser(server, { nickname: 'bnh_peer' });
    await makeFriends(owner, peer);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Bnh Crew', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        content: 'Oi @bnh_peer',
        mentions: [{ userId: peer.id, start: 3, end: 12 }],
      },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = JSON.parse(sendRes.payload).message;

    // Owner bans the previously-mentioned peer.
    await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/members/${peer.id}/ban`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    // The historical message still resolves its mention reference (steady
    // history) — the range persists.
    const pageRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages?limit=10`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const page = JSON.parse(pageRes.payload);
    const hist = page.messages.find((m: { id: string }) => m.id === msg.id);
    expect(hist.mentions).toHaveLength(1);
    expect(hist.mentions[0].userId).toBe(peer.id);
    expect(hist.mentions[0].start).toBe(3);
    expect(hist.mentions[0].end).toBe(12);
  });

  it('Visto/Enviado: readers endpoint returns who read and who did not (sender-only full view)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'read_owner' });
    const a = await createAndLoginUser(server, { nickname: 'read_a' });
    const b = await createAndLoginUser(server, { nickname: 'read_b' });
    await makeFriends(owner, a);
    await makeFriends(owner, b);

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Read Crew', participantIds: [a.id, b.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    // Owner sends a message; A reads it (marks read via the read endpoint).
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'mensagem de teste' },
    });
    const msg = JSON.parse(sendRes.payload).message;

    await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/read`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    // The SENDER sees the full breakdown: A in VISTO, B in ENVIADO.
    const readersRes = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages/${msg.id}/readers`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(readersRes.statusCode).toBe(200);
    const readers = JSON.parse(readersRes.payload);
    expect(readers.read.map((r: { id: string }) => r.id)).toContain(a.id);
    expect(readers.unread.map((r: { id: string }) => r.id)).toContain(b.id);
    expect(readers.read.map((r: { id: string }) => r.id)).not.toContain(b.id);

    // A common member (B) only learns their OWN state, not the full list.
    const bView = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages/${msg.id}/readers`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const bReaders = JSON.parse(bView.payload);
    expect(bReaders.read.length + bReaders.unread.length).toBeLessThanOrEqual(1);
  });
});
