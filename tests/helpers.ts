import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { hashPassword, generateRecoveryCode, hashRecoveryCode } from '../src/utils/auth.js';

export let app: FastifyInstance;

export async function buildTestServer() {
  app = await buildServer();
  await app.ready();
  return app;
}

export async function closeTestServer() {
  if (app) await app.close();
}

export interface SeedUser {
  id: string;
  nickname: string;
  recoveryCode: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export async function createUser(overrides: Partial<{
  nickname: string;
  password: string;
  bio: string;
  role: 'USER' | 'MODERATOR' | 'ADMIN' | 'OWNER';
}> = {}): Promise<{ id: string; nickname: string; passwordHash: string; recoveryCodeHash: string; recoveryCode: string }> {
  const nickname = overrides.nickname ?? `user_${Math.random().toString(36).slice(2, 8)}`;
  const password = overrides.password ?? 'Password123';
  const passwordHash = await hashPassword(password);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = hashRecoveryCode(recoveryCode);
  const user = await prisma.user.create({
    data: {
      nickname,
      nicknameKey: nickname.toLowerCase(),
      passwordHash,
      recoveryCodeHash,
      role: overrides.role ?? 'USER',
      bio: overrides.bio ?? '',
    },
  });
  return { ...user, recoveryCodeHash, recoveryCode };
}

export async function login(server: FastifyInstance, nickname: string, password: string) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { nickname, password },
  });
  return JSON.parse(res.payload);
}

export async function registerUser(server: FastifyInstance, overrides: Partial<{
  nickname: string;
  password: string;
}> = {}): Promise<{ recoveryCode: string; accessToken: string; refreshToken: string; user: { id: string; nickname: string } }> {
  const nickname = overrides.nickname ?? `new_${Math.random().toString(36).slice(2, 8)}`;
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      nickname,
      password: overrides.password ?? 'Password123',
    },
  });
  return JSON.parse(res.payload);
}

export async function createAndLoginUser(
  server: FastifyInstance,
  overrides: Parameters<typeof createUser>[0] = {},
): Promise<SeedUser> {
  const password = overrides.password ?? 'Password123';
  const nickname = overrides.nickname ?? `user_${Math.random().toString(36).slice(2, 8)}`;
  const dbUser = await createUser({ ...overrides, nickname, password });
  const auth = await login(server, nickname, password);
  return {
    id: dbUser.id,
    nickname,
    recoveryCode: dbUser.recoveryCode,
    password,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
  };
}
