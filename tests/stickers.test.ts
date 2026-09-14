import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

/** Creates a real sticker package directly in the DB (deterministic ids run
 * through the same catalog path as the seed). */
async function createSeedStickerPackage(userId: string | null = null) {
  const pkg = await prisma.stickerPackage.create({
    data: {
      slug: `test_pack_${Date.now()}`,
      name: 'Test Pack',
      description: 'pkg de teste',
      author: 'MATRIX',
      iconUrl: 'http://localhost:3000/static/stickers/test/icon.png',
      stickers: {
        create: Array.from({ length: 3 }, (_, i) => ({
          order: i,
          fileUrl: `http://localhost:3000/static/stickers/test/s${i + 1}.png`,
          width: 256,
          height: 256,
          authorId: userId,
        })),
      },
    },
    include: { stickers: true },
  });
  return pkg;
}

describe('Stickers', () => {
  it('catalog endpoints require auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/stickers/packages' });
    expect(res.statusCode).toBe(401);
  });

  it('lists packages + install/uninstall + favorites + recents end-to-end', async () => {
    const user = await createAndLoginUser(server, { nickname: 'stk_user' });
    const pkg = await createSeedStickerPackage();
    const [s1] = pkg.stickers;

    // Catalog before install: installed=false, favorited=false.
    const cat = await server.inject({
      method: 'GET',
      url: '/api/stickers/packages',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(cat.statusCode).toBe(200);
    const found = JSON.parse(cat.payload).packages.find((p: { id: string }) => p.id === pkg.id);
    expect(found).toBeDefined();
    expect(found.installed).toBe(false);
    expect(found.stickers[0].favorited).toBe(false);

    // Install (idempotent).
    const inst = await server.inject({
      method: 'POST',
      url: `/api/stickers/packages/${pkg.id}/install`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(inst.statusCode).toBe(204);
    const inst2 = await server.inject({
      method: 'POST',
      url: `/api/stickers/packages/${pkg.id}/install`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(inst2.statusCode).toBe(204);
    const rowCount = await prisma.userStickerPackage.count({ where: { userId: user.id } });
    expect(rowCount).toBe(1);

    // Catalog reflects installed=true.
    const cat2 = await server.inject({
      method: 'GET',
      url: '/api/stickers/packages',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const found2 = JSON.parse(cat2.payload).packages.find((p: { id: string }) => p.id === pkg.id);
    expect(found2.installed).toBe(true);

    // Favorite (idempotent) + list.
    const fav = await server.inject({
      method: 'POST',
      url: `/api/stickers/${s1.id}/favorite`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(fav.statusCode).toBe(204);
    await server.inject({
      method: 'POST',
      url: `/api/stickers/${s1.id}/favorite`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const favList = await server.inject({
      method: 'GET',
      url: '/api/stickers/favorites',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const favorites = JSON.parse(favList.payload).stickers;
    expect(favorites).toHaveLength(1);
    expect(favorites[0].id).toBe(s1.id);

    // Recent (dedupe + move-to-front + bound).
    for (let i = 0; i < 45; i++) {
      await server.inject({
        method: 'POST',
        url: `/api/stickers/${pkg.stickers[i % 3].id}/recent`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
    }
    const rec = await server.inject({
      method: 'GET',
      url: '/api/stickers/recents',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const recents = JSON.parse(rec.payload).stickers;
    expect(recents.length).toBeLessThanOrEqual(40);
    // Only 3 unique stickers exist → 3 recents, all on the list.
    expect(new Set(recents.map((r: { id: string }) => r.id)).size).toBe(recents.length);

    // Uninstall — favorites keep working (package removed ≠ sticker gone).
    const uninst = await server.inject({
      method: 'DELETE',
      url: `/api/stickers/packages/${pkg.id}/install`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(uninst.statusCode).toBe(204);
    const favList2 = await server.inject({
      method: 'GET',
      url: '/api/stickers/favorites',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(JSON.parse(favList2.payload).stickers).toHaveLength(1);

    // Re-install works.
    const re = await server.inject({
      method: 'POST',
      url: `/api/stickers/packages/${pkg.id}/install`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(re.statusCode).toBe(204);
  });

  it('rejects unknown package/sticker ids', async () => {
    const user = await createAndLoginUser(server, { nickname: 'stk_bad' });
    const install = await server.inject({
      method: 'POST',
      url: '/api/stickers/packages/nope/install',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(install.statusCode).toBe(404);
    const fav = await server.inject({
      method: 'POST',
      url: '/api/stickers/nope/favorite',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(fav.statusCode).toBe(404);
  });

  it('sends a private sticker message end-to-end (persist + realtime + recents)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'stk_a' });
    const b = await createAndLoginUser(server, { nickname: 'stk_b' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const pkg = await createSeedStickerPackage(a.id);
    const [s1] = pkg.stickers;

    // a installs the package + sends a sticker to b.
    await server.inject({
      method: 'POST',
      url: `/api/stickers/packages/${pkg.id}/install`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    // Spy on the realtime socket of B.
    const received: string[] = [];
    const socket = {
      send(data: string) { received.push(data); },
    };
    addSocket(b.id, socket);

    const sent = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/sticker`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { stickerId: s1.id },
    });
    expect(sent.statusCode).toBe(201);
    const msg = JSON.parse(sent.payload).message;
    expect(msg.type).toBe('sticker');
    expect(msg.stickerId).toBe(s1.id);
    expect(msg.stickerPackageId).toBe(pkg.id);
    expect(msg.stickerUrl).toBe(s1.fileUrl);
    expect(msg.content).toBe('🧩 Figurinha');
    expect(msg.mine).toBe(true);

    // Realtime frame reached B with the sticker references.
    const frame = received.find((r) => r.includes('chat_message'));
    expect(frame).toBeDefined();
    const parsed = JSON.parse(frame!);
    expect(parsed.data.message.type).toBe('sticker');
    expect(parsed.data.message.stickerId).toBe(s1.id);
    expect(parsed.data.message.mine).toBe(false);

    // Sender's recents contain the sticker.
    const recents = await prisma.stickerRecent.findMany({ where: { userId: a.id } });
    expect(recents.some((r) => r.stickerId === s1.id)).toBe(true);

    // Persistence: B loads history and sees the sticker.
    const hist = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const messages = JSON.parse(hist.payload).messages;
    expect(messages.some((m: { type: string; stickerId: string }) => m.type === 'sticker' && m.stickerId === s1.id)).toBe(true);

    removeSocket(b.id, socket);
  });

  it('validates membership + sticker existence on private send', async () => {
    const a = await createAndLoginUser(server, { nickname: 'stk_c' });
    const b = await createAndLoginUser(server, { nickname: 'stk_d' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const pkg = await createSeedStickerPackage();

    // Unknown sticker → 404.
    const bad = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/sticker`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { stickerId: 'nope' },
    });
    expect(bad.statusCode).toBe(404);

    // Non-member (c is not in the conversation) → 403.
    const c = await createAndLoginUser(server, { nickname: 'stk_e' });
    const outsider = await server.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/sticker`,
      headers: { authorization: `Bearer ${c.accessToken}` },
      payload: { stickerId: pkg.stickers[0].id },
    });
    expect(outsider.statusCode).toBe(403);
  });

  it('sends a group sticker message end-to-end', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'stk_gowner' });
    const peer = await createAndLoginUser(server, { nickname: 'stk_gpeer' });
    await makeFriends(owner, peer);
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Sticker Group', participantIds: [peer.id] },
    });
    const group = JSON.parse(createRes.payload).group;

    const pkg = await createSeedStickerPackage(owner.id);
    const [s1] = pkg.stickers;

    const sent = await server.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/sticker`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { stickerId: s1.id },
    });
    expect(sent.statusCode).toBe(201);
    const msg = JSON.parse(sent.payload).message;
    expect(msg.type).toBe('sticker');
    expect(msg.groupId).toBe(group.id);
    expect(msg.stickerUrl).toBe(s1.fileUrl);

    // Peer history loads the sticker.
    const hist = await server.inject({
      method: 'GET',
      url: `/api/groups/${group.id}/messages`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    const messages = JSON.parse(hist.payload).messages;
    expect(messages.some((m: { type: string; stickerId: string }) => m.type === 'sticker' && m.stickerId === s1.id)).toBe(true);
  });
});