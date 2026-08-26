import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

async function seedFrame(id: string, asset = 'frames/coroa', active = true) {
  await prisma.item.upsert({
    where: { id },
    update: { active, assetUrl: asset },
    create: {
      id,
      type: 'AVATAR_FRAME',
      name: id,
      assetUrl: asset,
      rarity: 'RARE',
      price: 0,
      active,
    },
  });
}

function saveCosmetics(app: FastifyInstance, token: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: '/api/customization/cosmetics',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('Profile frames — MOLDURAS', () => {
  it('lists every active frame in the AVATAR_FRAME catalog', async () => {
    await seedFrame('frame_coroa_test');
    const res = await server.inject({
      method: 'GET',
      url: '/api/customization/catalog?type=AVATAR_FRAME',
    });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.payload).items;
    expect(items.some((i: { id: string; type: string }) => i.id === 'frame_coroa_test')).toBe(true);
    expect(items.every((i: { type: string }) => i.type === 'AVATAR_FRAME')).toBe(true);
  });

  it('receives and persists selectedFrameId (frameId) via the consolidated save', async () => {
    const u = await createAndLoginUser(server, { nickname: 'frame_save' });
    await seedFrame('frame_olho_test', 'frames/olho_do_abismo');

    const res = await saveCosmetics(server, u.accessToken, { frameId: 'frame_olho_test' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics.frameId).toBe('frame_olho_test');

    // A fresh read (equipped) reflects the saved frame.
    const equippedRes = await server.inject({
      method: 'GET',
      url: '/api/customization/equipped',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    const equipped = JSON.parse(equippedRes.payload).equipped;
    const frame = equipped.find((e: { slot: string }) => e.slot === 'AVATAR_FRAME');
    expect(frame.itemId).toBe('frame_olho_test');
    expect(frame.assetUrl).toBe('frames/olho_do_abismo');
  });

  it('updating frameId replaces the previous frame', async () => {
    const u = await createAndLoginUser(server, { nickname: 'frame_update' });
    await seedFrame('frame_a', 'frames/coroa');
    await seedFrame('frame_b', 'frames/dragao');

    await saveCosmetics(server, u.accessToken, { frameId: 'frame_a' });
    const res = await saveCosmetics(server, u.accessToken, { frameId: 'frame_b' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics.frameId).toBe('frame_b');

    const profile = await server.inject({
      method: 'GET',
      url: `/api/users/${u.nickname}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(JSON.parse(profile.payload).user.customization.AVATAR_FRAME.itemId).toBe('frame_b');
  });

  it('removing the frame (frameId: null) restores the default', async () => {
    const u = await createAndLoginUser(server, { nickname: 'frame_remove' });
    await seedFrame('frame_rem', 'frames/lua');
    await saveCosmetics(server, u.accessToken, { frameId: 'frame_rem' });

    const res = await saveCosmetics(server, u.accessToken, { frameId: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics.frameId).toBeNull();

    const equippedRes = await server.inject({
      method: 'GET',
      url: '/api/customization/equipped',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    const equipped = JSON.parse(equippedRes.payload).equipped;
    expect(equipped.find((e: { slot: string }) => e.slot === 'AVATAR_FRAME')).toBeUndefined();

    const profile = await server.inject({
      method: 'GET',
      url: `/api/users/${u.nickname}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(JSON.parse(profile.payload).user.customization.AVATAR_FRAME).toBeUndefined();
  });

  it('rejects invalid frame ids and non-frame ids', async () => {
    const u = await createAndLoginUser(server, { nickname: 'frame_guard' });
    await seedFrame('inactive_frame', 'frames/lua', false);
    await prisma.item.upsert({
      where: { id: 'color_not_frame' },
      update: {},
      create: { id: 'color_not_frame', type: 'NAME_COLOR', name: 'C', assetUrl: '#123456', rarity: 'COMMON', price: 0 },
    });

    // Unknown id → rejected.
    expect((await saveCosmetics(server, u.accessToken, { frameId: 'does_not_exist' })).statusCode).toBe(400);
    // Inactive frame → rejected.
    expect((await saveCosmetics(server, u.accessToken, { frameId: 'inactive_frame' })).statusCode).toBe(400);
    // A non-frame id in the frameId slot → rejected (type mismatch).
    expect((await saveCosmetics(server, u.accessToken, { frameId: 'color_not_frame' })).statusCode).toBe(400);
  });

  it('no arbitrary asset path can be equipped (only catalog ids)', async () => {
    const u = await createAndLoginUser(server, { nickname: 'frame_path' });
    for (const bad of ['../../etc/passwd', 'frames/../secret', 'http://evil.inject.png', 'data:text/html,<script>']) {
      expect((await saveCosmetics(server, u.accessToken, { frameId: bad })).statusCode).toBe(400);
    }
    // Nothing was equipped.
    const equippedRes = await server.inject({
      method: 'GET',
      url: '/api/customization/equipped',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(JSON.parse(equippedRes.payload).equipped.filter((e: { slot: string }) => e.slot === 'AVATAR_FRAME')).toHaveLength(0);
  });

  it('an authenticated user only changes their own frame', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'frame_owner' });
    const other = await createAndLoginUser(server, { nickname: 'frame_other' });
    await seedFrame('frame_own');

    // Other equips theirs; owner equips theirs. Slots are isolated per user.
    await saveCosmetics(server, other.accessToken, { frameId: 'frame_own' });
    const ownerRes = await server.inject({
      method: 'GET',
      url: `/api/users/${owner.nickname}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(JSON.parse(ownerRes.payload).user.customization.AVATAR_FRAME).toBeUndefined();

    // Cross-account write attempts don't even have a user field — the PUT is
    // scoped by the bearer token, so "other" CANNOT touch a different user.
    await saveCosmetics(server, owner.accessToken, { frameId: 'frame_own' });
    const otherRes = await server.inject({
      method: 'GET',
      url: `/api/users/${other.nickname}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(JSON.parse(otherRes.payload).user.customization.AVATAR_FRAME?.itemId).toBe('frame_own');
  });

  it('embeds the frame on the OWNER across feed, comments, search and notifications', async () => {
    const a = await createAndLoginUser(server, { nickname: 'fr_a' });
    const b = await createAndLoginUser(server, { nickname: 'fr_b' });
    await seedFrame('frame_feed', 'frames/cometa');
    await saveCosmetics(server, a.accessToken, { frameId: 'frame_feed' });

    // A posts; B comments.
    const post = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { text: 'post com moldura' },
    });
    const postId = JSON.parse(post.payload).id;
    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { text: 'comentário' },
    });

    // Feed viewed by B: author A carries A's frame.
    const feed = await server.inject({
      method: 'GET',
      url: '/api/posts',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const feedPost = JSON.parse(feed.payload).posts.find((p: { id: string }) => p.id === postId);
    expect(feedPost.author.frameId).toBe('frame_feed');
    expect(feedPost.author.frameAsset).toBe('frames/cometa');

    // Search: A carries their frame.
    const search = await server.inject({
      method: 'GET',
      url: '/api/users/search?q=fr_',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const users = JSON.parse(search.payload).users;
    expect(users.find((u: { nickname: string }) => u.nickname === 'fr_a').frameId).toBe('frame_feed');

    // Comments: author B carries B's frame (B has none → null). A's own
    // frame is never leaked onto B.
    const comments = await server.inject({
      method: 'GET',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(comments.payload).comments[0].author.frameId).toBeNull();
  });

  it('persists the frame across a fresh login session', async () => {
    await seedFrame('frame_persist', 'frames/lua');
    const u = await createAndLoginUser(server, { nickname: 'fr_persist', password: 'Password123' });
    await saveCosmetics(server, u.accessToken, { frameId: 'frame_persist' });

    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'fr_persist', password: 'Password123' },
    });
    const token = JSON.parse(login.payload).accessToken;
    const profile = await server.inject({
      method: 'GET',
      url: '/api/users/fr_persist',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(profile.payload).user.customization.AVATAR_FRAME.itemId).toBe('frame_persist');
  });
});