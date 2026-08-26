import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, login, createUser, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Auth — POST /api/auth/register', () => {
  it('registers a new user and returns tokens + user + recovery code', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        nickname: 'novouser',
        password: 'Senha1234',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.nickname).toBe('novouser');
    expect(body.recoveryCode).toBeTypeOf('string');
    expect(body.recoveryCode).toHaveLength(12);
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.user).not.toHaveProperty('recoveryCodeHash');
    expect(body.user).not.toHaveProperty('email');
  });

  it('rejects duplicate nickname with 409', async () => {
    await createUser({ nickname: 'dupuser' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        nickname: 'dupuser',
        password: 'Senha1234',
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('validates weak password', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        nickname: 'weakuser',
        password: 'short',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not accept email as a field (nickname-only)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        nickname: 'hasemail',
        password: 'Senha1234',
        email: 'should@be.ignored',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).user).not.toHaveProperty('email');
  });
});

describe('Auth — nickname @-normalization', () => {
  it('strips a leading "@" on register so storage never carries the prefix', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { nickname: '@atprefix', password: 'Password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).user.nickname).toBe('atprefix');
    const stored = await prisma.user.findUnique({ where: { nickname: 'atprefix' } });
    expect(stored).not.toBeNull();
    expect(stored!.nickname.startsWith('@')).toBe(false);
  });

  it('strips any amount of leading "@" symbols (never stores "@@x" or "@x")', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { nickname: '@@doubleat', password: 'Password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).user.nickname).toBe('doubleat');
  });

  it('logs in successfully with "@" prefixed input', async () => {
    await createUser({ nickname: 'plainuser' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: '@plainuser', password: 'Password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.nickname).toBe('plainuser');
  });
});

describe('Auth — Unicode nicknames', () => {
  it.each([
    'Leonardo',
    'LEONARDO',
    'LeOnArDo',
    'Leonardo 🔥',
    '★Leonardo★',
    'Leonardo.exe',
    'MATRIX ⚡',
    'LΞONΛRDO',
    '𝕷𝖊𝖔𝖓𝖆𝖗𝖉𝖔',
    'José Àçéntos',
  ])('registers and preserves the exact typed form: %s', async (nickname) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { nickname, password: 'Password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).user.nickname).toBe(nickname);
    const stored = await prisma.user.findUnique({ where: { nickname } });
    expect(stored).not.toBeNull();
    expect(stored!.nickname).toBe(nickname);
  });

  it('logs in case-insensitively and returns the stored display form', async () => {
    await createUser({ nickname: 'Leonardo 🔥' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'leonardo 🔥', password: 'Password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.nickname).toBe('Leonardo 🔥');
  });

  it('rejects a case-variant duplicate nickname with 409', async () => {
    await createUser({ nickname: 'Leonardo' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { nickname: 'LEONARDO', password: 'Password123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it.each([
    '<script>alert(1)</script>',
    'nick<img src=x>',
    'a<b',
    '‎invisible', // U+200E LEFT-TO-RIGHT MARK (format char)
    'ab', // too short
  ])('rejects malicious/invalid nickname: %s', async (nickname) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { nickname, password: 'Password123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('resolves profiles case-insensitively', async () => {
    await createUser({ nickname: 'MixedCase ★' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/users/mixedcase%20%E2%98%85',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.nickname).toBe('MixedCase ★');
  });
});

describe('Auth — POST /api/auth/login', () => {
  it('logs in with username', async () => {
    await createUser({ nickname: 'loginuser', password: 'Password123' });
    const auth = await login(server, 'loginuser', 'Password123');
    expect(auth.accessToken).toBeTypeOf('string');
    expect(auth.user.nickname).toBe('loginuser');
  });

  it('rejects wrong password with 401', async () => {
    await createUser({ nickname: 'wrongpass', password: 'Password123' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'wrongpass', password: 'WrongPass1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unknown user with 401 (generic)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'ghost', password: 'Password123' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error.message).toBe('Credenciais inválidas.');
  });
});

describe('Auth — account recovery (POST /api/auth/recover)', () => {
  it('resets the password using the recovery code', async () => {
    const u = await createAndLoginUser(server, { nickname: 'recoveruser', password: 'OldPass123' });
    expect(u.recoveryCode).toHaveLength(12);

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: {
        identifier: 'recoveruser',
        recoveryCode: u.recoveryCode,
        newPassword: 'NewPass123',
      },
    });
    expect(res.statusCode).toBe(204);

    // Old password no longer works.
    const oldLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { nickname: 'recoveruser', password: 'OldPass123' },
    });
    expect(oldLogin.statusCode).toBe(401);

    // New password works.
    const newLogin = await login(server, 'recoveruser', 'NewPass123');
    expect(newLogin.accessToken).toBeTypeOf('string');
  });

  it('rejects recovery with a wrong code (generic message)', async () => {
    await createUser({ nickname: 'wrongcode' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: {
        identifier: 'wrongcode',
        recoveryCode: '000000000000',
        newPassword: 'NewPass123',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.message).toBe('Dados de recuperação inválidos.');
  });

  it('does not reveal whether a user exists', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: {
        identifier: 'does-not-exist',
        recoveryCode: '000000000000',
        newPassword: 'NewPass123',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.message).toBe('Dados de recuperação inválidos.');
  });
});

describe('Auth — GET /api/auth/me', () => {
  it('returns current user when authenticated', async () => {
    const u = await createAndLoginUser(server, { nickname: 'meuser' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.nickname).toBe('meuser');
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed token with 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});
