import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../src/config/prisma.js';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { formatPublicId, parsePublicId } from '../src/utils/public-id.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Public #id — formato', () => {
  it('formats 8 digits with leading zeros', () => {
    expect(formatPublicId(1)).toBe('#00000001');
    expect(formatPublicId(42)).toBe('#00000042');
    expect(formatPublicId(12345678)).toBe('#12345678');
  });

  it('parses #id, bare digits and short forms', () => {
    expect(parsePublicId('#00000001')).toBe(1);
    expect(parsePublicId('1')).toBe(1);
    expect(parsePublicId('#12345678')).toBe(12345678);
    expect(parsePublicId('  #42 ')).toBe(42);
  });

  it('rejects things that are not ids', () => {
    expect(parsePublicId('leonardo')).toBeNull();
    expect(parsePublicId('#')).toBeNull();
    expect(parsePublicId('#abc')).toBeNull();
    expect(parsePublicId('#0')).toBeNull(); // ids start at 1
    expect(parsePublicId('#-5')).toBeNull();
    expect(parsePublicId('#1234567890')).toBeNull(); // too long
  });
});

describe('Public #id — alocação', () => {
  it('is assigned on registration and increases', async () => {
    const a = await createAndLoginUser(server, { nickname: 'pid_a' });
    const b = await createAndLoginUser(server, { nickname: 'pid_b' });

    const rowA = await prisma.user.findUnique({ where: { id: a.id } });
    const rowB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(rowA?.publicId).toBeGreaterThan(0);
    expect(rowB!.publicId).toBeGreaterThan(rowA!.publicId);
  });

  it('is unique across accounts', async () => {
    await createAndLoginUser(server, { nickname: 'pid_u1' });
    await createAndLoginUser(server, { nickname: 'pid_u2' });
    await createAndLoginUser(server, { nickname: 'pid_u3' });

    const rows = await prisma.user.findMany({ select: { publicId: true } });
    const ids = rows.map((r) => r.publicId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never reuses a number after the account is deleted', async () => {
    const victim = await createAndLoginUser(server, { nickname: 'pid_gone' });
    const before = await prisma.user.findUnique({ where: { id: victim.id } });
    const retired = before!.publicId;

    // Delete the account…
    const del = await server.inject({
      method: 'DELETE',
      url: '/api/auth/account',
      headers: { authorization: `Bearer ${victim.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    // …then create a new one: it must NOT take the retired number.
    const next = await createAndLoginUser(server, { nickname: 'pid_next' });
    const nextRow = await prisma.user.findUnique({ where: { id: next.id } });
    expect(nextRow!.publicId).toBeGreaterThan(retired);
  });
});

describe('Public #id — login', () => {
  it('logs in with the #id instead of the nickname', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_login' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    const label = formatPublicId(row!.publicId);

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: label, password: user.password },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.user.id).toBe(user.id);
    expect(body.accessToken).toBeTruthy();
  });

  it('accepts the id without the leading #', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_login2' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: String(row!.publicId), password: user.password },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.id).toBe(user.id);
  });

  it('still rejects a wrong password given via #id', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_login3' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: formatPublicId(row!.publicId), password: 'senha-errada-123' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Public #id — busca e perfil', () => {
  it('finds a user by #id', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_search' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    const label = formatPublicId(row!.publicId);

    const res = await server.inject({
      method: 'GET',
      url: `/api/users/search?q=${encodeURIComponent(label)}`,
    });
    expect(res.statusCode).toBe(200);
    const users = JSON.parse(res.payload).users;
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(user.id);
    expect(users[0].publicId).toBe(row!.publicId);
    expect(users[0].publicIdLabel).toBe(label);
  });

  it('opens the profile by #id', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_profile' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    const label = formatPublicId(row!.publicId);

    const res = await server.inject({
      method: 'GET',
      url: `/api/users/${encodeURIComponent(label)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.user.id).toBe(user.id);
    expect(body.user.publicIdLabel).toBe(label);
  });

  it('exposes the #id on the profile payload', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_payload' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });

    const res = await server.inject({ method: 'GET', url: '/api/users/pid_payload' });
    const body = JSON.parse(res.payload);
    expect(body.user.publicId).toBe(row!.publicId);
    expect(body.user.publicIdLabel).toBe(formatPublicId(row!.publicId));
  });

  it('still searches by nickname (a non-numeric query)', async () => {
    await createAndLoginUser(server, { nickname: 'pid_nickname_search' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/users/search?q=pid_nickname',
    });
    expect(res.statusCode).toBe(200);
    const users = JSON.parse(res.payload).users;
    expect(users.some((u: { nickname: string }) => u.nickname === 'pid_nickname_search')).toBe(true);
  });
});

describe('Public #id — recuperação de conta', () => {
  it('recovers the account using the #id as the identifier', async () => {
    const user = await createAndLoginUser(server, { nickname: 'pid_recover' });
    const row = await prisma.user.findUnique({ where: { id: user.id } });

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: {
        identifier: formatPublicId(row!.publicId),
        recoveryCode: user.recoveryCode,
        newPassword: 'NovaSenha123',
      },
    });
    expect(res.statusCode).toBe(204);
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: formatPublicId(row!.publicId), password: 'NovaSenha123' },
    });
    expect(login.statusCode).toBe(200);
  });
});
