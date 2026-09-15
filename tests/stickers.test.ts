import { createHash } from 'node:crypto';
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

/** A package OWNED by the user (authorId on the PACKAGE) — the only kind a
 * regular user is allowed to delete. */
async function createOwnedStickerPackage(userId: string) {
  const pkg = await prisma.stickerPackage.create({
    data: {
      slug: `owned_pack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: 'Owned Pack',
      description: 'pkg do usuário',
      author: 'MATRIX',
      iconUrl: 'http://localhost:3000/static/stickers/test/icon.png',
      authorId: userId,
      source: 'stickerly',
      sourceId: `TEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      stickers: {
        create: Array.from({ length: 2 }, (_, i) => ({
          order: i,
          fileUrl: `http://localhost:3000/static/stickers/test/o${i + 1}.png`,
          width: 512,
          height: 512,
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

    const pkg = await createOwnedStickerPackage(owner.id);
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

  it('imports stickers from the Android share (creates + installs a user package)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'stk_import' });
    const hashA = createHash('sha256').update('bytes-a').digest('hex');
    const hashB = createHash('sha256').update('bytes-b').digest('hex');

    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        name: 'Compartilhados',
        stickers: [
          { url: 'http://localhost:3000/static/impa.png', hash: hashA, width: 256, height: 256 },
          { url: 'http://localhost:3000/static/impb.png', hash: hashB, width: 256, height: 256 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.package).not.toBeNull();
    expect(body.package.installed).toBe(true);
    expect(body.package.stickers).toHaveLength(2);
    expect(body.package.stickers[0].fileUrl).toBe('http://localhost:3000/static/impa.png');

    // The catalog now contains the imported (installed) package.
    const cat = await server.inject({
      method: 'GET',
      url: '/api/stickers/packages',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const packages = JSON.parse(cat.payload).packages;
    const imported = packages.find((p: { slug: string }) => p.slug.startsWith('compartilhados-'));
    expect(imported).toBeDefined();
    expect(imported.installed).toBe(true);
  });

  it('dedupes re-shared files (same hash) and skips only the duplicates', async () => {
    const user = await createAndLoginUser(server, { nickname: 'stk_import2' });
    const hashA = createHash('sha256').update('bytes-a2').digest('hex');
    const hashC = createHash('sha256').update('bytes-c2').digest('hex');

    // First import: A + C
    const first = await server.inject({
      method: 'POST',
      url: '/api/stickers/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        name: 'Pack Um',
        stickers: [
          { url: 'http://localhost:3000/static/a2.png', hash: hashA },
          { url: 'http://localhost:3000/static/c2.png', hash: hashC },
        ],
      },
    });
    expect(first.statusCode).toBe(201);
    expect(JSON.parse(first.payload).created).toBe(2);

    // Reshare everything: same hashes -> nothing new.
    const again = await server.inject({
      method: 'POST',
      url: '/api/stickers/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        name: 'Pack Um',
        stickers: [
          { url: 'http://localhost:3000/static/a2.png', hash: hashA },
          { url: 'http://localhost:3000/static/c2.png', hash: hashC },
        ],
      },
    });
    expect(again.statusCode).toBe(201);
    const againBody = JSON.parse(again.payload);
    expect(againBody.created).toBe(0);
    expect(againBody.skipped).toBe(2);
    expect(againBody.package).toBeNull();

    // Mixed batch: one duplicate + one brand-new hash -> only new is created.
    const hashD = createHash('sha256').update('bytes-d2').digest('hex');
    const mixed = await server.inject({
      method: 'POST',
      url: '/api/stickers/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        name: 'Pack Dois',
        stickers: [
          { url: 'http://localhost:3000/static/a2.png', hash: hashA },
          { url: 'http://localhost:3000/static/d2.png', hash: hashD },
        ],
      },
    });
    expect(mixed.statusCode).toBe(201);
    const mixedBody = JSON.parse(mixed.payload);
    expect(mixedBody.created).toBe(1);
    expect(mixedBody.skipped).toBe(1);
    expect(mixedBody.package.stickers).toHaveLength(1);
  });

  it('rejects an invalid import payload', async () => {
    const user = await createAndLoginUser(server, { nickname: 'stk_importbad' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: 'x', stickers: [] },
    });
    expect(res.statusCode).toBe(400);
  });
  describe('delete package (owner-only) + favorites survival', () => {
    it('rejects deleting a package the user does not own', async () => {
      const owner = await createAndLoginUser(server, { nickname: 'stk_del_owner' });
      const other = await createAndLoginUser(server, { nickname: 'stk_del_other' });
      const pkg = await createOwnedStickerPackage(owner.id);

      const res = await server.inject({
        method: 'DELETE',
        url: `/api/stickers/packages/${pkg.id}`,
        headers: { authorization: `Bearer ${other.accessToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects deleting the official catalog (no owner)', async () => {
      const user = await createAndLoginUser(server, { nickname: 'stk_del_official' });
      const pkg = await createSeedStickerPackage(null);
      const res = await server.inject({
        method: 'DELETE',
        url: `/api/stickers/packages/${pkg.id}`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('deletes the owned package and drops it from the catalog', async () => {
      const user = await createAndLoginUser(server, { nickname: 'stk_del_ok' });
      const pkg = await createOwnedStickerPackage(user.id);

      // Ensure it is listed first.
      const before = await server.inject({
        method: 'GET',
        url: '/api/stickers/packages',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(
        (JSON.parse(before.payload).packages as Array<{ id: string }>).some(
          (p) => p.id === pkg.id,
        ),
      ).toBe(true);

      const res = await server.inject({
        method: 'DELETE',
        url: `/api/stickers/packages/${pkg.id}`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).deleted).toBe(true);

      const after = await server.inject({
        method: 'GET',
        url: '/api/stickers/packages',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(
        (JSON.parse(after.payload).packages as Array<{ id: string }>).some(
          (p) => p.id === pkg.id,
        ),
      ).toBe(false);
    });

    it('preserves favorited stickers after the package is deleted', async () => {
      const user = await createAndLoginUser(server, { nickname: 'stk_del_fav' });
      const pkg = await createOwnedStickerPackage(user.id);
      const stickerId = pkg.stickers[0].id;

      // Favorite one sticker of the package.
      await server.inject({
        method: 'POST',
        url: `/api/stickers/${stickerId}/favorite`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      const del = await server.inject({
        method: 'DELETE',
        url: `/api/stickers/packages/${pkg.id}`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(del.statusCode).toBe(200);
      expect(JSON.parse(del.payload).preservedFavorites).toBe(1);

      // The favorite survives, pointing at a STANDALONE copy...
      const favs = await server.inject({
        method: 'GET',
        url: '/api/stickers/favorites',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const favorites = JSON.parse(favs.payload).stickers as Array<{
        id: string;
        fileUrl: string;
      }>;
      expect(favorites).toHaveLength(1);
      expect(favorites[0].fileUrl).toBe(pkg.stickers[0].fileUrl);
      expect(favorites[0].id).not.toBe(stickerId);

      // ...and can STILL BE SENT to a friend even though its original
      // package was deleted (the sender owns the archived copy).
      const peer = await createAndLoginUser(server, { nickname: 'stk_del_peer' });
      await makeFriends(user, peer);
      const conv = await openConversation(user, peer);
      const send = await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/sticker`,
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { stickerId: favorites[0].id },
      });
      expect(send.statusCode).toBe(201);
      const msg = JSON.parse(send.payload).message;
      expect(msg.type).toBe('sticker');
      expect(msg.stickerUrl).toBe(pkg.stickers[0].fileUrl);
    });
  });
});
