import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { grantXp, XP_REWARDS, XpReason } from '../../gamification/xp.service.js';
import { NotificationType } from '../../types/enums.js';
import { dispatchNotification } from '../push/push.service.js';

// Toggle like: if the user has already liked the post, remove the like;
// otherwise create it. Returns the resulting state + updated count. When a
// like is newly created, the post's author earns XP (server-controlled).
export async function toggleLike(userId: string, postId: string): Promise<{ liked: boolean; likeCount: number }> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, userId: true } });
  if (!post) throw ApiError.notFound('Publicação não encontrada.');

  const existing = await prisma.like.findUnique({
    where: { userId_postId: { userId, postId } },
    select: { userId: true },
  });

  if (existing) {
    await prisma.like.delete({ where: { userId_postId: { userId, postId } } });
    // Removed like also removes its notification so likes never stay
    // "phantom" after an unlike (notification created at like time).
    await prisma.notification.deleteMany({
      where: { recipientId: post.userId, actorId: userId, type: NotificationType.LIKE, postId },
    });
  } else {
    await prisma.like.create({ data: { userId, postId } });
    // Reward the author (not the liker) for receiving engagement. Never
    // self-reward: liking your own post grants nothing.
    if (post.userId !== userId) {
      await grantXp({ userId: post.userId, amount: XP_REWARDS.LIKE_RECEIVED, reason: XpReason.LIKE_RECEIVED, source: `like:${postId}` }).catch(() => void 0);
      // Persistence: the LIKE notification lives in SQLite, not the APK.
      // The same row then feeds the push dispatcher (socket + provider).
      const note = await prisma.notification.create({
        data: { recipientId: post.userId, actorId: userId, type: NotificationType.LIKE, postId },
      });
      await dispatchNotification(post.userId, note);
    }
  }

  const likeCount = await prisma.like.count({ where: { postId } });
  return { liked: !existing, likeCount };
}
