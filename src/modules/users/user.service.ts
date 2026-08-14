import { prisma } from '../../config/prisma.js';
import { ApiError, toApiError } from '../../utils/errors.js';
import { normalizeUsername } from '../../utils/normalize.js';
import { toAuthUser, toFeedPost, toPublicUser, type AuthUser, type FeedPost, type PublicUser } from '../../utils/dto.js';

export async function getProfile(
  username: string,
  currentUserId?: string,
): Promise<{ user: PublicUser; posts: FeedPost[] }> {
  const user = await prisma.user.findUnique({
    where: { username: normalizeUsername(username) },
    include: {
      posts: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          user: { select: { id: true, name: true, username: true, avatarUrl: true } },
          _count: { select: { likes: true, comments: true } },
          ...(currentUserId
            ? { likes: { where: { userId: currentUserId }, select: { userId: true } } }
            : {}),
        },
      },
    },
  });
  if (!user) throw ApiError.notFound('Usuário não encontrado.');
  return {
    user: toPublicUser(user),
    posts: user.posts.map((p) => toFeedPost(p, currentUserId)),
  };
}

export async function updateProfile(
  userId: string,
  input: Partial<{ name: string; username: string; bio: string | null; avatarUrl: string | null }>,
): Promise<AuthUser> {
  try {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.username !== undefined) data.username = normalizeUsername(input.username);
    if (input.bio !== undefined) data.bio = input.bio ?? '';
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;

    const user = await prisma.user.update({
      where: { id: userId },
      data,
    });
    return toAuthUser(user);
  } catch (err) {
    throw toApiError(err);
  }
}
