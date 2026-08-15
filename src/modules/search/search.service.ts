import { prisma } from '../../config/prisma.js';
import { toPublicUser, type PublicUser } from '../../utils/dto.js';
import type { SearchQuery } from './search.schema.js';

export async function searchUsers(query: SearchQuery): Promise<PublicUser[]> {
  void query.q.toLowerCase();
  // SQLite's LIKE is case-insensitive for ASCII by default, so `contains`
  // (which compiles to LIKE) already matches name/username without needing
  // an explicit case-insensitivity mode (which SQLite does not support).
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: query.q } },
        { username: { contains: query.q } },
      ],
    },
    orderBy: { username: 'asc' },
    take: query.limit,
  });
  return users.map(toPublicUser);
}
