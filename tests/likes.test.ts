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
  it('rejects a bodyless POST carrying a JSON content-type with 400 (not 500)', async () => {
    // Regression: a client that globally sets 'Content-Type: application/json'
    // and then POSTs without a body (the old MatrixApp like bug) must get a
    // clear 400, never an opaque 500.
    const author = await createAndLoginUser(server, { username: 'likeauthor0' });
    const liker = await createAndLoginUser(server, { username: 'liker0' });
    const post = await seedPost(author.id);

    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: {
        authorization: `Bearer ${liker.accessToken}`,
        'content-type': 'application/json',
      },
      // no payload — body is empty
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_REQUEST');
  });

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

  it('profile posts: liked reflects the AUTHENTICATED VIEWER, never the author', async () => {
    const author = await createAndLoginUser(server, { username: 'likeauthor5' });
    const viewer = await createAndLoginUser(server, { username: 'viewer5' });
    const post = await seedPost(author.id);

    // The AUTHOR likes their own post.
    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });

    // The viewer opens the author's profile: the heart must be EMPTY for
    // them — the author's own like must not leak into the viewer's state.
    const viewed = await server.inject({
      method: 'GET',
      url: `/api/users/${author.username}`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    const viewedBody = JSON.parse(viewed.payload);
    expect(viewedBody.posts[0].liked).toBe(false);
    expect(viewedBody.posts[0].likeCount).toBe(1);

    // Same guarantee on the post detail endpoint.
    const detail = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(JSON.parse(detail.payload).liked).toBe(false);

    // The author, looking at their own profile, sees their own like.
    const own = await server.inject({
      method: 'GET',
      url: `/api/users/${author.username}`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(JSON.parse(own.payload).posts[0].liked).toBe(true);

    // After the viewer likes it, BOTH profile and detail reflect it — and
    // the state survives a fresh request (persisted server-side).
    await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/like`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    const viewedAgain = await server.inject({
      method: 'GET',
      url: `/api/users/${author.username}`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(JSON.parse(viewedAgain.payload).posts[0].liked).toBe(true);
    const detailAgain = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    const detailBody = JSON.parse(detailAgain.payload);
    expect(detailBody.liked).toBe(true);
    expect(detailBody.likeCount).toBe(2);

    // Unauthenticated requests never get a personalized liked=true.
    const anonymous = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}`,
    });
    expect(JSON.parse(anonymous.payload).liked).toBe(false);
  });
});
