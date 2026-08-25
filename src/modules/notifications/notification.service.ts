import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { toNotificationItem, type NotificationItem } from '../../utils/dto.js';

const NOTIFICATION_INCLUDE = {
  actor: { select: { id: true, name: true, username: true, avatarUrl: true } },
  friendRequest: { select: { id: true, status: true } },
} as const;

export interface NotificationPage {
  notifications: NotificationItem[];
  unreadCount: number;
}

export async function listNotifications(userId: string): Promise<NotificationPage> {
  const [notifications, unreadCount] = await prisma.$transaction([
    prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: NOTIFICATION_INCLUDE,
    }),
    prisma.notification.count({ where: { recipientId: userId, read: false } }),
  ]);
  return {
    notifications: notifications.map(toNotificationItem),
    unreadCount,
  };
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { recipientId: true },
  });
  if (!notification) throw ApiError.notFound('Notificação não encontrada.');
  if (notification.recipientId !== userId) {
    throw ApiError.forbidden('Você não pode ler a notificação de outro usuário.');
  }
  await prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  });
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { recipientId: userId, read: false },
    data: { read: true },
  });
}

// Lightweight badge counter — the APK polls this instead of fetching the
// whole list when it only needs the unread number.
export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { recipientId: userId, read: false } });
}
