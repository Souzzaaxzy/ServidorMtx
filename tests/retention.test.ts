import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../src/config/prisma.js';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import {
  purgeDeliveredMessages,
  DELIVERED_RETENTION_MS,
  UNDELIVERED_RETENTION_MS,
} from '../src/modules/chat/retention.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

/** A timestamp safely OLDER than the delivered-retention window. */
const longAgo = () =>
  new Date(Date.now() - DELIVERED_RETENTION_MS - 60_000);

/** A timestamp older than the delivered window but NEWER than the safety one. */
const recentlyDelivered = () =>
  new Date(Date.now() - DELIVERED_RETENTION_MS - 60_000);

/** Older than the undelivered safety window. */
const ancient = () =>
  new Date(Date.now() - UNDELIVERED_RETENTION_MS - 60_000);

/// The server only lets FRIENDS open a conversation, so the tests must
/// establish the friendship first (same helper the chat tests use).
async function makeFriends(
  a: { id: string; accessToken: string },
  b: { id: string; accessToken: string },
) {
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

async function dmBetween(
  a: { id: string; accessToken: string },
  b: { id: string; accessToken: string },
) {
  await makeFriends(a, b);
  const res = await server.inject({
    method: 'POST',
    url: `/api/conversations/${b.id}`,
    headers: { authorization: `Bearer ${a.accessToken}` },
  });
  // The endpoint wraps the resource: { conversation: { id, ... } }.
  return JSON.parse(res.payload).conversation.id as string;
}

describe('Retenção — o servidor é fila de entrega, não arquivo', () => {
  it('remove uma DM JÁ LIDA e mais velha que a janela', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ret_dm_s' });
    const reader = await createAndLoginUser(server, { nickname: 'ret_dm_r' });
    const conv = await dmBetween(sender, reader);

    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/messages`,
      headers: { authorization: `Bearer ${sender.accessToken}` },
      payload: { content: 'mensagem entregue' },
    });
    const id = JSON.parse(sent.payload).message.id as string;

    // The recipient reads it (the app does this on open)…
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/read`,
      headers: { authorization: `Bearer ${reader.accessToken}` },
    });
    // …and it becomes old.
    await prisma.message.update({ where: { id }, data: { createdAt: longAgo() } });

    const result = await purgeDeliveredMessages();
    expect(result.delivered).toBeGreaterThan(0);
    expect(await prisma.message.findUnique({ where: { id } })).toBeNull();
  });

  it('NÃO remove uma DM ainda NÃO lida (o outro pode estar offline)', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ret_unread_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ret_unread_r' });
    const conv = await dmBetween(sender, peer);

    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/messages`,
      headers: { authorization: `Bearer ${sender.accessToken}` },
      payload: { content: 'ainda não lida' },
    });
    const id = JSON.parse(sent.payload).message.id as string;
    await prisma.message.update({ where: { id }, data: { createdAt: longAgo() } });

    await purgeDeliveredMessages();

    // Older than the delivered window but NOT past the safety window → kept.
    expect(await prisma.message.findUnique({ where: { id } })).not.toBeNull();
  });

  it('remove uma DM não lida quando passa da janela de SEGURANÇA', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ret_old_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ret_old_r' });
    const conv = await dmBetween(sender, peer);

    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/messages`,
      headers: { authorization: `Bearer ${sender.accessToken}` },
      payload: { content: 'muito antiga' },
    });
    const id = JSON.parse(sent.payload).message.id as string;
    await prisma.message.update({ where: { id }, data: { createdAt: ancient() } });

    const result = await purgeDeliveredMessages();
    expect(result.undelivered).toBeGreaterThan(0);
    expect(await prisma.message.findUnique({ where: { id } })).toBeNull();
  });

  it('NÃO remove mensagens recentes (nem lidas nem não lidas)', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ret_new_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ret_new_r' });
    const conv = await dmBetween(sender, peer);

    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/messages`,
      headers: { authorization: `Bearer ${sender.accessToken}` },
      payload: { content: 'acabou de chegar' },
    });
    const id = JSON.parse(sent.payload).message.id as string;
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/read`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });

    await purgeDeliveredMessages();
    expect(await prisma.message.findUnique({ where: { id } })).not.toBeNull();
  });

  it('grupo: só remove quando TODOS os membros leram', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ret_g_owner' });
    const m1 = await createAndLoginUser(server, { nickname: 'ret_g_m1' });
    const m2 = await createAndLoginUser(server, { nickname: 'ret_g_m2' });

    // Group creation requires every participant to be a FRIEND of the creator
    // (the groups feature enforces it), so the friendships come first.
    await makeFriends(owner, m1);
    await makeFriends(owner, m2);

    const created = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Retenção', participantIds: [m1.id, m2.id] },
    });
    const groupId = JSON.parse(created.payload).group.id as string;

    const sent = await server.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'oi grupo' },
    });
    const id = JSON.parse(sent.payload).message.id as string;
    await prisma.message.update({ where: { id }, data: { createdAt: longAgo() } });

    // Only ONE member read it → still undelivered for the other.
    await server.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/read`,
      headers: { authorization: `Bearer ${m1.accessToken}` },
    });
    await purgeDeliveredMessages();
    expect(await prisma.message.findUnique({ where: { id } })).not.toBeNull();

    // Now the second member reads too → delivered.
    await server.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/read`,
      headers: { authorization: `Bearer ${m2.accessToken}` },
    });
    const result = await purgeDeliveredMessages();
    expect(result.delivered).toBeGreaterThan(0);
    expect(await prisma.message.findUnique({ where: { id } })).toBeNull();
  });

  it('é seguro rodar repetidamente (idempotente)', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ret_idem_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ret_idem_r' });
    const conv = await dmBetween(sender, peer);
    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv}/messages`,
      headers: { authorization: `Bearer ${sender.accessToken}` },
      payload: { content: 'x' },
    });
    await prisma.message.update({
      where: { id: JSON.parse(sent.payload).message.id },
      data: { createdAt: ancient() },
    });

    await purgeDeliveredMessages();
    const second = await purgeDeliveredMessages();
    // Nothing left to delete on the second pass.
    expect(second.delivered).toBe(0);
  });
});
