import { prisma } from '../../config/prisma.js';
import { AUTHOR_SELECT, toPublicUser, type PublicUser } from '../../utils/dto.js';
import type { SearchQuery } from './search.schema.js';

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
