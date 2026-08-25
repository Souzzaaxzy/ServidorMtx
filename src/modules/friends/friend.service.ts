import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, toFriendRequestItem, toPublicUser, type FriendRequestItem, type PublicUser } from '../../utils/dto.js';
import { FriendRequestStatus, FriendshipState, NotificationType } from '../../types/enums.js';
import { dispatchNotification } from '../push/push.service.js';

const SENDER_INCLUDE = {
  sender: { select: AUTHOR_SELECT },
} as const;

// Friendship is stored as an unordered pair (sorted ids) so one row always
// represents exactly one friendship, no matter who sent the request.
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function findPending(viewerId: string, otherId: string) {
  return prisma.friendRequest.findFirst({
    where: {
      status: FriendRequestStatus.PENDING,
      OR: [
        { senderId: viewerId, receiverId: otherId },
        { senderId: otherId, receiverId: viewerId },
      ],
    },
    select: { id: true, senderId: true },
  });
}

export async function areFriends(viewerId: string, otherId: string): Promise<boolean> {
  const [one, two] = orderedPair(viewerId, otherId);
  const row = await prisma.friendship.findUnique({
    where: { userOneId_userTwoId: { userOneId: one, userTwoId: two } },
    select: { id: true },
  });
  return row !== null;
}

// The relationship the viewer has with the other user — the APK maps this
// to the friendship button states (Seguir / Solicitado / Amigos).
export async function getFriendshipState(viewerId: string, otherId: string): Promise<FriendshipState> {
  if (viewerId === otherId) return FriendshipState.NONE;
  if (await areFriends(viewerId, otherId)) return FriendshipState.FRIENDS;
  const pending = await findPending(viewerId, otherId);
  if (pending) {
    return pending.senderId === viewerId
      ? FriendshipState.OUTGOING_PENDING
      : FriendshipState.INCOMING_PENDING;
  }
  return FriendshipState.NONE;
}

export async function sendFriendRequest(senderId: string, receiverId: string): Promise<FriendRequestItem> {
  if (senderId === receiverId) {
    throw ApiError.invalidRequest('Você não pode enviar uma solicitação para si mesmo.');
  }
  const receiver = await prisma.user.findUnique({ where: { id: receiverId }, select: { id: true } });
  if (!receiver) throw ApiError.notFound('Usuário não encontrado.');

  if (await areFriends(senderId, receiverId)) {
    throw ApiError.conflict('Vocês já são amigos.');
  }
  const existing = await prisma.friendRequest.findUnique({
    where: { senderId_receiverId: { senderId, receiverId } },
    select: { id: true },
  });
  if (existing) {
    throw ApiError.conflict('Solicitação já enviada.');
  }
  // Mutual pending requests (B→A while A→B exists) are also rejected so the
  // button never shows a duplicate path; the receiver should accept instead.
  const inverse = await prisma.friendRequest.findUnique({
    where: { senderId_receiverId: { senderId: receiverId, receiverId: senderId } },
    select: { id: true },
  });
  if (inverse) {
    throw ApiError.conflict('Já existe uma solicitação pendente entre vocês.');
  }

  const request = await prisma.friendRequest.create({
    data: { senderId, receiverId },
    include: SENDER_INCLUDE,
  });

  const note = await prisma.notification.create({
    data: {
      recipientId: receiverId,
      actorId: senderId,
      type: NotificationType.FRIEND_REQUEST,
      friendRequestId: request.id,
    },
  });
  await dispatchNotification(receiverId, note);

  return toFriendRequestItem(request);
}

export async function listPendingRequests(userId: string): Promise<FriendRequestItem[]> {
  const requests = await prisma.friendRequest.findMany({
    where: { receiverId: userId, status: FriendRequestStatus.PENDING },
    orderBy: { createdAt: 'desc' },
    include: SENDER_INCLUDE,
  });
  return requests.map(toFriendRequestItem);
}

async function loadOwnedRequest(userId: string, requestId: string) {
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
    select: { id: true, senderId: true, receiverId: true, status: true },
  });
  if (!request) throw ApiError.notFound('Solicitação não encontrada.');
  // Authorization is enforced SERVER-SIDE: only the receiver may respond.
  if (request.receiverId !== userId) {
    throw ApiError.forbidden('Você não pode responder a esta solicitação.');
  }
  if (request.status !== FriendRequestStatus.PENDING) {
    throw ApiError.conflict('Esta solicitação já foi respondida.');
  }
  return request;
}

export async function acceptRequest(userId: string, requestId: string): Promise<void> {
  const request = await loadOwnedRequest(userId, requestId);
  const [one, two] = orderedPair(request.senderId, request.receiverId);
  // Accept notifies BOTH sides: the sender learns the request was accepted,
  // and the acceptor gets their own persistent "Agora vocês são amigos"
  // entry. Each notification carries the OTHER user as its actor, so the
  // tap target (profile of the other side) is correct on both ends.
  const created = await prisma.$transaction(async (tx) => {
    await tx.friendRequest.update({
      where: { id: request.id },
      data: { status: FriendRequestStatus.ACCEPTED },
    });
    await tx.friendship.create({
      data: { userOneId: one, userTwoId: two },
    });
    // The actionable FRIEND_REQUEST notification disappears once answered.
    await tx.notification.deleteMany({
      where: { friendRequestId: request.id },
    });
    const forSender = await tx.notification.create({
      data: {
        recipientId: request.senderId,
        actorId: userId,
        type: NotificationType.FRIEND_ACCEPTED,
      },
    });
    const forAcceptor = await tx.notification.create({
      data: {
        recipientId: userId,
        actorId: request.senderId,
        type: NotificationType.FRIEND_ACCEPTED,
      },
    });
    return [forSender, forAcceptor];
  });
  // Push dispatch is post-commit fire-and-forget (never blocks the 204).
  for (const note of created) {
    await dispatchNotification(note.recipientId, note).catch(() => void 0);
  }
}

export async function rejectRequest(userId: string, requestId: string): Promise<void> {
  const request = await loadOwnedRequest(userId, requestId);
  // Deleting the row cascades to the FRIEND_REQUEST notification (FK),
  // removing the actionable card. A retry from the sender stays possible.
  await prisma.friendRequest.delete({ where: { id: request.id } });
}

// ── Friends list (accepted friendships only) ────────────────
// The profile's "Amigos" bottom sheet reads this page-by-page; the counter
// uses the same query shape with a count, so list and number ALWAYS agree.
export interface FriendsPage {
  friends: PublicUser[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listFriends(
  userId: string,
  page: number,
  pageSize: number,
): Promise<FriendsPage> {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(Math.max(1, pageSize), 50);
  const where = { OR: [{ userOneId: userId }, { userTwoId: userId }] };
  const [total, rows] = await prisma.$transaction([
    prisma.friendship.count({ where }),
    prisma.friendship.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safeSize,
      take: safeSize,
      include: {
        userOne: { select: { ...AUTHOR_SELECT, bio: true, createdAt: true } },
        userTwo: { select: { ...AUTHOR_SELECT, bio: true, createdAt: true } },
      },
    }),
  ]);
  // Friendship stores the sorted pair; pick the side that is NOT userId.
  const friends = rows.map((row) =>
    toPublicUser(row.userOneId === userId ? row.userTwo : row.userOne),
  );
  return { friends, total, page: safePage, pageSize: safeSize };
}

