import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, toPublicUser, type PublicUser } from '../../utils/dto.js';
import type { SearchQuery, SearchRecentsQuery } from './search.schema.js';

export async function searchUsers(query: SearchQuery): Promise<PublicUser[]> {
  void query.q.toLowerCase();
  // SQLite's LIKE is case-insensitive for ASCII by default, so `contains`
  // (which compiles to LIKE) matches nicknames without needing an explicit
  // case-insensitivity mode (which SQLite does not support).
  const users = await prisma.user.findMany({
    where: {
      nickname: { contains: query.q },
    },
    orderBy: { nickname: 'asc' },
    take: query.limit,
    select: { ...AUTHOR_SELECT, bio: true, createdAt: true },
  });
  return users.map(toPublicUser);
}

// ── "Pesquisas recentes" (visited profiles) ──────────────────
// One row per (owner, target) pair: each visit relocates the row to the
// top (dedupe via the unique compound + createdAt ordering). The target's
// display identity is resolved from its CURRENT row at read time.

export interface RecentSearchItem {
  id: string;
  user: PublicUser;
  visitedAt: string;
}

export async function listRecentSearches(
  ownerId: string,
  query: SearchRecentsQuery,
): Promise<{ recents: RecentSearchItem[] }> {
  const rows = await prisma.recentSearch.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
    select: {
      id: true,
      createdAt: true,
      target: { select: { ...AUTHOR_SELECT, bio: true, createdAt: true } },
    },
  });
  return {
    recents: rows.map((row) => ({
      id: row.id,
      user: toPublicUser(row.target),
      visitedAt: row.createdAt.toISOString(),
    })),
  };
}

export async function saveRecentSearch(ownerId: string, targetUserId: string): Promise<void> {
  if (ownerId === targetUserId) {
    return;
  }
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!target) {
    throw ApiError.notFound('Perfil não encontrado.');
  }
  // Upsert-then-touch: a unique pair may exist. Deleting the old row and
  // recreating it gives the row a fresh createdAt (bumps it to the top)and
  // keeps the unique "one per pair" guarantee without a race-prone read.
 await prisma.$transaction(async (tx) => {
   await tx.recentSearch.deleteMany({ where: { ownerId, targetUserId } } );
    await tx.recentSearch.create({
      data: { ownerId, targetUserId },
    });
  });
}

export async function removeRecentSearch(ownerId: string, recentId: string): Promise<void> {
  const owned = await prisma.recentSearch.deleteMany({
    where: { id: recentId, ownerId },
  });
  if (owned.count === 0) {
    throw ApiError.notFound('Histórico não encontrado.');
  }
}
