import { prisma } from '../../config/prisma.js';
import { AUTHOR_SELECT, toPublicUser, type PublicUser } from '../../utils/dto.js';
import { parsePublicId } from '../../utils/public-id.js';
import type { SearchQuery } from './search.schema.js';

export async function searchUsers(query: SearchQuery): Promise<PublicUser[]> {
  const select = { ...AUTHOR_SELECT, bio: true, createdAt: true };

  // A query that looks like a public id (`#00000001`, or plain `1`) resolves
  // by NUMBER first — an exact hit, so the user finds the account immediately.
  const publicId = parsePublicId(query.q);
  if (publicId !== null) {
    const byId = await prisma.user.findUnique({
      where: { publicId },
      select,
    });
    if (byId) return [toPublicUser(byId)];
  }

  // Otherwise a nickname substring match. SQLite's LIKE is case-insensitive
  // for ASCII by default, so `contains` (which compiles to LIKE) matches
  // nicknames without needing an explicit case-insensitivity mode (which
  // SQLite does not support).
  const users = await prisma.user.findMany({
    where: {
      nickname: { contains: query.q },
    },
    orderBy: { nickname: 'asc' },
    take: query.limit,
    select,
  });
  return users.map(toPublicUser);
}
