import { prisma } from '../../config/prisma.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/errors.js';
import { NotificationType } from '../../types/enums.js';

// ── Push dispatch ────────────────────────────────────────────
// The MATRIX push architecture is a pluggable transport, integrated into
// ServidorMtx (no separate server):
//
//   event (like/comment/friend) → SQLite notification row → dispatch →
//   in-app realtime socket (native Android notification while the app
//   process is alive) + device tokens stored for a future external
//   provider slot (FCM-ready: registerExternalProvider()).
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
    actorUsername: string;
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
export function composeBody(type: string, actorUsername: string): string {
  switch (type) {
    case NotificationType.LIKE:
      return `@${actorUsername} curtiu sua publicação.`;
    case NotificationType.COMMENT:
      return `@${actorUsername} comentou na sua publicação.`;
    case NotificationType.FRIEND_REQUEST:
      return `@${actorUsername} enviou uma solicitação de amizade.`;
    case NotificationType.FRIEND_ACCEPTED:
      return `Agora você e @${actorUsername} são amigos.`;
    default:
      return `@${actorUsername} interagiu com você.`;
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
  actorUsername: string,
): PushMessage {
  return {
    kind: 'notification',
    title: 'MATRIX',
    body: composeBody(notification.type, actorUsername),
    data: {
      notificationId: notification.id,
      type: notification.type,
      actorUsername,
      postId: notification.postId,
      commentId: notification.commentId,
      friendRequestId: notification.friendRequestId,
    },
  };
}

// Optional external provider slot (e.g. Firebase Cloud Messaging). The
// built-in realtime socket is always used; if a provider is registered at
// boot, device tokens are sent through it as well. Kept as a function
// reference so no third-party SDK is a hard dependency.
export type ExternalPushSender = (
  devices: { token: string; platform: string }[],
  message: PushMessage,
) => Promise<void>;

let externalSender: ExternalPushSender | null = null;

export function registerExternalProvider(sender: ExternalPushSender): void {
  externalSender = sender;
}

/**
 * Dispatches one notification to its recipient. Returns true when the push
 * was actually dispatched; false when deduped. Caller decides how critical
 * it is — errors from sockets/providers are logged, not thrown.
 *
 * The actor's username is resolved from the notification row (one indexed
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
    select: { username: true },
  });
  const actorUsername = actor?.username ?? 'desconhecido';
  const message = buildMessage(notification, actorUsername);
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

  if (externalSender) {
    const devices = await prisma.device.findMany({
      where: { userId: recipientId },
      select: { token: true, platform: true },
    });
    if (devices.length > 0) {
      await externalSender(devices, message).catch((err) =>
        logger.warn({ err }, 'external push provider failed'),
      );
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
