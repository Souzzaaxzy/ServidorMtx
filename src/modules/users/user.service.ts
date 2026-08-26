import { prisma } from '../../config/prisma.js';
import { ApiError, toApiError } from '../../utils/errors.js';
import { normalizeNickname } from '../../utils/normalize.js';
import { AUTHOR_SELECT, toAuthUser, toFeedPost, toProfileUser, type AuthUser, type FeedPost, type ProfileUser } from '../../utils/dto.js';
import { getFriendshipState } from '../friends/friend.service.js';
import type { FriendshipState } from '../../types/enums.js';

export async function getProfile(
  nickname: string,
  currentUserId?: string,
): Promise<{ user: ProfileUser; posts: FeedPost[]; friendship: FriendshipState | null }> {
  const user = await prisma.user.findUnique({
    where: { nickname: normalizeNickname(nickname) },
    include: {
      // Equipped cosmetics ride along so any profile (own or someone
      // else's) can render frames/badges without an extra request.
      equippedItems: { include: { item: true } },
      posts: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          user: { select: AUTHOR_SELECT },
          _count: { select: { likes: true, comments: true } },
          ...(currentUserId
            ? { likes: { where: { userId: currentUserId }, select: { userId: true } } }
            : {}),
        },
      },
    },
  });
  if (!user) throw ApiError.notFound('Usuário não encontrado.');
  // Real counters: postsCount = all posts of this user; friendsCount =
  // accepted friendships only (pending/rejected requests never count).
  const [postsCount, friendsCount] = await prisma.$transaction([
    prisma.post.count({ where: { userId: user.id } }),
    prisma.friendship.count({
      where: { OR: [{ userOneId: user.id }, { userTwoId: user.id }] },
    }),
  ]);
  // The friendship state is only meaningful for an authenticated viewer
  // looking at someone else's profile — the APK never asks for its own.
  let friendship: FriendshipState | null = null;
  if (currentUserId && currentUserId !== user.id) {
    friendship = await getFriendshipState(currentUserId, user.id);
  }
  return {
    user: toProfileUser(user, { friendsCount, postsCount }),
    posts: user.posts.map((p) => toFeedPost(p, currentUserId)),
    friendship,
  };
}

export async function updateProfile(
  userId: string,
  input: Partial<{ nickname: string; bio: string | null; avatarUrl: string | null }>,
): Promise<AuthUser> {
  try {
    const data: Record<string, unknown> = {};
    if (input.nickname !== undefined) data.nickname = normalizeNickname(input.nickname);
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
