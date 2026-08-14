import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { toPostComment, type PostComment } from '../../utils/dto.js';
import type { CreateCommentInput, ListCommentsQuery } from './comment.schema.js';
import { grantXp, XP_REWARDS, XpReason } from '../../gamification/xp.service.js';

const COMMENT_INCLUDE = {
  user: { select: { id: true, name: true, username: true, avatarUrl: true } },
} as const;

export async function createComment(
  userId: string,
  postId: string,
  input: CreateCommentInput,
): Promise<PostComment> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');

  const comment = await prisma.comment.create({
    data: { userId, postId, text: input.text.trim() },
    include: COMMENT_INCLUDE,
  });

  // Server-controlled reward for engagement.
  await grantXp({ userId, amount: XP_REWARDS.COMMENT_CREATED, reason: XpReason.COMMENT_CREATED, source: `comment:${postId}` }).catch(() => void 0);

  return toPostComment(comment);
}

export interface CommentPage {
  comments: PostComment[];
  nextCursor: string | null;
}

export async function listComments(postId: string, query: ListCommentsQuery): Promise<CommentPage> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');

  const { limit, cursor } = query;
  const where = cursor ? { postId, createdAt: { lt: new Date(cursor) } } : { postId };
  const comments = await prisma.comment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: COMMENT_INCLUDE,
  });
  const hasMore = comments.length > limit;
  const slice = hasMore ? comments.slice(0, limit) : comments;
  const nextCursor = hasMore ? slice[slice.length - 1].createdAt.toISOString() : null;
  return {
    comments: slice.map(toPostComment),
    nextCursor,
  };
}

export async function deleteComment(userId: string, commentId: string): Promise<void> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { userId: true },
  });
  if (!comment) throw ApiError.notFound('Comentário não encontrado.');
  if (comment.userId !== userId) {
    throw ApiError.forbidden('Você não pode excluir o comentário de outro usuário.');
  }
  await prisma.comment.delete({ where: { id: commentId } });
}
