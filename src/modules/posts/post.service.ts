import { Prisma } from '../../generated/index.js';
import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { toFeedPost, type FeedPost } from '../../utils/dto.js';
import type { CreatePostInput, FeedQuery } from './post.schema.js';
import { grantXp, XP_REWARDS, XpReason } from '../../gamification/xp.service.js';
import { grantCoins, COIN_REWARDS, CoinReason } from '../../gamification/coin.service.js';

const FEED_INCLUDE = {
  user: { select: { id: true, name: true, username: true, avatarUrl: true } },
  _count: { select: { likes: true, comments: true } },
} as const;

export async function createPost(
  userId: string,
  input: CreatePostInput,
): Promise<FeedPost> {
  const post = await prisma.post.create({
    data: {
      userId,
      text: input.text?.trim() || null,
      imageUrl: input.imageUrl ?? null,
    },
    include: {
      ...FEED_INCLUDE,
      likes: { where: { userId }, select: { userId: true } },
    },
  });

  // Server-controlled reward for content creation. The client never decides
  // the amount — these constants live only on the server.
  await grantXp({ userId, amount: XP_REWARDS.POST_CREATED, reason: XpReason.POST_CREATED, source: 'post:create' }).catch(() => void 0);
  await grantCoins({ userId, amount: COIN_REWARDS.POST_CREATED, type: 'EARN', reason: CoinReason.POST_CREATED }).catch(() => void 0);

  return toFeedPost(post, userId);
}

export interface FeedPage {
  posts: FeedPost[];
  nextCursor: string | null;
}

export async function getFeed(
  currentUserId: string | undefined,
  query: FeedQuery,
): Promise<FeedPage> {
  const { limit, cursor } = query;

  const where: Prisma.PostWhereInput = cursor
    ? { createdAt: { lt: new Date(cursor) } }
    : {};

  const posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      user: { select: { id: true, name: true, username: true, avatarUrl: true } },
      _count: { select: { likes: true, comments: true } },
      ...(currentUserId
        ? { likes: { where: { userId: currentUserId }, select: { userId: true } } }
        : {}),
    },
  });

  const hasMore = posts.length > limit;
  const slice = hasMore ? posts.slice(0, limit) : posts;
  const nextCursor = hasMore ? slice[slice.length - 1].createdAt.toISOString() : null;

  return {
    posts: slice.map((p) => toFeedPost(p, currentUserId)),
    nextCursor,
  };
}

export async function getPostById(id: string, currentUserId?: string): Promise<FeedPost> {
  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, username: true, avatarUrl: true } },
      _count: { select: { likes: true, comments: true } },
      ...(currentUserId
        ? { likes: { where: { userId: currentUserId }, select: { userId: true } } }
        : {}),
    },
  });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');
  return toFeedPost(post, currentUserId);
}

export async function deletePost(userId: string, postId: string): Promise<void> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { userId: true, imageUrl: true },
  });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');
  // Authorization is checked server-side; never trust a client id alone.
  if (post.userId !== userId) {
    throw ApiError.forbidden('Você não pode excluir a publicação de outro usuário.');
  }
  await prisma.post.delete({ where: { id: postId } });
}
