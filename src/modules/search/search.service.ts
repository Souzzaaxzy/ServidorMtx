import { prisma } from '../../config/prisma.js';
import { toPublicUser, type PublicUser } from '../../utils/dto.js';
import type { SearchQuery } from './search.schema.js';

export async function searchUsers(query: SearchQuery): Promise<PublicUser[]> {
  const term = query.q.toLowerCase();
  // ILIKE for case-insensitive search across name and username.
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { username: { contains: query.q, mode: 'insensitive' } },
      ],
    },
    orderBy: { username: 'asc' },
    take: query.limit,
  });
  void term;
  return users.map(toPublicUser);
}
