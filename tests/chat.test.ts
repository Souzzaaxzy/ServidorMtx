import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
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

describe('Private chat', () => {
  it('T1+T2: friends A→B and B→A, both messages saved, conversation persists', async () => {
    const a = await createAndLoginUser(server, { nickname: 'leo_chat' });
    const b = await createAndLoginUser(server, { nickname: 'teste_chat' });
    await makeFriends(a, b);

    // A → B
    const convA = await openConversation(a, b);
    expect(convA.otherUser.nickname).toBe('teste_chat');

    const send1 = await server.inject({
      method: 'POST',
      url: `/api/conversations/${convA.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'Olá!' },
    });
    expect(send1.statusCode).toBe(201);
    const msg1 = JSON.parse(send1.payload).message;
    expect(msg1.content).toBe('Olá!');
    expect(msg1.mine).toBe(true);

    // B → A (same conversation id, exactly ONE conversation row)
    const convB = await openConversation(b, a);
    expect(convB.id).toBe(convA.id);
    const total = await prisma.conversation.count();
    expect(total).toBe(1);

    const send2 = await server.inject({
      method: 'POST',
      url: `/api/conversations/${convB.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { content: 'Oi!' },
    });
    expect(send2.statusCode).toBe(201);

    // messages persisted in the DB
    const stored = await prisma.message.findMany({
      where: { conversationId: convA.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(stored.map((m) => m.content)).toEqual(['Olá!', 'Oi!']);
    expect(stored.map((m) => m.senderId)).toEqual([a.id, b.id]);

    // listing shows the conversation from BOTH sides with last message
    for (const viewer of [a, b]) {
      const list = await server.inject({
        method: 'GET',
        url: '/api/conversations',
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });
      const { conversations } = JSON.parse(list.payload);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].lastMessage.content).toBe('Oi!');
    }
  });

  it('T3: conversations and messages persist after "logging out / back in" (fresh token, same user)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'persist_a' });
    const b = await createAndLoginUser(server, { nickname: 'persist_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'mensagem persistente' },
    });

    // Re-login (simulates closing the app and returning / logout+login).
    const relogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'persist_a', password: 'Password123' },
    });
    const body = JSON.parse(relogin.payload);
    const list = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    const { conversations } = JSON.parse(list.payload);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].lastMessage.content).toBe('mensagem persistente');

    const msgs = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(JSON.parse(msgs.payload).messages).toHaveLength(1);
  });

  it('REGRAS: open conversation with a NON-friend is forbidden (403)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'nofriend_a' });
    const b = await createAndLoginUser(server, { nickname: 'nofriend_b' });
    const res = await server.inject({
      method: 'POST',
      url: `/api/conversations/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.message).toContain('amigos');
    expect(await prisma.conversation.count()).toBe(0);
  });

  it('SECURITY: cannot talk to yourself (400), cannot open nonexistent conversation (404)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'self_chat' });
    const self = await server.inject({
      method: 'POST',
      url: `/api/conversations/${a.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(self.statusCode).toBe(400);

    const missing = await server.inject({
      method: 'GET',
      url: '/api/conversations/does-not-exist/messages',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('SECURITY: a third user cannot read or send in a conversation they do not belong to', async () => {
    const a = await createAndLoginUser(server, { nickname: 'sec_chat_a' });
    const b = await createAndLoginUser(server, { nickname: 'sec_chat_b' });
    const eve = await createAndLoginUser(server, { nickname: 'sec_chat_eve' });
    await makeFriends(a, b);
    await makeFriends(eve, b);
    const conv = await openConversation(a, b);

    // eve -- not a member of conv (a,b) -- cannot read it
    const read = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${eve.accessToken}` },
    });
    expect(read.statusCode).toBe(403);

    // eve cannot send either
    const write = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${eve.accessToken}` },
      payload: { content: 'intrusão' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('SECURITY: sender is always derived from the token — never from the body', async () => {
    const a = await createAndLoginUser(server, { nickname: 'sender_a' });
    const b = await createAndLoginUser(server, { nickname: 'sender_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const res = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      // tries to impersonate b via body.senderId → ignored
      payload: { content: 'oi', senderId: b.id },
    });
    expect(res.statusCode).toBe(201);
    const stored = await prisma.message.findFirst({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored?.senderId).toBe(a.id);
  });

  it('rejects empty / whitespace-only messages (400) and enforces the 4000 limit', async () => {
    const a = await createAndLoginUser(server, { nickname: 'empty_chat_a' });
    const b = await createAndLoginUser(server, { nickname: 'empty_chat_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const empty = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const tooLong = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'x'.repeat(4001) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it('paginates messages: newest first page, older page via before, hasMore flag', async () => {
    const a = await createAndLoginUser(server, { nickname: 'page_chat_a' });
    const b = await createAndLoginUser(server, { nickname: 'page_chat_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    // send 5 messages from a
    for (let i = 1; i <= 5; i += 1) {
      await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { content: `msg${i}` },
      });
    }

    const page1 = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages?limit=3`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const p1 = JSON.parse(page1.payload);
    // chronological order, newest resident -> msg3, msg4, msg5
    expect(p1.messages.map((m: { content: string }) => m.content)).toEqual(['msg3', 'msg4', 'msg5']);
    expect(p1.hasMore).toBe(true);

    // next older page = before the first id of page 1
    const before = p1.messages[0].id;
    const page2 = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages?limit=3&before=${before}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const p2 = JSON.parse(page2.payload);
    expect(p2.messages.map((m: { content: string }) => m.content)).toEqual(['msg1', 'msg2']);
    expect(p2.hasMore).toBe(false);
  });

  it('unread badge + mark-read: unread appears, then clears', async () => {
    const a = await createAndLoginUser(server, { nickname: 'unread_chat_a' });
    const b = await createAndLoginUser(server, { nickname: 'unread_chat_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    // b sends a message → a has 1 unread conversation
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { content: 'liam? ' },
    });
    const unread = await server.inject({
      method: 'GET',
      url: '/api/conversations/unread-count',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(unread.payload).unreadCount).toBe(1);

    // a marks read → cleared
    const read = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/read`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(read.statusCode).toBe(204);
    const unread2 = await server.inject({
      method: 'GET',
      url: '/api/conversations/unread-count',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(unread2.payload).unreadCount).toBe(0);

    // mark-read is membership-enforced
    const eve = await createAndLoginUser(server, { nickname: 'unread_eve' });
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/read`,
      headers: { authorization: `Bearer ${eve.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('requires authentication on all conversation routes (401)', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/conversations' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/api/conversations/unread-count' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/api/conversations/x' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/api/conversations/x/messages' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/api/conversations/x/messages' })).statusCode).toBe(401);
  });

  it('realtime: sends a chat_message frame to the recipient live socket', async () => {
    const a = await createAndLoginUser(server, { nickname: 'rt_chat_a' });
    const b = await createAndLoginUser(server, { nickname: 'rt_chat_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const socket = { send: vi.fn() };
    addSocket(b.id, socket);
    try {
      await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { content: 'tempo real' },
      });
      expect(socket.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(socket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_message');
      expect(frame.data.conversationId).toBe(conv.id);
      expect(frame.data.message.content).toBe('tempo real');
    } finally {
      removeSocket(b.id, socket);
    }
  });

  it('BUGFIX (balões): recipient frame has mine=false so it renders on the LEFT, and readAt start null', async () => {
    const a = await createAndLoginUser(server, { nickname: 'baloon_a' });
    const b = await createAndLoginUser(server, { nickname: 'baloon_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const socket = { send: vi.fn() };
    addSocket(b.id, socket);
    try {
      await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { content: 'lado certo' },
      });
      const frame = JSON.parse(socket.send.mock.calls[0][0] as string);
      const incoming = frame.data.message;
      expect(incoming.mine).toBe(false); // B receives A's message → not mine
      expect(incoming.senderId).toBe(a.id);
      expect(incoming.readAt).toBeNull();
    } finally {
      removeSocket(b.id, socket);
    }
  });

  it('status "enviado/visto agora": readAt stays null until the recipient reads, then set (and chat_read fires)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'see_a' });
    const b = await createAndLoginUser(server, { nickname: 'see_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'liu?' },
    });
    const sentMsg = JSON.parse(sent.payload).message;
    // The sender's own view: not read yet.
    expect(sentMsg.readAt).toBeNull();
    expect(sentMsg.mine).toBe(true);

    // B reads → A's message gets a readAt.
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/read`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });

    const stored = await prisma.message.findUnique({ where: { id: sentMsg.id } });
    expect(stored?.readAt).not.toBeNull();

    // A reloads → message now carries readAt (drives "visto agora").
    const reload = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const reloaded = JSON.parse(reload.payload).messages.find(
      (m: { id: string }) => m.id === sentMsg.id,
    );
    expect(reloaded.readAt).not.toBeNull();
    expect(reloaded.mine).toBe(true);

    // Realtime: when B reads a FRESH unread message, a chat_read frame is
    // dispatched to A's sockets (so A's "enviado" can flip to "visto agora").
    const aSocket = { send: vi.fn() };
    addSocket(a.id, aSocket);
    try {
      // A sends ANOTHER message (unread by B).
      await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { content: 'liu?' },
      });
      const bRead = await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/read`,
        headers: { authorization: `Bearer ${b.accessToken}` },
      });
      expect(bRead.statusCode).toBe(204);
      expect(aSocket.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(aSocket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_read');
      expect(frame.data.conversationId).toBe(conv.id);
    } finally {
      removeSocket(a.id, aSocket);
    }
  });

  it('typing: setTyping relays a chat_typing frame to the peer; non-member is forbidden', async () => {
    const a = await createAndLoginUser(server, { nickname: 'ty_a' });
    const b = await createAndLoginUser(server, { nickname: 'ty_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const bSocket = { send: vi.fn() };
    addSocket(b.id, bSocket);
    try {
      await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/typing`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { typing: true },
      });
      expect(bSocket.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(bSocket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_typing');
      expect(frame.data.conversationId).toBe(conv.id);
      expect(frame.data.typing).toBe(true);

      await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/typing`,
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { typing: false },
      });
      expect(bSocket.send).toHaveBeenCalledTimes(2);
      const off = JSON.parse(bSocket.send.mock.calls[1][0] as string);
      expect(off.data.typing).toBe(false);
    } finally {
      removeSocket(b.id, bSocket);
    }

    // Non-member cannot signal typing.
    const eve = await createAndLoginUser(server, { nickname: 'ty_eve' });
    await makeFriends(eve, a);
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/typing`,
      headers: { authorization: `Bearer ${eve.accessToken}` },
      payload: { typing: true },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('reply: sends with replyToMessageId, resolves preview (with nickname), and persists the reference only', async () => {
    const a = await createAndLoginUser(server, { nickname: 'rep_a' });
    const b = await createAndLoginUser(server, { nickname: 'rep_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const original = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { content: 'Oi, tudo bem?' },
    });
    const originalMsg = JSON.parse(original.payload).message;

    const reply = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'Sim, tudo ótimo!', replyToMessageId: originalMsg.id },
    });
    expect(reply.statusCode).toBe(201);
    const replyMsg = JSON.parse(reply.payload).message;
    expect(replyMsg.replyTo).not.toBeNull();
    expect(replyMsg.replyTo.exists).toBe(true);
    expect(replyMsg.replyTo.id).toBe(originalMsg.id);
    expect(replyMsg.replyTo.senderNickname).toBe('rep_b');
    expect(replyMsg.replyTo.content).toBe('Oi, tudo bem?');

    // Only the reference is stored — content of the original is NOT duplicated.
    const stored = await prisma.message.findUnique({ where: { id: replyMsg.id } });
    expect(stored?.replyToMessageId).toBe(originalMsg.id);
    expect(stored?.content).toBe('Sim, tudo ótimo!');
  });

  it('reply: replying to a non-existent message (400) and a message of another conversation (400)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'repx_a' });
    const b = await createAndLoginUser(server, { nickname: 'repx_b' });
    const c = await createAndLoginUser(server, { nickname: 'repx_c' });
    await makeFriends(a, b);
    await makeFriends(a, c);
    const convAB = await openConversation(a, b);
    const convAC = await openConversation(a, c);

    const bad = await server.inject({
      method: 'POST',
      url: `/api/conversations/${convAB.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'x', replyToMessageId: 'missing-id' },
    });
    expect(bad.statusCode).toBe(400);

    // A message from a DIFFERENT conversation is not a valid reply target.
    const otherMsg = await server.inject({
      method: 'POST',
      url: `/api/conversations/${convAC.id}/messages`,
      headers: { authorization: `Bearer ${c.accessToken}` },
      payload: { content: 'outra conversa' },
    });
    const otherTarget = JSON.parse(otherMsg.payload).message;
    const cross = await server.inject({
      method: 'POST',
      url: `/api/conversations/${convAB.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'y', replyToMessageId: otherTarget.id },
    });
    expect(cross.statusCode).toBe(400);
    expect(await prisma.message.count({ where: { conversationId: convAB.id } })).toBe(0);
  });

  it('delete FOR ME: message disappears for the caller only, peer still sees it', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dm_a' });
    const b = await createAndLoginUser(server, { nickname: 'dm_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'Olá' },
    });
    const message = JSON.parse(sent.payload).message;

    // A hides it for themselves.
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${conv.id}/messages/${message.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    // A no longer sees it…
    const aMsgs = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(aMsgs.payload).messages.map((m: { id: string }) => m.id)).not.toContain(message.id);
    // …but B still does.
    const bMsgs = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(JSON.parse(bMsgs.payload).messages.map((m: { id: string }) => m.id)).toContain(message.id);

    // Persisted (server-side hide row), not just local frontend state.
    const hid = await prisma.messageHide.count({ where: { messageId: message.id, userId: a.id } });
    expect(hid).toBe(1);
  });

  it('delete FOR ME persists across re-login', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dmpersist_a' });
    const b = await createAndLoginUser(server, { nickname: 'dmpersist_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'só eu' },
    });
    const message = JSON.parse(sent.payload).message;
    await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${conv.id}/messages/${message.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    // A logs out & back in (fresh token) — the message is still hidden.
    const relogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'dmpersist_a', password: 'Password123' },
    });
    const body = JSON.parse(relogin.payload);
    const aMsgs = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(JSON.parse(aMsgs.payload).messages.map((m: { id: string }) => m.id)).not.toContain(message.id);
  });

  it('delete FOR EVERYONE: hidden for BOTH participants and persists', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dall_a' });
    const b = await createAndLoginUser(server, { nickname: 'dall_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'para todos' },
    });
    const message = JSON.parse(sent.payload).message;

    // EITHER participant can delete for everyone (B, who didn't send it).
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${conv.id}/messages/${message.id}/everyone`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    for (const viewer of [a, b]) {
      const msgs = await server.inject({
        method: 'GET',
        url: `/api/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });
      expect(JSON.parse(msgs.payload).messages.map((m: { id: string }) => m.id)).not.toContain(message.id);
    }
    // Soft-delete kept the row (audit) but flagged it.
    const stored = await prisma.message.findUnique({ where: { id: message.id } });
    expect(stored).not.toBeNull();
    expect(stored?.deletedAt).not.toBeNull();
    expect(stored?.deletedById).toBe(b.id);
  });

  it('delete FOR EVERYONE broadcasts chat_message_deleted to the peer live socket', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dallrt_a' });
    const b = await createAndLoginUser(server, { nickname: 'dallrt_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'suma daqui' },
    });
    const message = JSON.parse(sent.payload).message;

    const socket = { send: vi.fn() };
    addSocket(b.id, socket);
    try {
      await server.inject({
        method: 'DELETE',
        url: `/api/conversations/${conv.id}/messages/${message.id}/everyone`,
        headers: { authorization: `Bearer ${a.accessToken}` },
      });
      const frame = JSON.parse(socket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_message_deleted');
      expect(frame.data.conversationId).toBe(conv.id);
      expect(frame.data.messageId).toBe(message.id);
    } finally {
      removeSocket(b.id, socket);
    }
  });

  it('delete FOR EVERYONE: reply reference degrades to exists=false, reply stays intact', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dreply_a' });
    const b = await createAndLoginUser(server, { nickname: 'dreply_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const orig = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { content: 'Oi' },
    });
    const original = JSON.parse(orig.payload).message;
    const rep = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { content: 'Olá!', replyToMessageId: original.id },
    });
    const reply = JSON.parse(rep.payload).message;
    expect(reply.replyTo.exists).toBe(true);

    // Delete the ORIGINAL for everyone.
    await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${conv.id}/messages/${original.id}/everyone`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    // The reply is still there (visible), and its preview degrades gracefully.
    const msgs = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const list = JSON.parse(msgs.payload).messages;
    const replyView = list.find((m: { id: string }) => m.id === reply.id);
    expect(replyView).toBeDefined();
    expect(replyView.replyTo).not.toBeNull();
    expect(replyView.replyTo.id).toBe(original.id);
    expect(replyView.replyTo.exists).toBe(false);
    // The deleted original is no longer returned.
    expect(list.map((m: { id: string }) => m.id)).not.toContain(original.id);
  });

  it('hide CONVERSATION for me: gone from MY list, peer still has it; new message un-hides', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dhide_a' });
    const b = await createAndLoginUser(server, { nickname: 'dhide_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    // A excludes the conversation from their own list.
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${conv.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const aList = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(aList.payload).conversations).toHaveLength(0);

    // B keeps the conversation.
    const bList = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(JSON.parse(bList.payload).conversations).toHaveLength(1);

    // B sends a NEW message → it reappears for A (un-hide).
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { content: 'volta aqui' },
    });
    const aList2 = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(aList2.payload).conversations).toHaveLength(1);
    expect(JSON.parse(aList2.payload).conversations[0].lastMessage.content).toBe('volta aqui');
  });

  it('delete ops are FORBIDDEN for non-members and messages of other conversations', async () => {
    const a = await createAndLoginUser(server, { nickname: 'dforbid_a' });
    const b = await createAndLoginUser(server, { nickname: 'dforbid_b' });
    const c = await createAndLoginUser(server, { nickname: 'dforbid_c' });
    await makeFriends(a, b);
    await makeFriends(a, c);
    const convAB = await openConversation(a, b);
    const convAC = await openConversation(a, c);

    // Non-member C cannot hide someone else's conversation.
    const hide = await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${convAB.id}`,
      headers: { authorization: `Bearer ${c.accessToken}` },
    });
    expect(hide.statusCode).toBe(403);

    // Message from another conversation can't be deleted via this one.
    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${convAC.id}/messages`,
      headers: { authorization: `Bearer ${c.accessToken}` },
      payload: { content: 'outra' },
    });
    const target = JSON.parse(sent.payload).message;
    const wrong = await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${convAB.id}/messages/${target.id}/everyone`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(wrong.statusCode).toBe(404);

    // Unauthenticated user cannot delete.
    const unauth = await server.inject({
      method: 'DELETE',
      url: `/api/conversations/${convAB.id}/messages/${target.id}/everyone`,
    });
    expect(unauth.statusCode).toBe(401);
  });
});