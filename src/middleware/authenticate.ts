import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import { ApiError } from '../utils/errors.js';
import { verifyAccessToken } from '../utils/auth.js';
import { prisma } from '../config/prisma.js';
import type { UserRole } from '../generated/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, _reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, _reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: UserRole[]) => (request: FastifyRequest, _reply: FastifyReply) => Promise<void>;
  }
}

// Role hierarchy: OWNER > ADMIN > MODERATOR > USER. A request passes when
// the user's role is at or above any of the required roles.
const ROLE_RANK: Record<UserRole, number> = {
  USER: 0,
  MODERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized();
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    request.user = { id: payload.sub, username: payload.username };
  } catch {
    throw ApiError.unauthorized();
  }
}

// Populates request.user when a valid bearer token is present, but does
// NOT reject the request when absent or invalid. Used by public routes
// (feed, profile) that personalize ("liked" state) for logged-in users.
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return;
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    request.user = { id: payload.sub, username: payload.username };
  } catch {
    // Invalid token on a public route — ignore and treat as anonymous.
  }
}

// Factory: returns an onRequest hook that enforces the caller's role is at
// or above one of the allowed roles. Requires authenticate to have run first.
export function requireRole(...allowed: UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) throw ApiError.unauthorized();
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { role: true },
    });
    if (!user) throw ApiError.unauthorized();
    const userRank = ROLE_RANK[user.role];
    const minRequired = Math.min(...allowed.map((r) => ROLE_RANK[r]));
    if (userRank < minRequired) {
      throw ApiError.forbidden('Acesso restrito à equipe.');
    }
  };
}

export function registerRoleDecorator(app: FastifyInstance): void {
  app.decorate('requireRole', requireRole);
}
