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

describe('Search recents — /search/recents', () => {
  it('requires auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/search/recents' });
    expect(res.statusCode).toBe(401);
  });

  it('starts empty and records a visited profile', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'recentowner' });
    const target = await createAndLoginUser(server, { nickname: 'recenttarget' });
    const empty = await server.inject({
      method: 'GET',
      url: '/api/search/recents',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(JSON.parse(empty.payload).recents).toHaveLength(0);

    const record = await server.inject({
      method: 'POST',
      url: `/api/search/recents/${target.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(record.statusCode).toBe(204);

    const list = await server.inject({
      method: 'GET',
      url: '/api/search/recents',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const recents = JSON.parse(list.payload).recents;
    expect(recents).toHaveLength(1);
    expect(recents[0].user.nickname).toBe('recenttarget');
    expect(recents[0]).toHaveProperty('visitedAt');
  });

  it('dedupes and bumps the most recent to the top', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'recdupowner' });
    const first = await createAndLoginUser(server, { nickname: 'recdupfirst' });
    const second = await createAndLoginUser(server, { nickname: 'recdupssecond' });
    const third = await createAndLoginUser(server, { nickname: 'recdupthird' });

    for (const target of [first, second, third]) {
      await server.inject({
        method: 'POST',
        url: `/api/search/recents/${target.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
    }

    const list = async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/search/recents',
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      return JSON.parse(res.payload).recents;
    };

    let recents = await list();
    expect(recents.map((r: { user: { nickname: string } }) => r.user.nickname)).toEqual(
      ['recdupthird', 'recdupssecond', 'recdupfirst'],
    );

    // Revisit first — it must jump to the top, with no duplicate row.
    await server.inject({
      method: 'POST',
      url: `/api/search/recents/${first.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    recents = await list();
    expect(recents).toHaveLength(3);
    expect(recents.map((r: { user: { nickname: string } }) => r.user.nickname)).toEqual(
      ['recdupfirst', 'recdupthird', 'recdupssecond'],
    );
  });

  it('does not record visiting your own profile', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'recdselfowner' });
    await server.inject({
      method: 'POST',
      url: `/api/search/recents/${owner.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const list = await server.inject({
      method: 'GET',
      url: '/api/search/recents',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(JSON.parse(list.payload).recents).toHaveLength(0);
  });

  it('isolates history per owner', async () => {
    const alice = await createAndLoginUser(server, { nickname: 'recalice' });
    const bob = await createAndLoginUser(server, { nickname: 'recbob' });
    const carol = await createAndLoginUser(server, { nickname: 'reccarol' });
    await server.inject({
      method: 'POST',
      url: `/api/search/recents/${carol.id}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const bobList = await server.inject({
      method: 'GET',
      url: '/api/search/recents',
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(JSON.parse(bobList.payload).recents).toHaveLength(0);
  });

  it('returns 404 when target does not exist', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'recmissingowner' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/search/recents/does-not-exist',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('removes only the owned recent row', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'recremoveowner' });
    const keep = await createAndLoginUser(server, { nickname: 'recremovekeep' });
    const drop = await createAndLoginUser(server, { nickname: 'recremovedrop' });
    const resDrop = await server.inject({
      method: 'POST',
      url: `/api/search/recents/${drop.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(resDrop.statusCode).toBe(204);

    const resKeep = await server.inject({
      method: 'POST',
      url: `/api/search/recents/${keep.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(resKeep.statusCode).toBe(204);

    const listRes = await server.inject({
      method: 'GET',
      url: '/api/search/recents',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const recents = JSON.parse(listRes.payload).recents;
    const dropRow = recents.find((r: { user: { nickname: string } }) => r.user.nickname === 'recremovedrop') as { id: string };
    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/search/recents/${dropRow.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);

    const after = JSON.parse((await server.inject({
      method: 'GET',
      url: '/api/search/recents',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    })).payload).recents;
    expect(after.map((r: { user: { nickname: string } }) => r.user.nickname)).toEqual(['recremovekeep']);

    // The other owner cannot delete this owner's row either.
    const other = await createAndLoginUser(server, { nickname: 'recremoveother' });
    const otherRemoval = await server.inject({
      method: 'DELETE',
      url: `/api/search/recents/${dropRow.id}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(otherRemoval.statusCode).toBe(404);
  });
});
