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

async function seedPost(userId: string) {
  return prisma.post.create({ data: { userId, text: 'likeable post' } });
}

describe('Likes', () => {
  it('likes a post and returns likeCount', async () => {
    const author = await createAndLoginUser(server, { username: 'likeauthor' });
    const liker = await createAndLoginUser(server, { username: 'liker1' });
    const post = await seedPost(author.id);

    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.liked).toBe(true);
    expect(body.likeCount).toBe(1);
  });

  it('toggles unlike when liking again', async () => {
    const author = await createAndLoginUser(server, { username: 'likeauthor2' });
    const liker = await createAndLoginUser(server, { username: 'liker2' });
    const post = await seedPost(author.id);

    await server.inject({ method: 'POST', url: `/api/posts/${post.id}/like`, headers: { authorization: `Bearer ${liker.accessToken}` } });
    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.liked).toBe(false);
    expect(body.likeCount).toBe(0);
  });

  it('reflects liked=true for the requesting user in the feed', async () => {
    const author = await createAndLoginUser(server, { username: 'likeauthor3' });
    const liker = await createAndLoginUser(server, { username: 'liker3' });
    const post = await seedPost(author.id);
    await server.inject({ method: 'POST', url: `/api/posts/${post.id}/like`, headers: { authorization: `Bearer ${liker.accessToken}` } });

    const res = await server.inject({
      method: 'GET',
      url: '/api/posts',
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    const body = JSON.parse(res.payload);
    expect(body.posts[0].liked).toBe(true);
    expect(body.posts[0].likeCount).toBe(1);
  });

  it('requires authentication', async () => {
    const author = await createAndLoginUser(server, { username: 'likeauthor4' });
    const post = await seedPost(author.id);
    const res = await server.inject({ method: 'POST', url: `/api/posts/${post.id}/like` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when post does not exist', async () => {
    const liker = await createAndLoginUser(server, { username: 'liker4' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts/nonexistent-id/like',
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
