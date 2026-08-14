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

describe('Comments', () => {
  it('creates a comment on a post', async () => {
    const author = await createAndLoginUser(server, { username: 'cmauthor' });
    const commenter = await createAndLoginUser(server, { username: 'commenter' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'Primeiro comentário!' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.text).toBe('Primeiro comentário!');
    expect(body.author.username).toBe('commenter');
  });

  it('lists comments for a post', async () => {
    const author = await createAndLoginUser(server, { username: 'cmauthor2' });
    const commenter = await createAndLoginUser(server, { username: 'commenter2' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    await server.inject({ method: 'POST', url: `/api/posts/${post.id}/comments`, headers: { authorization: `Bearer ${commenter.accessToken}` }, payload: { text: 'c1' } });
    await server.inject({ method: 'POST', url: `/api/posts/${post.id}/comments`, headers: { authorization: `Bearer ${commenter.accessToken}` }, payload: { text: 'c2' } });

    const res = await server.inject({ method: 'GET', url: `/api/posts/${post.id}/comments` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].text).toBe('c2'); // newest first
  });

  it('rejects empty comment', async () => {
    const author = await createAndLoginUser(server, { username: 'cmauthor3' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets owner delete their comment', async () => {
    const author = await createAndLoginUser(server, { username: 'cmauthor4' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'mine' },
    });
    const commentId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('forbids deleting another user comment', async () => {
    const author = await createAndLoginUser(server, { username: 'cmauthor5' });
    const other = await createAndLoginUser(server, { username: 'othercomment' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'mine' },
    });
    const commentId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when commenting on a missing post', async () => {
    const commenter = await createAndLoginUser(server, { username: 'commenter9' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts/missing/comments',
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
