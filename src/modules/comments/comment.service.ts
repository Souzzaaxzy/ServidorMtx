import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, toPostComment, type PostComment } from '../../utils/dto.js';
import type { CreateCommentInput, ListCommentsQuery } from './comment.schema.js';
import { grantXp, XP_REWARDS, XpReason } from '../../gamification/xp.service.js';
import { NotificationType } from '../../types/enums.js';
import { dispatchNotification } from '../push/push.service.js';

const COMMENT_INCLUDE = {
  user: { select: AUTHOR_SELECT },
  _count: { select: { commentLikes: true, replies: true } },
} as const;

/**
 * Builds the Prisma `include` for a comment query. Always embeds the author
 * plus the like/reply counters; when [viewerId] is present it also selects the
 * viewer's own like rows (used to compute the per-viewer `liked` flag).
 */
function commentIncludeWithLikes(viewerId?: string) {
  const include = {
    user: { select: AUTHOR_SELECT },
    _count: { select: { commentLikes: true, replies: true } },
  } as Record<string, unknown>;
  if (viewerId) {
    include.commentLikes = { where: { userId: viewerId }, select: { userId: true } };
  }
  return include;
}

/**
 * Reads one comment; throws when it does not exist. Used by all mutations so
 * every operation validates the target before touching data.
 */
async function findCommentOrThrow(commentId: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      postId: true,
      userId: true,
      parentCommentId: true,
      post: { select: { userId: true } },
    },
  });
  if (!comment) throw ApiError.notFound('Comentário não encontrado.');
  return comment;
}

export async function createComment(
  userId: string,
  postId: string,
  input: CreateCommentInput,
): Promise<PostComment> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, userId: true } });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');

  const comment = await prisma.comment.create({
    data: { userId, postId, text: input.text.trim() },
    include: COMMENT_INCLUDE,
  });

  // Server-controlled reward for engagement.
  await grantXp({ userId, amount: XP_REWARDS.COMMENT_CREATED, reason: XpReason.COMMENT_CREATED, source: `comment:${postId}` }).catch(() => void 0);

  // Notify the post author — never the commenter themselves.
  if (post.userId !== userId) {
    const note = await prisma.notification.create({
      data: {
        recipientId: post.userId,
        actorId: userId,
        type: NotificationType.COMMENT,
        postId,
        commentId: comment.id,
      },
    });
    await dispatchNotification(post.userId, note);
  }

  return toPostComment(comment, userId);
}

/**
 * Creates a REPLY to an existing comment. The reply sits directly under its
 * top-level parent (one level deep only) so the hierarchy stays flat and the
 * 5-visible-replies grouping is simple and predictable.
 */
export async function replyToComment(
  userId: string,
  parentCommentId: string,
  input: CreateCommentInput,
): Promise<PostComment> {
  const parent = await findCommentOrThrow(parentCommentId);
  // Replies to replies are re-parented onto the top-level comment to keep the
  // visual tree one level deep.
  const rootId = parent.parentCommentId ?? parent.id;

  const reply = await prisma.comment.create({
    data: {
      userId,
      postId: parent.postId,
      parentCommentId: rootId,
      text: input.text.trim(),
    },
    include: COMMENT_INCLUDE,
  });

  // Reward the author of the parent comment (never self).
  if (parent.userId !== userId) {
    await grantXp({ userId: parent.userId, amount: XP_REWARDS.COMMENT_RECEIVED, reason: XpReason.COMMENT_RECEIVED, source: `comment:${rootId}` }).catch(() => void 0);
    const note = await prisma.notification.create({
      data: {
        recipientId: parent.userId,
        actorId: userId,
        type: NotificationType.COMMENT,
        postId: parent.postId,
        commentId: reply.id,
      },
    });
    await dispatchNotification(parent.userId, note);
  }

  return toPostComment(reply, userId);
}

export interface CommentPage {
  comments: PostComment[];
  nextCursor: string | null;
}

export interface ReplyPage {
  replies: PostComment[];
  nextCursor: string | null;
}

/**
 * Lists the TOP-LEVEL comments of a post (parentCommentId = null), oldest
 * first for a natural reading order. Each comment carries its total like
 * count and, when an authenticated viewer is present, its per-viewer liked
 * state. Paginated by cursor.
 */
export async function listComments(
  postId: string,
  query: ListCommentsQuery,
  viewerId?: string,
): Promise<CommentPage> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');

  const { limit, cursor } = query;
  const where = cursor
    ? { postId, parentCommentId: null, createdAt: { lt: new Date(cursor) } }
    : { postId, parentCommentId: null };
  const comments = await prisma.comment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: commentIncludeWithLikes(viewerId),
  });
  const hasMore = comments.length > limit;
  const slice = hasMore ? comments.slice(0, limit) : comments;
  const nextCursor = hasMore ? slice[slice.length - 1].createdAt.toISOString() : null;
  return {
    comments: slice.map((c) => toPostComment(c as never, viewerId)),
    nextCursor,
  };
}

/**
 * Lists the replies of a top-level comment, oldest first (natural reading
 * order under the parent). The app shows the first 5 and reveals the rest on
 * demand; the server always returns every reply and never truncates.
 */
export async function listCommentReplies(
  parentCommentId: string,
  query: ListCommentsQuery,
  viewerId?: string,
): Promise<ReplyPage> {
  await findCommentOrThrow(parentCommentId);
  const { limit, cursor } = query;
  const where = cursor
    ? { parentCommentId, createdAt: { gt: new Date(cursor) } }
    : { parentCommentId };
  const replies = await prisma.comment.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: limit + 1,
    include: commentIncludeWithLikes(viewerId),
  });
  const hasMore = replies.length > limit;
  const slice = hasMore ? replies.slice(0, limit) : replies;
  const nextCursor = hasMore ? slice[slice.length - 1].createdAt.toISOString() : null;
  return {
    replies: slice.map((r) => toPostComment(r as never, viewerId)),
    nextCursor,
  };
}

/**
 * Toggles a like on a comment/reply (server is the source of truth). Returns
 * the resulting liked state and total like count so the app can sync without
 * a reload. The comment's author earns XP once per new like (never self).
 */
export async function toggleCommentLike(
  userId: string,
  commentId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const comment = await findCommentOrThrow(commentId);

  const existing = await prisma.commentLike.findUnique({
    where: { userId_commentId: { userId, commentId } },
    select: { userId: true },
  });

  if (existing) {
    await prisma.commentLike.delete({
      where: { userId_commentId: { userId, commentId } },
    });
    await prisma.notification.deleteMany({
      where: {
        recipientId: comment.userId,
        actorId: userId,
        type: NotificationType.LIKE,
        commentId,
        postId: comment.postId,
      },
    });
  } else {
    await prisma.commentLike.create({ data: { userId, commentId } });
    if (comment.userId !== userId) {
      await grantXp({ userId: comment.userId, amount: XP_REWARDS.LIKE_RECEIVED, reason: XpReason.LIKE_RECEIVED, source: `comment:${commentId}` }).catch(() => void 0);
      const note = await prisma.notification.create({
        data: {
          recipientId: comment.userId,
          actorId: userId,
          type: NotificationType.LIKE,
          postId: comment.postId,
          commentId,
        },
      });
      await dispatchNotification(comment.userId, note);
    }
  }

  const likeCount = await prisma.commentLike.count({ where: { commentId } });
  return { liked: !existing, likeCount };
}

export async function deleteComment(userId: string, commentId: string): Promise<void> {
  const comment = await findCommentOrThrow(commentId);
  if (comment.userId !== userId) {
    throw ApiError.forbidden('Você não pode excluir o comentário de outro usuário.');
  }
  // Deleting a top-level comment cascades its replies and likes (schema).
  await prisma.comment.delete({ where: { id: commentId } });
}
