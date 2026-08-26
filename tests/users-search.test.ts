import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Users — profile', () => {
  it('returns a public profile with the user posts', async () => {
    const u = await createAndLoginUser(server, { nickname: 'profileuser', name: 'Profile User' });
    await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'profile post' },
    });
    const res = await server.inject({ method: 'GET', url: '/api/users/profileuser' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.user.nickname).toBe('profileuser');
    expect(body.user).not.toHaveProperty('email');
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].text).toBe('profile post');
  });

  it('returns 404 for unknown user', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/users/ghost' });
    expect(res.statusCode).toBe(404);
  });

  it('updates the current user profile', async () => {
    const u = await createAndLoginUser(server, { nickname: 'updateme' });
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { nickname: 'nomeatualizado', bio: 'Nova bio' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.nickname).toBe('nomeatualizado');
    expect(JSON.parse(res.payload).user.bio).toBe('Nova bio');
  });

  it('requires auth to update profile', async () => {
    const res = await server.inject({ method: 'PATCH', url: '/api/users/me', payload: { bio: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('Search — GET /users/search', () => {
  it('finds users by nickname substring', async () => {
    await createAndLoginUser(server, { nickname: 'searchable' });
    const res = await server.inject({ method: 'GET', url: '/api/users/search?q=searc' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.users.map((u: { nickname: string }) => u.nickname)).toContain('searchable');
  });

  it('does not return users without match', async () => {
    await createAndLoginUser(server, { nickname: 'nameuser' });
    const res = await server.inject({ method: 'GET', url: '/api/users/search?q=zoeunique' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.users).toHaveLength(0);
  });

  it('returns empty list for no matches', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/users/search?q=zzzznotfound' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).users).toHaveLength(0);
  });

  it('rejects empty query', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/users/search?q=' });
    expect(res.statusCode).toBe(400);
  });
});
