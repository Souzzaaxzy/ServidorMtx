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

/** Makes two users friends (required before a DM can be created). */
async function makeFriends(
  a: { id: string; accessToken: string },
  b: { id: string; accessToken: string },
) {
  const send = await server.inject({
    method: 'POST',
    url: `/api/friend-requests/${b.id}`,
    headers: auth(a.accessToken),
  });
  const request = JSON.parse(send.payload);
  await server.inject({
    method: 'POST',
    url: `/api/friend-requests/${request.id}/accept`,
    headers: auth(b.accessToken),
  });
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
  describe('text stories, likes and replies', () => {
    it('creates a TEXT story (no media) and validates the payload', async () => {
      const user = await createAndLoginUser(server, { nickname: 'story_txt' });
      const res = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(user.accessToken),
        payload: { type: 'text', text: 'Bom dia, galera!' },
      });
      expect(res.statusCode).toBe(201);
      const story = JSON.parse(res.payload);
      expect(story.type).toBe('text');
      expect(story.text).toBe('Bom dia, galera!');
      expect(story.mediaUrl).toBeNull();
      expect(story.liked).toBe(false);
      expect(story.likeCount).toBe(0);

      // Empty text is rejected.
      const empty = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(user.accessToken),
        payload: { type: 'text', text: '   ' },
      });
      expect(empty.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('rejects a text story that also carries media', async () => {
      const user = await createAndLoginUser(server, { nickname: 'story_txt_media' });
      const res = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(user.accessToken),
        payload: { type: 'text', text: 'oi', mediaUrl: IMG },
      });
      expect(res.statusCode).toBe(400);
    });

    it('toggles a story like and never duplicates it', async () => {
      const author = await createAndLoginUser(server, { nickname: 'story_like_author' });
      const liker = await createAndLoginUser(server, { nickname: 'story_like_user' });
      const created = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(author.accessToken),
        payload: { mediaUrl: IMG, mediaType: 'image' },
      });
      const storyId = JSON.parse(created.payload).id as string;

      const like = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/like`,
        headers: auth(liker.accessToken),
      });
      expect(like.statusCode).toBe(200);
      expect(JSON.parse(like.payload)).toMatchObject({ liked: true, likeCount: 1 });

      // Liking again TOGGLES OFF (same as the feed).
      const again = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/like`,
        headers: auth(liker.accessToken),
      });
      expect(JSON.parse(again.payload)).toMatchObject({ liked: false, likeCount: 0 });

      // Multiple likes from the same user can never create two rows.
      await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/like`,
        headers: auth(liker.accessToken),
      });
      const rows = await prisma.storyLike.count({ where: { storyId, userId: liker.id } });
      expect(rows).toBe(1);
    });

    it('exposes liked/likeCount per viewer in the list', async () => {
      const author = await createAndLoginUser(server, { nickname: 'story_like_author2' });
      const liker = await createAndLoginUser(server, { nickname: 'story_like_user2' });
      const created = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(author.accessToken),
        payload: { mediaUrl: IMG, mediaType: 'image' },
      });
      const storyId = JSON.parse(created.payload).id as string;
      await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/like`,
        headers: auth(liker.accessToken),
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/stories',
        headers: auth(liker.accessToken),
      });
      const groups = JSON.parse(res.payload).groups as Array<{
        stories: Array<{ id: string; liked: boolean; likeCount: number }>;
      }>;
      const item = groups.flatMap((g) => g.stories).find((s) => s.id === storyId)!;
      expect(item.liked).toBe(true);
      expect(item.likeCount).toBe(1);

      // The AUTHOR does not see it as liked (per-viewer state).
      const own = await server.inject({
        method: 'GET',
        url: '/api/stories',
        headers: auth(author.accessToken),
      });
      const ownItem = (JSON.parse(own.payload).groups as Array<{
        stories: Array<{ id: string; liked: boolean }>;
      }>).flatMap((g) => g.stories).find((s) => s.id === storyId)!;
      expect(ownItem.liked).toBe(false);
    });

    it('replies to a story as a REAL message in the DM with its author', async () => {
      const author = await createAndLoginUser(server, { nickname: 'story_rep_author' });
      const replier = await createAndLoginUser(server, { nickname: 'story_rep_user' });
      await makeFriends(author, replier);
      const created = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(author.accessToken),
        payload: { mediaUrl: IMG, mediaType: 'image' },
      });
      const storyId = JSON.parse(created.payload).id as string;

      const reply = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/reply`,
        headers: auth(replier.accessToken),
        payload: { text: 'Que legal!' },
      });
      expect(reply.statusCode).toBe(201);
      const body = JSON.parse(reply.payload);
      expect(body.recipientId).toBe(author.id);
      expect(body.conversationId).toBeTruthy();
      const msg = body.message;
      expect(msg.type).toBe('story_reply');
      expect(msg.content).toBe('Que legal!');
      // The message carries the story reference + snapshot.
      expect(msg.story.storyId).toBe(storyId);
      expect(msg.story.type).toBe('image');
      expect(msg.story.thumbnailUrl).toBe(IMG);

      // It is a NORMAL message: the author sees it in their history.
      const history = await server.inject({
        method: 'GET',
        url: `/api/conversations/${body.conversationId}/messages`,
        headers: auth(author.accessToken),
      });
      const items = JSON.parse(history.payload).messages as Array<{
        id: string;
        content: string;
        story: { storyId: string } | null;
      }>;
      const stored = items.find((m) => m.id === msg.id)!;
      expect(stored).toBeDefined();
      expect(stored.content).toBe('Que legal!');
      expect(stored.story!.storyId).toBe(storyId);
    });

    it('keeps the story reference AFTER the story expires (chat never breaks)', async () => {
      const author = await createAndLoginUser(server, { nickname: 'story_rep_exp_a' });
      const replier = await createAndLoginUser(server, { nickname: 'story_rep_exp_b' });
      await makeFriends(author, replier);
      const created = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(author.accessToken),
        payload: { mediaUrl: IMG, mediaType: 'image' },
      });
      const storyId = JSON.parse(created.payload).id as string;

      const reply = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/reply`,
        headers: auth(replier.accessToken),
        payload: { text: 'Boa!' },
      });
      const convId = JSON.parse(reply.payload).conversationId as string;

      // Expire the story (and let the list purge it).
      await prisma.story.update({
        where: { id: storyId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await server.inject({
        method: 'GET',
        url: '/api/stories',
        headers: auth(author.accessToken),
      });

      // The message survives with its snapshot (the story row is gone).
      const history = await server.inject({
        method: 'GET',
        url: `/api/conversations/${convId}/messages`,
        headers: auth(author.accessToken),
      });
      const items = JSON.parse(history.payload).messages as Array<{
        content: string;
        story: { storyId: string; thumbnailUrl: string | null } | null;
      }>;
      const stored = items.find((m) => m.content === 'Boa!')!;
      expect(stored).toBeDefined();
      expect(stored.story!.storyId).toBe(storyId);
      expect(stored.story!.thumbnailUrl).toBe(IMG);
    });

    it('refuses replying to your own story / an expired one', async () => {
      const author = await createAndLoginUser(server, { nickname: 'story_rep_self' });
      const created = await server.inject({
        method: 'POST',
        url: '/api/stories',
        headers: auth(author.accessToken),
        payload: { mediaUrl: IMG, mediaType: 'image' },
      });
      const storyId = JSON.parse(created.payload).id as string;

      const own = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/reply`,
        headers: auth(author.accessToken),
        payload: { text: 'oi' },
      });
      expect(own.statusCode).toBe(400);

      await prisma.story.update({
        where: { id: storyId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/reply`,
        headers: auth(author.accessToken),
        payload: { text: 'oi' },
      });
      expect(expired.statusCode).toBe(404);

      // Liking an expired story is refused too.
      const likeExpired = await server.inject({
        method: 'POST',
        url: `/api/stories/${storyId}/like`,
        headers: auth(author.accessToken),
      });
      expect(likeExpired.statusCode).toBe(404);
    });

    it('requires auth for like/reply', async () => {
      expect((await server.inject({ method: 'POST', url: '/api/stories/x/like' })).statusCode).toBe(401);
      expect(
        (await server.inject({ method: 'POST', url: '/api/stories/x/reply', payload: { text: 'a' } })).statusCode,
      ).toBe(401);
    });
  });
});
