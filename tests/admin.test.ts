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

describe('Staff admin — role authorization', () => {
  it('forbids a regular USER from the staff panel', async () => {
    const user = await createAndLoginUser(server, { username: 'plain_user' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids unauthenticated access', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401);
  });

  it('allows a MODERATOR to list users', async () => {
    const mod = await createAndLoginUser(server, { username: 'mod_user', role: 'MODERATOR' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${mod.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows an ADMIN to grant XP and coins (audited)', async () => {
    const admin = await createAndLoginUser(server, { username: 'admin_user', role: 'ADMIN' });
    const target = await createAndLoginUser(server, { username: 'target_user' });

    const xpRes = await server.inject({
      method: 'POST',
      url: `/api/admin/users/${target.id}/xp`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { amount: 250, note: 'contest' },
    });
    expect(xpRes.statusCode).toBe(200);
    expect(JSON.parse(xpRes.payload).result.totalXp).toBe(250);

    const coinRes = await server.inject({
      method: 'POST',
      url: `/api/admin/users/${target.id}/coins`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { amount: 1000 },
    });
    expect(coinRes.statusCode).toBe(200);

    // The grant is recorded with ADMIN_GRANT reason for audit.
    const xpTx = await prisma.xpTransaction.findFirst({
      where: { userId: target.id, reason: 'ADMIN_GRANT' },
    });
    expect(xpTx).not.toBeNull();
    expect(xpTx!.source).toContain('admin:');
  });

  it('allows an ADMIN to change a user role', async () => {
    const admin = await createAndLoginUser(server, { username: 'role_admin', role: 'ADMIN' });
    const target = await createAndLoginUser(server, { username: 'role_target' });
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/role`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { role: 'MODERATOR' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.role).toBe('MODERATOR');
  });
});

describe('Dynamic config — GET /api/config', () => {
  it('returns public config without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.minAppVersion).toBeDefined();
    expect(body.features).toBeDefined();
  });
});
