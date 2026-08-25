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

async function seedColor(id: string, hex = '#0066FF', active = true) {
  await prisma.item.upsert({
    where: { id },
    update: { active, assetUrl: hex },
    create: {
      id,
      type: 'NAME_COLOR',
      name: id,
      assetUrl: hex,
      rarity: 'COMMON',
      price: 0,
      category: 'special',
      sortOrder: 0,
      active,
    },
  });
}

async function equip(app: FastifyInstance, token: string, itemId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/customization/equip/${itemId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('Name colors — nickname color customization', () => {
  it('equips a NAME_COLOR without requiring ownership (free palette)', async () => {
    const u = await createAndLoginUser(server, { username: 'color_user' });
    await seedColor('matrix_blue');

    const res = await equip(server, u.accessToken, 'matrix_blue');
    expect(res.statusCode).toBe(200);
    const equipped = JSON.parse(res.payload).equipped;
    expect(equipped.slot).toBe('NAME_COLOR');
    expect(equipped.itemId).toBe('matrix_blue');
    expect(equipped.assetUrl).toBe('#0066FF');
  });

  it('rejects unknown, inactive and non-color ids', async () => {
    const u = await createAndLoginUser(server, { username: 'color_guard' });
    await seedColor('ghost_color', '#123456', false);
    await prisma.item.upsert({
      where: { id: 'frame_guard' },
      update: {},
      create: {
        id: 'frame_guard',
        type: 'AVATAR_FRAME',
        name: 'Guard Frame',
        assetUrl: 'frames/guard',
        rarity: 'RARE',
        price: 100,
      },
    });

    // Unknown id → 404.
    expect((await equip(server, u.accessToken, 'does_not_exist')).statusCode).toBe(404);
    // Inactive color → 404.
    expect((await equip(server, u.accessToken, 'ghost_color')).statusCode).toBe(404);
    // A non-color item the user does not own → 404 (ownership still enforced).
    expect((await equip(server, u.accessToken, 'frame_guard')).statusCode).toBe(404);
  });

  it('unequips the NAME_COLOR slot (back to default)', async () => {
    const u = await createAndLoginUser(server, { username: 'color_reset' });
    await seedColor('crimson', '#DC143C');
    await equip(server, u.accessToken, 'crimson');

    const res = await server.inject({
      method: 'DELETE',
      url: '/api/customization/equip/NAME_COLOR',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const profile = await server.inject({
      method: 'GET',
      url: `/api/users/${u.username}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(JSON.parse(profile.payload).user.nameColor).toBeNull();
  });

  it('embeds the OWN user color in the profile — never the viewer color', async () => {
    const owner = await createAndLoginUser(server, { username: 'nc_owner' });
    const viewer = await createAndLoginUser(server, { username: 'nc_viewer' });
    await seedColor('matrix_blue');
    await seedColor('crimson', '#DC143C');
    await equip(server, owner.accessToken, 'matrix_blue');
    await equip(server, viewer.accessToken, 'crimson');

    const res = await server.inject({
      method: 'GET',
      url: `/api/users/${owner.username}`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    const user = JSON.parse(res.payload).user;
    expect(user.nameColor).toBe('#0066FF');
    expect(user.customization.NAME_COLOR).toMatchObject({
      itemId: 'matrix_blue',
      assetUrl: '#0066FF',
    });
  });

  it('propagates each author color across feed, comments, search, friends and notifications', async () => {
    const a = await createAndLoginUser(server, { username: 'nc_a' });
    const b = await createAndLoginUser(server, { username: 'nc_b' });
    await seedColor('neon_red', '#FF5252');
    await seedColor('neon_blue', '#00E5FF');
    await equip(server, a.accessToken, 'neon_red');
    await equip(server, b.accessToken, 'neon_blue');

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

    // Feed (viewed by B): author A carries A's color.
    const feed = await server.inject({
      method: 'GET',
      url: '/api/posts',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const feedPost = JSON.parse(feed.payload).posts.find((p: { id: string }) => p.id === postId);
    expect(feedPost.author.nameColor).toBe('#FF5252');

    // Comments: author B carries B's color.
    const comments = await server.inject({
      method: 'GET',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(comments.payload).comments[0].author.nameColor).toBe('#00E5FF');

    // Search: each user carries their own color.
    const search = await server.inject({
      method: 'GET',
      url: '/api/users/search?q=nc_',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const users = JSON.parse(search.payload).users;
    expect(users.find((u: { username: string }) => u.username === 'nc_a').nameColor).toBe('#FF5252');
    expect(users.find((u: { username: string }) => u.username === 'nc_b').nameColor).toBe('#00E5FF');

    // Friend request B → A: sender embeds B's color; A's notification actor too.
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
    expect(JSON.parse(requests.payload).requests[0].sender.nameColor).toBe('#00E5FF');

    const notifications = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const list = JSON.parse(notifications.payload).notifications;
    expect(list.every((n: { actor: { nameColor: string } }) => n.actor.nameColor === '#00E5FF')).toBe(true);

    // Friends list after accepting: the friend entry carries B's color.
    const requestId = JSON.parse(requests.payload).requests[0].id;
    await server.inject({
      method: 'POST',
      url: `/api/friend-requests/${requestId}/accept`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const friends = await server.inject({
      method: 'GET',
      url: `/api/users/${a.id}/friends`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(JSON.parse(friends.payload).friends[0].nameColor).toBe('#00E5FF');
  });

  it('persists the color across sessions (re-login keeps the equipped color)', async () => {
    const u = await createAndLoginUser(server, { username: 'nc_persist', password: 'Password123' });
    await seedColor('gold', '#D4AF37');
    await equip(server, u.accessToken, 'gold');

    // Fresh login (new tokens) — the profile still resolves the color.
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nc_persist', password: 'Password123' },
    });
    const token = JSON.parse(login.payload).accessToken;
    const profile = await server.inject({
      method: 'GET',
      url: '/api/users/nc_persist',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(profile.payload).user.nameColor).toBe('#D4AF37');
  });
});
