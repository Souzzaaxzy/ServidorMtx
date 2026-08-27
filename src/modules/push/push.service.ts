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

// Chat realtime broadcast: delivers a `chat_message` frame to EVERY live
// socket of [userId] (the recipient). The payload embeds the SENDER's peer
// identity (`peer`) so the receiving app can render the avatar next to an
// incoming bubble, synthesize a conversation preview, and build a native
// message notification — without a second lookup. Dedupe is handled by the
// message id (see sendMessage — one broadcast call per persisted message).
// Errors are logged, never thrown, so delivery is best-effort
// fire-and-forget.
export function dispatchChatMessage(userId: string, payload: Record<string, unknown>): void {
  const live = sockets.get(userId);
  if (!live) return;
  const frame = JSON.stringify({ kind: 'chat_message', data: payload });
  for (const socket of live) {
    try {
      socket.send(frame);
    } catch (err) {
      logger.warn({ err }, 'chat socket send failed');
    }
  }
}

// ── Chat message deleted (realtime frame) ────────────────────
// Broadcast to the PEER of a conversation when one of them deletes a message
// for everyone. The peer's open conversation removes the bubble live (no
// refresh); the peer's Chat tab also refreshes its preview/unread badge.
export function dispatchChatMessageDeleted(
  peerUserId: string,
  payload: { conversationId: string; messageId: string },
): void {
  const live = sockets.get(peerUserId);
  if (!live) return;
  const frame = JSON.stringify({ kind: 'chat_message_deleted', data: payload });
  for (const socket of live) {
    try {
      socket.send(frame);
    } catch (err) {
      logger.warn({ err }, 'chat message deleted socket send failed');
    }
  }
}

// ── Comment deleted (realtime frame) ─────────────────────────
// Broadcast to every live socket of the POST AUTHOR (plus ideally viewers)
// when a comment on their post is deleted, so an open comments sheet / post
// removes it live. Pass the postId + commentId (and the authorUserId to fan
// out to).
export function dispatchCommentDeleted(
  recipientUserId: string,
  payload: { postId: string; commentId: string },
): void {
  const live = sockets.get(recipientUserId);
  if (!live) return;
  const frame = JSON.stringify({ kind: 'comment_deleted', data: payload });
  for (const socket of live) {
    try {
      socket.send(frame);
    } catch (err) {
      logger.warn({ err }, 'comment deleted socket send failed');
    }
  }
}

// ── Chat typing / read (realtime frames) ─────────────────────
// The typing + read events ride the SAME in-memory socket hub as chat
// messages and notifications — no second transport, no polling. Frames are
// small and fire-and-forget; the recipient's live sockets clear the
// indicator automatically or re-fetch unread state.

/** `typing` frame dispatched to the peer (the OTHER side of a conversation)
 * when the session user starts/stops typing. Fires only when the peer has
 * at least one live socket, so idle DM screens never waste a frame. */
export function dispatchChatTyping(
  peerUserId: string,
  payload: { conversationId: string; typing: boolean },
): void {
  const live = sockets.get(peerUserId);
  if (!live) return;
  const frame = JSON.stringify({ kind: 'chat_typing', data: payload });
  for (const socket of live) {
    try {
      socket.send(frame);
    } catch (err) {
      logger.warn({ err }, 'chat typing send failed');
    }
  }
}

/** `chat_read` frame dispatched to the peer after the session user marks a
 * conversation read: the peer's own last sent message in that conversation
 * can flip its "enviado" hint to "visto agora" in realtime. */
export function dispatchChatRead(
  peerUserId: string,
  payload: { conversationId: string },
): void {
  const live = sockets.get(peerUserId);
  if (!live) return;
  const frame = JSON.stringify({ kind: 'chat_read', data: payload });
  for (const socket of live) {
    try {
      socket.send(frame);
    } catch (err) {
      logger.warn({ err }, 'chat read send failed');
    }
  }
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
