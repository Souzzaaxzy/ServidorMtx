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

async function grantItem(userId: string, itemId: string, expiresAt: Date | null = null) {
  return prisma.userItem.create({
    data: { userId, itemId, expiresAt, source: 'ADMIN_GRANT' },
  });
}

describe('Customization — Personalization Engine', () => {
  it('lists the server-owned catalog', async () => {
    // Seed an item directly.
    await prisma.item.upsert({
      where: { id: 'frame_test_catalog' },
      update: {},
      create: {
        id: 'frame_test_catalog',
        type: 'AVATAR_FRAME',
        name: 'Test Frame',
        assetUrl: 'frames/test',
        rarity: 'RARE',
        price: 100,
        active: true,
      },
    });
    const res = await server.inject({ method: 'GET', url: '/api/customization/catalog' });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.payload).items;
    expect(items.some((i: { id: string }) => i.id === 'frame_test_catalog')).toBe(true);
  });

  it('returns a user inventory excluding expired items', async () => {
    const u = await createAndLoginUser(server, { username: 'inv_user' });
    await prisma.item.upsert({
      where: { id: 'banner_inv' },
      update: {},
      create: {
        id: 'banner_inv',
        type: 'PROFILE_BANNER',
        name: 'Inv Banner',
        assetUrl: 'banners/inv',
        rarity: 'UNCOMMON',
        price: 0,
      },
    });
    await grantItem(u.id, 'banner_inv');

    // An expired item should NOT appear.
    await prisma.item.upsert({
      where: { id: 'frame_expired' },
      update: {},
      create: {
        id: 'frame_expired',
        type: 'AVATAR_FRAME',
        name: 'Expired',
        assetUrl: 'frames/exp',
        rarity: 'COMMON',
        price: 0,
      },
    });
    await grantItem(u.id, 'frame_expired', new Date(Date.now() - 1000));

    const res = await server.inject({
      method: 'GET',
      url: '/api/customization/inventory',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.payload).items;
    expect(items.some((i: { itemId: string }) => i.itemId === 'banner_inv')).toBe(true);
    expect(items.some((i: { itemId: string }) => i.itemId === 'frame_expired')).toBe(false);
  });

  it('equips an owned item and unequips it', async () => {
    const u = await createAndLoginUser(server, { username: 'equip_user' });
    await prisma.item.upsert({
      where: { id: 'frame_equip' },
      update: {},
      create: {
        id: 'frame_equip',
        type: 'AVATAR_FRAME',
        name: 'Equip Frame',
        assetUrl: 'frames/equip',
        rarity: 'EPIC',
        price: 0,
      },
    });
    await grantItem(u.id, 'frame_equip');

    const equip = await server.inject({
      method: 'POST',
      url: '/api/customization/equip/frame_equip',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(equip.statusCode).toBe(200);
    expect(JSON.parse(equip.payload).equipped.slot).toBe('AVATAR_FRAME');

    const unequip = await server.inject({
      method: 'DELETE',
      url: '/api/customization/equip/AVATAR_FRAME',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(unequip.statusCode).toBe(204);
  });

  it('refuses to equip an item the user does not own', async () => {
    const u = await createAndLoginUser(server, { username: 'no_own' });
    await prisma.item.upsert({
      where: { id: 'frame_notowned' },
      update: {},
      create: {
        id: 'frame_notowned',
        type: 'AVATAR_FRAME',
        name: 'Not Owned',
        assetUrl: 'frames/no',
        rarity: 'RARE',
        price: 999,
      },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/api/customization/equip/frame_notowned',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
