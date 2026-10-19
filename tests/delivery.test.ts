import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../src/config/prisma.js';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import {
  purgeDeliveredMessages,
  DELIVERED_RETENTION_MS,
} from '../src/modules/chat/retention.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

const longAgo = () => new Date(Date.now() - DELIVERED_RETENTION_MS - 60_000);

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
  return JSON.parse(res.payload).conversation.id as string;
}

async function sendDm(
  from: { accessToken: string },
  conv: string,
  content = 'oi',
) {
  const res = await server.inject({
    method: 'POST',
    url: `/api/conversations/${conv}/messages`,
    headers: { authorization: `Bearer ${from.accessToken}` },
    payload: { content },
  });
  return JSON.parse(res.payload).message.id as string;
}

const ack = (
  user: { accessToken: string },
  messageIds: string[],
) =>
  server.inject({
    method: 'POST',
    url: '/api/messages/delivered',
    headers: { authorization: `Bearer ${user.accessToken}` },
    payload: { messageIds: messageIds.map((messageId) => ({ messageId })) },
  });

describe('Confirmação de entrega (delivery ack)', () => {
  it('grava o recibo e é idempotente (reenviar não duplica)', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ack_s1' });
    const peer = await createAndLoginUser(server, { nickname: 'ack_r1' });
    const conv = await dmBetween(sender, peer);
    const mid = await sendDm(sender, conv);

    const first = await ack(peer, [mid]);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload).recorded).toBe(1);

    // Retry (offline, reconnect) must be a harmless no-op.
    const second = await ack(peer, [mid]);
    expect(JSON.parse(second.payload).recorded).toBe(1);
    expect(await prisma.messageDelivery.count({ where: { messageId: mid } })).toBe(1);
  });

  it('IGNORA mensagem de conversa alheia (não vaza nem altera nada)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'ack_a' });
    const b = await createAndLoginUser(server, { nickname: 'ack_b' });
    const outsider = await createAndLoginUser(server, { nickname: 'ack_out' });
    const conv = await dmBetween(a, b);
    const mid = await sendDm(a, conv);

    const res = await ack(outsider, [mid]);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).recorded).toBe(0);
    expect(JSON.parse(res.payload).ignored).toBe(1);
    expect(await prisma.messageDelivery.count({ where: { messageId: mid } })).toBe(0);
  });

  it('não confirma a própria mensagem do remetente', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ack_self_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ack_self_r' });
    const conv = await dmBetween(sender, peer);
    const mid = await sendDm(sender, conv);

    const res = await ack(sender, [mid]);
    expect(JSON.parse(res.payload).recorded).toBe(0);
  });

  it('recusa lote acima do limite', async () => {
    const user = await createAndLoginUser(server, { nickname: 'ack_big' });
    const res = await ack(
      user,
      Array.from({ length: 201 }, (_, i) => `m${i}`),
    );
    expect(res.statusCode).toBe(400);
  });

  it('exige autenticação', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/messages/delivered',
      payload: { messageIds: [{ messageId: 'x' }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lista o que ainda falta confirmar', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ack_pend_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ack_pend_r' });
    const conv = await dmBetween(sender, peer);
    const m1 = await sendDm(sender, conv, 'um');
    const m2 = await sendDm(sender, conv, 'dois');

    await ack(peer, [m1]);

    const res = await server.inject({
      method: 'POST',
      url: '/api/messages/delivered/pending',
      headers: { authorization: `Bearer ${peer.accessToken}` },
      payload: {
        messageIds: [m1, m2].map((messageId) => ({ messageId })),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).pending).toEqual([m2]);
  });
});

describe('Confirmação de entrega alimenta a retenção', () => {
  it('remove uma mensagem ENTREGUE mas NUNCA LIDA (chat que ninguém abriu)',
    async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ack_ret_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ack_ret_r' });
    const conv = await dmBetween(sender, peer);
    const mid = await sendDm(sender, conv);

    // The device got it (receipt) but the user never opened the chat, so
    // there is NO read marker — the previous read-only rule would have kept
    // this message on the server forever.
    await ack(peer, [mid]);
    expect(await prisma.messageRead.count({ where: { messageId: mid } })).toBe(0);
    await prisma.message.update({ where: { id: mid }, data: { createdAt: longAgo() } });

    const result = await purgeDeliveredMessages();
    expect(result.delivered).toBeGreaterThan(0);
    expect(await prisma.message.findUnique({ where: { id: mid } })).toBeNull();
  });

  it('MANTÉM a mensagem sem nenhuma confirmação', async () => {
    const sender = await createAndLoginUser(server, { nickname: 'ack_keep_s' });
    const peer = await createAndLoginUser(server, { nickname: 'ack_keep_r' });
    const conv = await dmBetween(sender, peer);
    const mid = await sendDm(sender, conv);
    await prisma.message.update({ where: { id: mid }, data: { createdAt: longAgo() } });

    await purgeDeliveredMessages();
    // Nothing confirmed it → still within the safety window → kept.
    expect(await prisma.message.findUnique({ where: { id: mid } })).not.toBeNull();
  });

  it('grupo: só remove quando TODOS confirmaram (entrega ou leitura)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ack_g_o' });
    const m1 = await createAndLoginUser(server, { nickname: 'ack_g_m1' });
    const m2 = await createAndLoginUser(server, { nickname: 'ack_g_m2' });
    await makeFriends(owner, m1);
    await makeFriends(owner, m2);

    const created = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Ack', participantIds: [m1.id, m2.id] },
    });
    const groupId = JSON.parse(created.payload).group.id as string;

    const sent = await server.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: 'oi grupo' },
    });
    const mid = JSON.parse(sent.payload).message.id as string;
    await prisma.message.update({ where: { id: mid }, data: { createdAt: longAgo() } });

    // Only one member confirmed → the other still needs it.
    await ack(m1, [mid]);
    await purgeDeliveredMessages();
    expect(await prisma.message.findUnique({ where: { id: mid } })).not.toBeNull();

    // The second member confirms → everyone has it.
    await ack(m2, [mid]);
    const result = await purgeDeliveredMessages();
    expect(result.delivered).toBeGreaterThan(0);
    expect(await prisma.message.findUnique({ where: { id: mid } })).toBeNull();
  });
});
