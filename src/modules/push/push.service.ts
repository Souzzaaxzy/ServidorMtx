import { prisma } from '../../config/prisma.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/errors.js';
import { NotificationType } from '../../types/enums.js';

// ── Push dispatch ────────────────────────────────────────────
// The MATRIX push transport lives entirely inside ServidorMtx (no separate
// server, no third-party SDK):
//
//   event (like/comment/friend) → SQLite notification row → dispatch →
//   in-app realtime WebSocket → the APK turns it into a native Android
//   notification via NotificationManager (Goo-independent, 100% MATRIX).
//
// Dedupe: every persisted notification has a unique id; the dispatcher
// keeps an LRU of already-dispatched ids so a retried event NEVER produces
// duplicate pushes for the same notification.

export interface PushSocket {
  send(data: string): void;
}

export interface PushMessage {
  kind: 'notification';
  title: string;
  body: string;
  data: {
    notificationId: string;
    type: string;
    actorNickname: string;
    postId: string | null;
    commentId: string | null;
    friendRequestId: string | null;
  };
}

// In-memory realtime hub: userId → live sockets of that user.
const sockets = new Map<string, Set<PushSocket>>();

// Dedupe LRU of dispatched notification ids (bounded).
const MAX_DISPATCHED = 10_000;
const dispatched: string[] = [];
const dispatchedSet = new Set<string>();

function rememberDispatched(id: string): boolean {
  if (dispatchedSet.has(id)) return false;
  dispatchedSet.add(id);
  dispatched.push(id);
  if (dispatched.length > MAX_DISPATCHED) {
    const evicted = dispatched.splice(0, MAX_DISPATCHED / 2);
    for (const e of evicted) dispatchedSet.delete(e);
  }
  return true;
}

export function addSocket(userId: string, socket: PushSocket): void {
  let set = sockets.get(userId);
  if (!set) {
    set = new Set();
    sockets.set(userId, set);
  }
  set.add(socket);
}

export function removeSocket(userId: string, socket: PushSocket): void {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) sockets.delete(userId);
}

export function socketsOf(userId: string): number {
  return sockets.get(userId)?.size ?? 0;
}

// The canonical PT-BR body text shared by the in-app list and the native
// Android notification (single rendering point — never recompose in the
// APK).
export function composeBody(type: string, actorNickname: string): string {
  switch (type) {
    case NotificationType.LIKE:
      return `${actorNickname} curtiu sua publicação.`;
    case NotificationType.COMMENT:
      return `${actorNickname} comentou na sua publicação.`;
    case NotificationType.FRIEND_REQUEST:
      return `${actorNickname} enviou uma solicitação de amizade.`;
    case NotificationType.FRIEND_ACCEPTED:
      return `Agora você e ${actorNickname} são amigos.`;
    default:
      return `${actorNickname} interagiu com você.`;
  }
}

export function buildMessage(
  notification: {
    id: string;
    type: string;
    postId: string | null;
    commentId: string | null;
    friendRequestId: string | null;
  },
  actorNickname: string,
): PushMessage {
  return {
    kind: 'notification',
    title: 'MATRIX',
    body: composeBody(notification.type, actorNickname),
    data: {
      notificationId: notification.id,
      type: notification.type,
      actorNickname,
      postId: notification.postId,
      commentId: notification.commentId,
      friendRequestId: notification.friendRequestId,
    },
  };
}

/**
 * Dispatches one notification to its recipient. Returns true when the push
 * was actually dispatched; false when deduped. Caller decides how critical
 * it is — errors from sockets are logged, not thrown.
 *
 * The actor's nickname is resolved from the notification row (one indexed
 * lookup) so callers only pass the persisted row.
 */
export async function dispatchNotification(
  recipientId: string,
  notification: {
    id: string;
    actorId: string;
    type: string;
    postId: string | null;
    commentId: string | null;
    friendRequestId: string | null;
  },
): Promise<boolean> {
  if (!rememberDispatched(notification.id)) return false;
  const actor = await prisma.user.findUnique({
    where: { id: notification.actorId },
    select: { nickname: true },
  });
  const actorNickname = actor?.nickname ?? 'desconhecido';
  const message = buildMessage(notification, actorNickname);
  const payload = JSON.stringify(message);

  const live = sockets.get(recipientId);
  if (live) {
    for (const socket of live) {
      try {
        socket.send(payload);
      } catch (err) {
        logger.warn({ err }, 'push socket send failed');
      }
    }
  }

  return true;
}

// ── Device tokens ───────────────────────────────────────────
// Token registration binds the install token to the authenticated user.
// Upsert on token keeps re-registration idempotent (no duplicates when the
// app re-opens), and logout cleans its tokens up.

export async function registerDevice(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  await prisma.device.upsert({
    where: { token },
    update: { userId, platform },
    create: { userId, token, platform },
  });
}

export async function unregisterDevice(userId: string, token: string): Promise<void> {
  const device = await prisma.device.findUnique({ where: { token } });
  if (!device) return; // idempotent: already gone
  if (device.userId !== userId) {
    throw ApiError.forbidden('Você não pode remover o dispositivo de outro usuário.');
  }
  await prisma.device.delete({ where: { token } });
}

export async function unregisterAllDevices(userId: string): Promise<void> {
  await prisma.device.deleteMany({ where: { userId } });
}
