import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import {
  isUserOnline,
  onlineCount,
  presenceMap,
  registerConnection,
  resetPresence,
  setPresenceDispatcher,
  setUserVisible,
  unregisterConnection,
} from '../src/modules/presence/presence.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

// ── O estado em si ───────────────────────────────────────────
// Online = socket vivo E app visível. "Usuário fora do aplicativo = offline"
// é literal: o app avisa quando vai para segundo plano.
describe('presence state', () => {
  beforeEach(() => {
    resetPresence();
  });

  it('is offline until a connection exists', () => {
    expect(isUserOnline('u-nobody')).toBe(false);
    expect(presenceMap(['u-nobody'])).toEqual({ 'u-nobody': false });
  });

  it('goes online with the first connection and offline with the last', () => {
    registerConnection('u-a');
    expect(isUserOnline('u-a')).toBe(true);

    // Duas conexões (dois aparelhos/reconexão): fechar UMA não derruba o
    // estado — só a última fecha.
    registerConnection('u-a');
    unregisterConnection('u-a');
    expect(isUserOnline('u-a')).toBe(true);

    unregisterConnection('u-a');
    expect(isUserOnline('u-a')).toBe(false);
  });

  it('app in the BACKGROUND is offline, even with a live socket', () => {
    // Este é o requisito literal: fora do aplicativo = offline. O socket
    // continua aberto (para receber push) mas o usuário não está olhando.
    registerConnection('u-bg');
    expect(isUserOnline('u-bg')).toBe(true);

    setUserVisible('u-bg', false);
    expect(isUserOnline('u-bg')).toBe(false);

    setUserVisible('u-bg', true);
    expect(isUserOnline('u-bg')).toBe(true);
  });

  it('a closed socket clears any pending "hidden" state', () => {
    registerConnection('u-c');
    setUserVisible('u-c', false);
    unregisterConnection('u-c');
    // Reabrir deve voltar a contar como online (não herda o away antigo).
    registerConnection('u-c');
    expect(isUserOnline('u-c')).toBe(true);
  });

  it('counts only the online users out of a list', () => {
    registerConnection('u-1');
    registerConnection('u-2');
    expect(onlineCount(['u-1', 'u-2', 'u-3'])).toBe(2);
    expect(presenceMap(['u-1', 'u-3'])).toEqual({ 'u-1': true, 'u-3': false });
  });

  it('an unknown/empty id is never online', () => {
    expect(isUserOnline('')).toBe(false);
  });
});

// ── Exposição nos payloads ───────────────────────────────────
describe('presence in chat payloads', () => {
  beforeEach(() => {
    resetPresence();
  });

  it('a conversation carries the peer online state', async () => {
    const a = await createAndLoginUser(server, { nickname: 'pres_a' });
    const b = await createAndLoginUser(server, { nickname: 'pres_b' });
    // Amizade é exigida para abrir conversa.
    await prisma.friendship.create({
      data: { userOneId: a.id < b.id ? a.id : b.id, userTwoId: a.id < b.id ? b.id : a.id },
    });
    const created = await server.inject({
      method: 'POST',
      url: `/api/conversations/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(created.statusCode).toBe(200);

    // b está offline → online:false
    const offline = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const listOffline = JSON.parse(offline.payload).conversations as {
      otherUser: { online: boolean };
    }[];
    expect(listOffline[0].otherUser.online).toBe(false);

    // b abre o app → online:true (o MESMO endpoint, sem cache)
    registerConnection(b.id);
    const online = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const listOnline = JSON.parse(online.payload).conversations as {
      otherUser: { online: boolean };
    }[];
    expect(listOnline[0].otherUser.online).toBe(true);
  });

  it('a group header carries the live online count', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'pres_owner' });
    const m1 = await createAndLoginUser(server, { nickname: 'pres_m1' });
    const m2 = await createAndLoginUser(server, { nickname: 'pres_m2' });
    for (const friend of [m1, m2]) {
      await prisma.friendship.create({
        data: {
          userOneId: owner.id < friend.id ? owner.id : friend.id,
          userTwoId: owner.id < friend.id ? friend.id : owner.id,
        },
      });
    }

    const created = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Presenca', participantIds: [m1.id, m2.id] },
    });
    expect(created.statusCode).toBe(201);

    // Ninguém online → 0.
    const before = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    let groups = JSON.parse(before.payload).groups as {
      group: { memberCount: number; onlineCount: number };
    }[];
    expect(groups[0].group.memberCount).toBe(3);
    expect(groups[0].group.onlineCount).toBe(0);

    // Dois membros abrem o app → 2 (o owner NÃO está online).
    registerConnection(m1.id);
    registerConnection(m2.id);
    const after = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    groups = JSON.parse(after.payload).groups as {
      group: { memberCount: number; onlineCount: number };
    }[];
    expect(groups[0].group.onlineCount).toBe(2);

    // Um deles manda o app para segundo plano → cai para 1, ao vivo.
    setUserVisible(m1.id, false);
    const bg = await server.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    groups = JSON.parse(bg.payload).groups as {
      group: { memberCount: number; onlineCount: number };
    }[];
    expect(groups[0].group.onlineCount).toBe(1);
  });
});

// ── Fan-out das transições ───────────────────────────────────
describe('presence fan-out', () => {
  beforeEach(() => {
    resetPresence();
  });

  it('tells the DM peer when a user comes online and goes away', async () => {
    const a = await createAndLoginUser(server, { nickname: 'fan_a' });
    const b = await createAndLoginUser(server, { nickname: 'fan_b' });
    await prisma.friendship.create({
      data: { userOneId: a.id < b.id ? a.id : b.id, userTwoId: a.id < b.id ? b.id : a.id },
    });
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const frames: { userIds: string[]; frame: { userId: string; online: boolean } }[] = [];
    setPresenceDispatcher((userIds, frame) => frames.push({ userIds, frame }));

    registerConnection(a.id);
    // O anúncio é coalescido (evita rajada ao abrir/fechar o app).
    await new Promise((r) => setTimeout(r, 300));

    expect(frames).toHaveLength(1);
    expect(frames[0].userIds).toContain(b.id);
    expect(frames[0].frame).toMatchObject({ userId: a.id, online: true });

    // Segundo plano → offline, e o peer é avisado de novo.
    setUserVisible(a.id, false);
    await new Promise((r) => setTimeout(r, 300));
    expect(frames).toHaveLength(2);
    expect(frames[1].frame).toMatchObject({ userId: a.id, online: false });

    setPresenceDispatcher(() => {});
  });

  it('carries the RECOMPUTED group online count to shared groups', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'fan_owner' });
    const member = await createAndLoginUser(server, { nickname: 'fan_member' });
    await prisma.friendship.create({
      data: {
        userOneId: owner.id < member.id ? owner.id : member.id,
        userTwoId: owner.id < member.id ? member.id : owner.id,
      },
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'FanOut', participantIds: [member.id] },
    });
    const groupId = (JSON.parse(created.payload).group as { id: string }).id;

    const frames: { userIds: string[]; frame: { groups: { groupId: string; onlineCount: number }[] } }[] = [];
    setPresenceDispatcher((userIds, frame) => frames.push({ userIds, frame }));

    registerConnection(member.id);
    await new Promise((r) => setTimeout(r, 300));

    expect(frames).toHaveLength(1);
    // O owner recebe a transição do membro, com a contagem do grupo JÁ
    // recalculada (1 online: só o membro).
    expect(frames[0].userIds).toContain(owner.id);
    expect(frames[0].frame.groups).toContainEqual({ groupId, onlineCount: 1 });

    setPresenceDispatcher(() => {});
  });

  it('does not re-announce an unchanged state (debounced)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'fan_same' });
    const b = await createAndLoginUser(server, { nickname: 'fan_same2' });
    await prisma.friendship.create({
      data: { userOneId: a.id < b.id ? a.id : b.id, userTwoId: a.id < b.id ? b.id : a.id },
    });
    // A audiência vem das CONVERSAS (é nelas que a bolinha aparece), então o
    // teste precisa de uma conversa real — não só da amizade.
    await server.inject({
      method: 'POST',
      url: `/api/conversations/${b.id}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    const frames: unknown[] = [];
    setPresenceDispatcher((_ids, frame) => frames.push(frame));

    // Duas conexões do mesmo usuário = uma única transição.
    registerConnection(a.id);
    registerConnection(a.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(frames).toHaveLength(1);

    // away→active em sequência rápida (abrir o teclado, uma chamada): o
    // estado final é o MESMO de antes, então nenhum frame novo sai.
    setUserVisible(a.id, false);
    setUserVisible(a.id, true);
    await new Promise((r) => setTimeout(r, 300));
    expect(frames).toHaveLength(1);

    setPresenceDispatcher(() => {});
  });
});
