import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { verifyAccessToken } from '../src/utils/auth.js';

// ── Presença pelo socket REAL ────────────────────────────────
// O estado de presença sai da conexão WebSocket de verdade, então o único
// teste que prova o requisito ("fora do aplicativo = offline") é um que abre
// e fecha sockets como o app faz. Este arquivo sobe o servidor numa porta
// real e fala com ele pelo MESMO caminho de produção (/api/push/stream).
let server: FastifyInstance;
let base = '';

beforeAll(async () => {
  server = await buildTestServer();
  // Porta efêmera: o teste nunca colide com outro processo.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('não foi possível descobrir a porta do servidor de teste');
  }
  base = `ws://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await closeTestServer();
});

/** Abre o socket de [accessToken] e espera o handshake completar. */
function openSocket(accessToken: string): Promise<WebSocket> {
  const socket = new WebSocket(`${base}/api/push/stream?token=${accessToken}`);
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cria amizade + conversa entre dois usuários (o app exige ambos). */
async function connect(a: { id: string }, b: { id: string }, token: string) {
  const [one, two] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await prisma.friendship.create({
    data: { userOneId: one, userTwoId: two },
  });
  await server.inject({
    method: 'POST',
    url: `/api/conversations/${a.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('presence over the real WebSocket', () => {
  it('rejects an unauthenticated socket (no presence for a bad token)', async () => {
    const socket = new WebSocket(`${base}/api/push/stream?token=invalid`);
    const closed = await new Promise<number>((resolve) => {
      socket.on('close', (code) => resolve(code));
      socket.on('error', () => resolve(-1));
    });
    expect(closed).toBe(4401);
  });

  it('a live socket makes the user online; closing it makes them offline', async () => {
    const a = await createAndLoginUser(server, { nickname: 'ws_a' });
    const b = await createAndLoginUser(server, { nickname: 'ws_b' });
    await connect(a, b, b.accessToken);

    // Confere o id que o token representa (o helper já fez login real).
    expect(verifyAccessToken(a.accessToken).sub).toBe(a.id);

    const listOf = async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/conversations',
        headers: { authorization: `Bearer ${a.accessToken}` },
      });
      const rows = JSON.parse(res.payload).conversations as {
        otherUser: { online: boolean };
      }[];
      return rows[0]?.otherUser.online;
    };

    expect(await listOf()).toBe(false);

    // B abre o app → socket → online.
    const socket = await openSocket(b.accessToken);
    expect(await listOf()).toBe(true);

    // B fecha o app → socket fechado → offline.
    socket.close();
    await wait(400);
    expect(await listOf()).toBe(false);
  });

  it('the away/active lifecycle frames drive online state', async () => {
    const a = await createAndLoginUser(server, { nickname: 'ws_life_a' });
    const b = await createAndLoginUser(server, { nickname: 'ws_life_b' });
    await connect(a, b, b.accessToken);

    const listOf = async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/conversations',
        headers: { authorization: `Bearer ${a.accessToken}` },
      });
      const rows = JSON.parse(res.payload).conversations as {
        otherUser: { online: boolean };
      }[];
      return rows[0]?.otherUser.online;
    };

    const socket = await openSocket(b.accessToken);
    expect(await listOf()).toBe(true);

    // App em SEGUNDO PLANO (o socket continua aberto para receber push, mas o
    // usuário não está olhando o MATRIX) → offline.
    socket.send(JSON.stringify({ kind: 'away' }));
    await wait(300);
    expect(await listOf()).toBe(false);

    // Voltou ao primeiro plano → online.
    socket.send(JSON.stringify({ kind: 'active' }));
    await wait(300);
    expect(await listOf()).toBe(true);

    socket.close();
    await wait(300);
  });

  it('A receives a presence frame when B comes online', async () => {
    const a = await createAndLoginUser(server, { nickname: 'ws_fan_a' });
    const b = await createAndLoginUser(server, { nickname: 'ws_fan_b' });
    await connect(a, b, b.accessToken);

    const aSocket = await openSocket(a.accessToken);
    const frames: { kind: string; data: { userId: string; online: boolean } }[] = [];
    aSocket.on('message', (raw) => frames.push(JSON.parse(String(raw))));

    const bSocket = await openSocket(b.accessToken);
    await wait(400);

    const presence = frames.filter((f) => f.kind === 'presence');
    expect(presence).toHaveLength(1);
    expect(presence[0].data).toMatchObject({ userId: b.id, online: true });

    // B sai → A recebe o offline.
    frames.length = 0;
    bSocket.close();
    await wait(500);
    const offline = frames.filter((f) => f.kind === 'presence');
    expect(offline).toHaveLength(1);
    expect(offline[0].data).toMatchObject({ userId: b.id, online: false });

    aSocket.close();
    await wait(200);
  });

  it('a group presence frame carries the RECOMPUTED online count', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ws_grp_owner' });
    const member = await createAndLoginUser(server, { nickname: 'ws_grp_member' });
    const [one, two] = owner.id < member.id ? [owner.id, member.id] : [member.id, owner.id];
    await prisma.friendship.create({
      data: { userOneId: one, userTwoId: two },
    });
    const created = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'WS Group', participantIds: [member.id] },
    });
    const groupId = (JSON.parse(created.payload).group as { id: string }).id;

    const ownerSocket = await openSocket(owner.accessToken);
    const frames: {
      kind: string;
      data: { groups: { groupId: string; onlineCount: number }[] };
    }[] = [];
    ownerSocket.on('message', (raw) => frames.push(JSON.parse(String(raw))));

    const memberSocket = await openSocket(member.accessToken);
    await wait(400);

    const presence = frames.filter((f) => f.kind === 'presence');
    expect(presence.length).toBeGreaterThanOrEqual(1);
    // DOIS sockets estão abertos (owner e member), então a contagem do grupo
    // é 2 — o servidor recalculou a partir dos sockets reais, não do total
    // de membros (que também é 2, mas por outro motivo).
    expect(presence[0].data.groups).toContainEqual({
      groupId,
      onlineCount: 2,
    });

    // O member fecha o app → a contagem cai para 1, ao vivo.
    frames.length = 0;
    memberSocket.close();
    await wait(500);
    const afterClose = frames.filter((f) => f.kind === 'presence');
    expect(afterClose.length).toBeGreaterThanOrEqual(1);
    expect(afterClose[0].data.groups).toContainEqual({
      groupId,
      onlineCount: 1,
    });

    ownerSocket.close();
    await wait(200);
  });
});
