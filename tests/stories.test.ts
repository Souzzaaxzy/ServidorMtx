import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';
import { STORY_TTL_MS } from '../src/modules/stories/story.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

const IMG = '/static/11111111111111111111111111111111.jpg';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('Stories', () => {
  it('lists for an anonymous caller without leaking viewed/mine', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/stories' });
    expect(res.statusCode).toBe(200);
    const groups = JSON.parse(res.payload).groups as Array<{
      stories: Array<{ viewed: boolean; mine: boolean }>;
    }>;
    expect(Array.isArray(groups)).toBe(true);
    // Anonymous viewers are never the author and never seen anything.
    for (const g of groups) {
      for (const s of g.stories) {
        expect(s.viewed).toBe(false);
        expect(s.mine).toBe(false);
      }
    }
  });

  it('creates a story with a server-computed 24h expiry', async () => {
    const user = await createAndLoginUser(server, { nickname: 'story_create' });
    const before = Date.now();
    const res = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(user.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image', caption: 'Olá' },
    });
    expect(res.statusCode).toBe(201);
    const story = JSON.parse(res.payload);
    expect(story.id).toBeDefined();
    expect(story.mediaUrl).toBe(IMG);
    expect(story.mediaType).toBe('image');
    expect(story.caption).toBe('Olá');
    expect(story.mine).toBe(true);
    expect(story.viewed).toBe(false);
    // Author payload embeds the existing user identity (nickname/avatar).
    expect(story.author.nickname).toBe('story_create');

    // Expiry ≈ now + 24h (computed server-side, never from the client).
    const expiresAt = new Date(story.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + STORY_TTL_MS - 5000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + STORY_TTL_MS + 5000);
  });

  it('rejects an invalid media payload', async () => {
    const user = await createAndLoginUser(server, { nickname: 'story_bad' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(user.accessToken),
      payload: { mediaUrl: 'javascript:alert(1)', mediaType: 'image' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a thumbnail on an IMAGE story', async () => {
    const user = await createAndLoginUser(server, { nickname: 'story_thumb' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(user.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image', thumbnailUrl: IMG },
    });
    expect(res.statusCode).toBe(400);
  });

  it('groups active stories by author and orders unviewed first', async () => {
    const a = await createAndLoginUser(server, { nickname: 'story_a' });
    const b = await createAndLoginUser(server, { nickname: 'story_b' });

    await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(a.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(b.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image' },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/stories',
      headers: auth(a.accessToken),
    });
    const groups = JSON.parse(res.payload).groups as Array<{
      author: { nickname: string };
      stories: Array<{ id: string; viewed: boolean; mine: boolean }>;
      allViewed: boolean;
    }>;

    // Both authors appear, grouped.
    expect(groups.length).toBe(2);
    const nicknames = groups.map((g) => g.author.nickname).sort();
    expect(nicknames).toEqual(['story_a', 'story_b']);
    expect(groups.every((g) => g.stories.length === 1)).toBe(true);

    // "mine" is per-request: A sees their own story as mine.
    const mineGroup = groups.find((g) => g.author.nickname === 'story_a')!;
    expect(mineGroup.stories[0].mine).toBe(true);
    const otherGroup = groups.find((g) => g.author.nickname === 'story_b')!;
    expect(otherGroup.stories[0].mine).toBe(false);
  });

  it('marks a story viewed (idempotent) and flips ordering after seeing all', async () => {
    const viewer = await createAndLoginUser(server, { nickname: 'story_viewer' });
    const author = await createAndLoginUser(server, { nickname: 'story_author' });

    const created = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(author.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image' },
    });
    const storyId = JSON.parse(created.payload).id as string;

    // Before: not viewed.
    let list = await server.inject({
      method: 'GET',
      url: '/api/stories',
      headers: auth(viewer.accessToken),
    });
    let group = (JSON.parse(list.payload).groups as Array<{
      author: { nickname: string };
      stories: Array<{ viewed: boolean }>;
      allViewed: boolean;
    }>).find((g) => g.author.nickname === 'story_author')!;
    expect(group.stories[0].viewed).toBe(false);
    expect(group.allViewed).toBe(false);

    // Mark viewed (twice → idempotent).
    for (let i = 0; i < 2; i++) {
      const res = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/view`,
        headers: auth(viewer.accessToken),
      });
      expect(res.statusCode).toBe(204);
    }

    list = await server.inject({
      method: 'GET',
      url: '/api/stories',
      headers: auth(viewer.accessToken),
    });
    group = (JSON.parse(list.payload).groups as Array<{
      author: { nickname: string };
      stories: Array<{ viewed: boolean }>;
      allViewed: boolean;
    }>).find((g) => g.author.nickname === 'story_author')!;
    expect(group.stories[0].viewed).toBe(true);
    expect(group.allViewed).toBe(true);
  });

  it('hides expired stories from the active list', async () => {
    const user = await createAndLoginUser(server, { nickname: 'story_expired' });
    await prisma.story.create({
      data: {
        userId: user.id,
        mediaUrl: IMG,
        mediaType: 'image',
        expiresAt: new Date(Date.now() - 60_000), // already expired
      },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/stories',
      headers: auth(user.accessToken),
    });
    const groups = JSON.parse(res.payload).groups as Array<{ author: { nickname: string } }>;
    expect(groups.some((g) => g.author.nickname === 'story_expired')).toBe(false);

    // The list endpoint also PURGES the expired rows.
    const remaining = await prisma.story.count({
      where: { userId: user.id },
    });
    expect(remaining).toBe(0);
  });

  it('allows the owner to delete their story', async () => {
    const user = await createAndLoginUser(server, { nickname: 'story_del_owner' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(user.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image' },
    });
    const storyId = JSON.parse(created.payload).id as string;

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/stories/${storyId}`,
      headers: auth(user.accessToken),
    });
    expect(del.statusCode).toBe(204);

    const list = await server.inject({
      method: 'GET',
      url: '/api/stories',
      headers: auth(user.accessToken),
    });
    expect(JSON.parse(list.payload).groups).toEqual([]);
  });

  it('never lets another user delete or view someone else\'s story ownership', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'story_owner' });
    const other = await createAndLoginUser(server, { nickname: 'story_other' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(owner.accessToken),
      payload: { mediaUrl: IMG, mediaType: 'image' },
    });
    const storyId = JSON.parse(created.payload).id as string;

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/stories/${storyId}`,
      headers: auth(other.accessToken),
    });
    expect(del.statusCode).toBe(403);

    // The story is still there for its owner.
    const still = await prisma.story.findUnique({ where: { id: storyId } });
    expect(still).not.toBeNull();
  });

  it('requires auth for create/view/delete', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/api/stories',
      payload: { mediaUrl: IMG, mediaType: 'image' },
    });
    expect(create.statusCode).toBe(401);

    const view = await server.inject({
      method: 'POST',
      url: '/api/stories/whatever/view',
    });
    expect(view.statusCode).toBe(401);

    const del = await server.inject({
      method: 'DELETE',
      url: '/api/stories/whatever',
    });
    expect(del.statusCode).toBe(401);
  });

  it('accepts a VIDEO story with a cover (same storage shapes as posts)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'story_video' });
    const video = '/static/video/22222222222222222222222222222222.mp4';
    const res = await server.inject({
      method: 'POST',
      url: '/api/stories',
      headers: auth(user.accessToken),
      payload: { mediaUrl: video, mediaType: 'video', thumbnailUrl: IMG },
    });
    expect(res.statusCode).toBe(201);
    const story = JSON.parse(res.payload);
    expect(story.mediaType).toBe('video');
    expect(story.thumbnailUrl).toBe(IMG);
  });
});
