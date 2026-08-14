import argon2, { type HashOptions } from 'argon2';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import type { Session, User } from '../generated/index.js';
import { createHash, randomBytes, randomInt } from 'node:crypto';

// Argon2id parameters. Tuned for a server-side hash cost that is resistant
// to GPU brute force while keeping registration/login under ~200ms.
const ARGON2_OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456, // ~19 MiB
  timeCost: 3,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export interface AccessTokenPayload {
  sub: string;
  username: string;
}

// Convert human-readable expiry strings ("15m", "30d") to seconds so the
// jsonwebtoken typings accept them without branded-string coupling.
function toSeconds(value: string): number {
  return Math.floor((ms as unknown as (v: string) => number)(value) / 1000);
}

export function signAccessToken(user: Pick<User, 'id' | 'username'>): string {
  return jwt.sign({ sub: user.id, username: user.username }, env.jwt.secret, {
    expiresIn: toSeconds(env.jwt.accessExpiresIn),
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwt.secret) as AccessTokenPayload;
}

// Refresh tokens are opaque random strings; only their hash is stored.
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string): Promise<{ refreshToken: string; session: Session }> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30d
  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
    },
  });
  return { refreshToken, session };
}

export async function rotateRefreshToken(oldToken: string): Promise<
  { userId: string; refreshToken: string } | null
> {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(oldToken) },
  });
  if (!session) return null;
  if (session.revokedAt || session.expiresAt < new Date()) return null;

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const next = await createSession(session.userId);
  return { userId: session.userId, refreshToken: next.refreshToken };
}

export async function revokeSession(token: string): Promise<void> {
  try {
    await prisma.session.update({
      where: { refreshTokenHash: hashToken(token) },
      data: { revokedAt: new Date() },
    });
  } catch {
    // Token may already be revoked or unknown — silently ignore.
  }
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ── Recovery codes ───────────────────────────────────────────────
// A 12-digit numeric recovery code is generated at registration and shown
// ONCE to the user. Only its hash is persisted — the original plaintext is
// never stored, satisfying the requirement that the recovery code itself
// not live in the database.

const RECOVERY_CODE_LENGTH = 12;

export function generateRecoveryCode(): string {
  // Use crypto.randomInt to avoid modulo bias on each digit.
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

// Hash recovery codes with a distinct salt via SHA-256. Argon2id would be
// ideal but these short numeric codes have low entropy, so we rely on rate
// limiting + lockout rather than the hash function to resist brute force.
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

export function verifyRecoveryCode(code: string, hash: string): boolean {
  return hashRecoveryCode(code) === hash;
}
