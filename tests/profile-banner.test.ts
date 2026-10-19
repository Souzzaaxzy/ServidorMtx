import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../src/config/prisma.js';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

// Helper: the profile payload for a nickname.
async function getProfile(nickname: string, token?: string) {
  const res = await server.inject({
    method: 'GET',
    url: `/api/users/${nickname}`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.payload) };
}

describe('Profile banner', () => {
  it('starts with no banner (null) and never leaks it as undefined', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_none' });
    const { status, body } = await getProfile('banner_none', user.accessToken);
    expect(status).toBe(200);
    // Explicit null (not a missing key) so the app can distinguish
    // "no banner" from "field absent".
    expect(body.user.bannerUrl).toBeNull();
  });

  it('saves a banner and returns it on the profile', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_save' });

    const patch = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { bannerUrl: '/static/banner-abc123.png' },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.payload).user.bannerUrl).toBe('/static/banner-abc123.png');

    // Persisted (a fresh read of the profile shows it)…
    const { body } = await getProfile('banner_save', user.accessToken);
    expect(body.user.bannerUrl).toBe('/static/banner-abc123.png');

    // …and actually stored on the user row.
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row?.bannerUrl).toBe('/static/banner-abc123.png');
  });

  it('accepts an absolute http(s) banner URL (S3/CDN)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_cdn' });
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { bannerUrl: 'https://cdn.example.com/covers/neo.png' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.bannerUrl).toBe(
      'https://cdn.example.com/covers/neo.png',
    );
  });

  it('clears the banner when null is sent', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_clear' });
    await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { bannerUrl: '/static/banner-xyz.png' },
    });

    const res = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { bannerUrl: null },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.bannerUrl).toBeNull();

    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row?.bannerUrl).toBeNull();
  });

  it('leaves the banner untouched when the field is omitted', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_keep' });
    await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { bannerUrl: '/static/banner-keep.png' },
    });

    // A bio-only update must not wipe the banner.
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { bio: 'nova bio' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.bannerUrl).toBe('/static/banner-keep.png');
  });

  it('rejects invalid banner URLs (validation is server-side)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_bad' });
    for (const bad of [
      'javascript:alert(1)',
      'ftp://example.com/x.png',
      'not-a-url',
      '/static/../etc/passwd',
      '/uploads/banner.png', // only /static/... is served by this API
    ]) {
      const res = await server.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { bannerUrl: bad },
      });
      expect(res.statusCode, `bannerUrl "${bad}" should be rejected`).toBe(400);
    }
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row?.bannerUrl).toBeNull();
  });

  it('shows ANOTHER user their banner on a public profile', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'banner_owner' });
    const viewer = await createAndLoginUser(server, { nickname: 'banner_viewer' });
    await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { bannerUrl: '/static/banner-owner.png' },
    });

    const { body } = await getProfile('banner_owner', viewer.accessToken);
    expect(body.user.bannerUrl).toBe('/static/banner-owner.png');
  });

  it('keeps the banner independent from the avatar', async () => {
    const user = await createAndLoginUser(server, { nickname: 'banner_avatar' });
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        avatarUrl: '/static/avatar-one.png',
        bannerUrl: '/static/banner-one.png',
      },
    });
    expect(res.statusCode).toBe(200);
    const { user: updated } = JSON.parse(res.payload);
    expect(updated.avatarUrl).toBe('/static/avatar-one.png');
    expect(updated.bannerUrl).toBe('/static/banner-one.png');

    // Changing only the avatar keeps the banner.
    const res2 = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { avatarUrl: '/static/avatar-two.png' },
    });
    const { user: updated2 } = JSON.parse(res2.payload);
    expect(updated2.avatarUrl).toBe('/static/avatar-two.png');
    expect(updated2.bannerUrl).toBe('/static/banner-one.png');
  });

  it('requires authentication to change the banner', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      payload: { bannerUrl: '/static/banner.png' },
    });
    expect(res.statusCode).toBe(401);
  });
});
