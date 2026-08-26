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

async function seedColor(id: string, hex = '#0066FF') {
  await prisma.item.upsert({
    where: { id },
    update: { active: true, assetUrl: hex },
    create: {
      id,
      type: 'NAME_COLOR',
      name: id,
      assetUrl: hex,
      rarity: 'COMMON',
      price: 0,
      category: 'special',
      sortOrder: 0,
      active: true,
    },
  });
}

async function seedEffect(
  id: string,
  config: Record<string, unknown> = { animation: 'glow', intensity: 0.5, speed: 1, particles: false },
  active = true,
) {
  await prisma.item.upsert({
    where: { id },
    update: { active, config: JSON.stringify(config) },
    create: {
      id,
      type: 'NAME_EFFECT',
      name: id,
      assetUrl: '',
      rarity: 'COMMON',
      price: 0,
      category: 'glow',
      sortOrder: 0,
      config: JSON.stringify(config),
      active,
    },
  });
}

async function saveCosmetics(app: FastifyInstance, token: string, payload: unknown) {
  return app.inject({
    method: 'PUT',
    url: '/api/customization/cosmetics',
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

async function getCosmetics(app: FastifyInstance, token: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/customization/cosmetics',
    headers: { authorization: `Bearer ${token}` },
  });
  return JSON.parse(res.payload).cosmetics;
}

describe('Name effects — nickname effect customization', () => {
  it('lists the effects catalog with render configs', async () => {
    await seedEffect('glow');
    const res = await server.inject({
      method: 'GET',
      url: '/api/customization/catalog?type=NAME_EFFECT',
    });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.payload).items;
    const glow = items.find((i: { id: string }) => i.id === 'glow');
    expect(glow).toMatchObject({
      id: 'glow',
      type: 'NAME_EFFECT',
      category: 'glow',
      active: true,
      config: { animation: 'glow', intensity: 0.5, speed: 1, particles: false },
    });
  });

  it('saves color + effect in one consolidated operation', async () => {
    const u = await createAndLoginUser(server, { nickname: 'fx_both' });
    await seedColor('matrix_blue');
    await seedEffect('glow');

    const res = await saveCosmetics(server, u.accessToken, {
      nameColorId: 'matrix_blue',
      nameEffectId: 'glow',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics).toEqual({
      nameColorId: 'matrix_blue',
      nameEffectId: 'glow',
    });

    // Persisted: a fresh GET returns the same consolidated config.
    expect(await getCosmetics(server, u.accessToken)).toEqual({
      nameColorId: 'matrix_blue',
      nameEffectId: 'glow',
    });
  });

  it('saves only the effect, keeping the previously saved color', async () => {
    const u = await createAndLoginUser(server, { nickname: 'fx_effect_only' });
    await seedColor('red', '#E53935');
    await seedEffect('glitch', { animation: 'glitch', intensity: 0.5, speed: 1, particles: false });
    await saveCosmetics(server, u.accessToken, { nameColorId: 'red' });

    const res = await saveCosmetics(server, u.accessToken, { nameEffectId: 'glitch' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics).toEqual({
      nameColorId: 'red',
      nameEffectId: 'glitch',
    });
  });

  it('saves only the color, keeping the previously saved effect', async () => {
    const u = await createAndLoginUser(server, { nickname: 'fx_color_only' });
    await seedColor('green', '#43A047');
    await seedColor('purple', '#8E24AA');
    await seedEffect('fire');
    await saveCosmetics(server, u.accessToken, { nameEffectId: 'fire', nameColorId: 'green' });

    const res = await saveCosmetics(server, u.accessToken, { nameColorId: 'purple' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics).toEqual({
      nameColorId: 'purple',
      nameEffectId: 'fire',
    });
  });

  it('removes the effect with nameEffectId = null, keeping the color', async () => {
    const u = await createAndLoginUser(server, { nickname: 'fx_remove' });
    await seedColor('red', '#E53935');
    await seedEffect('electric');
    await saveCosmetics(server, u.accessToken, { nameColorId: 'red', nameEffectId: 'electric' });

    const res = await saveCosmetics(server, u.accessToken, { nameEffectId: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).cosmetics).toEqual({
      nameColorId: 'red',
      nameEffectId: null,
    });
  });

  it('rejects arbitrary/CSS payloads and unknown or mistyped ids', async () => {
    const u = await createAndLoginUser(server, { nickname: 'fx_guard' });
    await seedColor('matrix_blue');
    await seedEffect('ghost_fx', {}, false);

    // Raw CSS/JS/HTML is meaningless here — only catalog ids are accepted.
    expect(
      (await saveCosmetics(server, u.accessToken, { nameEffect: 'text-shadow: 0 0 50px red' })).statusCode,
    ).toBe(400);
    expect(
      (await saveCosmetics(server, u.accessToken, { nameEffectId: 'text-shadow: 0 0 50px red' })).statusCode,
    ).toBe(400);
    expect(
      (await saveCosmetics(server, u.accessToken, { nameEffectId: '<script>alert(1)</script>' })).statusCode,
    ).toBe(400);
    // A color id is not a valid effect id (type is enforced).
    expect(
      (await saveCosmetics(server, u.accessToken, { nameEffectId: 'matrix_blue' })).statusCode,
    ).toBe(400);
    // Inactive effect.
    expect(
      (await saveCosmetics(server, u.accessToken, { nameEffectId: 'ghost_fx' })).statusCode,
    ).toBe(400);
    // Non-string values.
    expect(
      (await saveCosmetics(server, u.accessToken, { nameEffectId: 42 })).statusCode,
    ).toBe(400);
  });

  it('embeds the OWN user cosmetics in the profile — never the viewer ones', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'fx_owner' });
    const viewer = await createAndLoginUser(server, { nickname: 'fx_viewer' });
    await seedColor('matrix_blue');
    await seedColor('crimson', '#DC143C');
    await seedEffect('glow');
    await seedEffect('glitch', { animation: 'glitch', intensity: 0.5, speed: 1, particles: false });
    await saveCosmetics(server, owner.accessToken, { nameColorId: 'matrix_blue', nameEffectId: 'glow' });
    await saveCosmetics(server, viewer.accessToken, { nameColorId: 'crimson', nameEffectId: 'glitch' });

    const res = await server.inject({
      method: 'GET',
      url: `/api/users/${owner.nickname}`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    const user = JSON.parse(res.payload).user;
    expect(user.nameColor).toBe('#0066FF');
    expect(user.nameColorId).toBe('matrix_blue');
    expect(user.nameEffectId).toBe('glow');
    expect(user.nameEffect).toMatchObject({
      id: 'glow',
      config: { animation: 'glow', intensity: 0.5, speed: 1, particles: false },
    });
    expect(user.customization.NAME_EFFECT).toMatchObject({ itemId: 'glow' });
  });

  it('propagates each author cosmetics across feed, comments, search, friends and notifications', async () => {
    const a = await createAndLoginUser(server, { nickname: 'fx_a' });
    const b = await createAndLoginUser(server, { nickname: 'fx_b' });
    await seedColor('neon_red', '#FF5252');
    await seedColor('neon_blue', '#00E5FF');
    await seedEffect('fire');
    await seedEffect('ice');
    await saveCosmetics(server, a.accessToken, { nameColorId: 'neon_red', nameEffectId: 'fire' });
    await saveCosmetics(server, b.accessToken, { nameColorId: 'neon_blue', nameEffectId: 'ice' });

    // A posts; B comments on it.
    const post = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { text: 'post do A' },
    });
    const postId = JSON.parse(post.payload).id;
    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { text: 'comentário do B' },
    });

    // Feed: author A carries A's color + effect.
    const feed = await server.inject({
      method: 'GET',
      url: '/api/posts',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const feedPost = JSON.parse(feed.payload).posts.find((p: { id: string }) => p.id === postId);
    expect(feedPost.author).toMatchObject({ nameColor: '#FF5252', nameColorId: 'neon_red', nameEffectId: 'fire' });

    // Comments: author B carries B's color + effect.
    const comments = await server.inject({
      method: 'GET',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(comments.payload).comments[0].author).toMatchObject({
      nameColor: '#00E5FF',
      nameColorId: 'neon_blue',
      nameEffectId: 'ice',
    });

    // Search: each user carries their own cosmetics.
    const search = await server.inject({
      method: 'GET',
      url: '/api/users/search?q=fx_',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const users = JSON.parse(search.payload).users;
    expect(users.find((u: { nickname: string }) => u.nickname === 'fx_a')).toMatchObject({
      nameColorId: 'neon_red',
      nameEffectId: 'fire',
    });
    expect(users.find((u: { nickname: string }) => u.nickname === 'fx_b')).toMatchObject({
      nameColorId: 'neon_blue',
      nameEffectId: 'ice',
    });

    // Friend request B → A: sender and notification actor carry B's cosmetics.
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${a.id}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const requests = await server.inject({
      method: 'GET',
      url: '/api/friend-requests',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(requests.payload).requests[0].sender).toMatchObject({
      nameColorId: 'neon_blue',
      nameEffectId: 'ice',
    });

    const notifications = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const list = JSON.parse(notifications.payload).notifications;
    expect(
      list.every(
        (n: { actor: { nameColorId: string; nameEffectId: string } }) =>
          n.actor.nameColorId === 'neon_blue' && n.actor.nameEffectId === 'ice',
      ),
    ).toBe(true);
  });

  it('returns null effect for users without one (color keeps working)', async () => {
    const u = await createAndLoginUser(server, { nickname: 'fx_none' });
    await seedColor('white', '#FAFAFA');
    await saveCosmetics(server, u.accessToken, { nameColorId: 'white' });

    const res = await server.inject({
      method: 'GET',
      url: `/api/users/${u.nickname}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    const user = JSON.parse(res.payload).user;
    expect(user.nameColor).toBe('#FAFAFA');
    expect(user.nameEffectId).toBeNull();
    expect(user.nameEffect).toBeNull();
  });
});
