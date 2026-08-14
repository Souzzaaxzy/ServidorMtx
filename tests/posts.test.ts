import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/config/prisma.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Posts — feed + create + delete', () => {
  it('creates a post when authenticated', async () => {
    const u = await createAndLoginUser(server, { username: 'poster1' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'Meu primeiro post real!' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.text).toBe('Meu primeiro post real!');
    expect(body.author.username).toBe('poster1');
    expect(body.likeCount).toBe(0);
    expect(body.liked).toBe(false);
  });

  it('rejects empty post text', async () => {
    const u = await createAndLoginUser(server, { username: 'poster2' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unauthenticated post creation', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      payload: { text: 'anon' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists posts in reverse-chronological order with author + counts', async () => {
    const a = await createAndLoginUser(server, { username: 'feeda' });
    const b = await createAndLoginUser(server, { username: 'feedb' });

    await prisma.post.create({ data: { userId: a.id, text: 'primeiro (mais antigo)' } });
    await new Promise((r) => setTimeout(r, 10));
    await prisma.post.create({ data: { userId: b.id, text: 'segundo (mais novo)' } });

    const res = await server.inject({ method: 'GET', url: '/api/posts?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.posts).toHaveLength(2);
    expect(body.posts[0].text).toBe('segundo (mais novo)');
    expect(body.nextCursor).toBeNull();
  });

  it('paginates with a cursor', async () => {
    const u = await createAndLoginUser(server, { username: 'pager' });
    for (let i = 0; i < 5; i++) {
      await prisma.post.create({ data: { userId: u.id, text: `post ${i}` } });
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await server.inject({ method: 'GET', url: '/api/posts?limit=2' });
    const firstBody = JSON.parse(first.payload);
    expect(firstBody.posts).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await server.inject({
      method: 'GET',
      url: `/api/posts?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    const secondBody = JSON.parse(second.payload);
    expect(secondBody.posts).toHaveLength(2);
  });

  it('lets the owner delete their own post', async () => {
    const u = await createAndLoginUser(server, { username: 'deleter' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'to be deleted' },
    });
    const postId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/posts/${postId}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('forbids deleting another user post', async () => {
    const owner = await createAndLoginUser(server, { username: 'ownera' });
    const other = await createAndLoginUser(server, { username: 'othera' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { text: 'not yours' },
    });
    const postId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/posts/${postId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
