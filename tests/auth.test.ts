import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, login, createUser, createAndLoginUser } from './helpers.js';
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
        name: 'Novo Usuário',
        username: 'novouser',
        password: 'Senha1234',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.username).toBe('novouser');
    expect(body.recoveryCode).toBeTypeOf('string');
    expect(body.recoveryCode).toHaveLength(12);
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.user).not.toHaveProperty('recoveryCodeHash');
    expect(body.user).not.toHaveProperty('email');
  });

  it('rejects duplicate username with 409', async () => {
    await createUser({ username: 'dupuser' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Dup',
        username: 'dupuser',
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
        name: 'Weak',
        username: 'weakuser',
        password: 'short',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not accept email as a field (username-only)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Has Email',
        username: 'hasemail',
        password: 'Senha1234',
        email: 'should@be.ignored',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).user).not.toHaveProperty('email');
  });
});

describe('Auth — POST /api/auth/login', () => {
  it('logs in with username', async () => {
    await createUser({ username: 'loginuser', password: 'Password123' });
    const auth = await login(server, 'loginuser', 'Password123');
    expect(auth.accessToken).toBeTypeOf('string');
    expect(auth.user.username).toBe('loginuser');
  });

  it('rejects wrong password with 401', async () => {
    await createUser({ username: 'wrongpass', password: 'Password123' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'wrongpass', password: 'WrongPass1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unknown user with 401 (generic)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'Password123' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error.message).toBe('Credenciais inválidas.');
  });
});

describe('Auth — account recovery (POST /api/auth/recover)', () => {
  it('resets the password using the recovery code', async () => {
    const u = await createAndLoginUser(server, { username: 'recoveruser', password: 'OldPass123' });
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
      payload: { username: 'recoveruser', password: 'OldPass123' },
    });
    expect(oldLogin.statusCode).toBe(401);

    // New password works.
    const newLogin = await login(server, 'recoveruser', 'NewPass123');
    expect(newLogin.accessToken).toBeTypeOf('string');
  });

  it('rejects recovery with a wrong code (generic message)', async () => {
    await createUser({ username: 'wrongcode' });
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
    const u = await createAndLoginUser(server, { username: 'meuser' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.username).toBe('meuser');
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
