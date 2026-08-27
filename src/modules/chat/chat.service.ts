import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, nicknameCosmetics } from '../../utils/dto.js';
import { areFriends } from '../friends/friend.service.js';
import { dispatchChatMessage, dispatchChatRead, dispatchChatTyping } from '../push/push.service.js';
import type { Message } from '../../generated/index.js';

// ── Private chat ─────────────────────────────────────────────
// One conversation per user PAIR (ordered ids), messaging allowed ONLY
// between accepted friends. Every sender is derived from the AUTHENTICATED
// token user — the client never supplies a senderId. A user can only read/
// write conversations they belong to (membership enforced on every load).

/** Hard server-side limit for a single message (the authority). */
export const CONVERSATION_MESSAGE_LIMIT = 4000;

/** Truncated preview length for the conversations list. */
const PREVIEW_LENGTH = 80;

export interface ChatUser {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  nameColor: string | null;
  nameColorId: string | null;
  frameId: string | null;
  frameAsset: string | null;
}

export interface ConversationItem {
  id: string;
  otherUser: ChatUser;
  lastMessage: {
    id: string;
    content: string;
    senderId: string;
    createdAt: string;
  } | null;
  /** Whether the session user was the last sender (drives the "Você:" prefix). */
  lastMine: boolean;
  unreadCount: number;
  updatedAt: string;
}

export interface MessageItem {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  mine: boolean;
  /** Milliseconds since epoch when the RECIPIENT of this message read it
   * (i.e. when the conversation was marked read by the other side). Null
   * while the recipient has not opened/read it yet. Drives the in-bubble
   * "enviado" → "visto agora" hint AND the unread badge. */
  readAt: string | null;
  /** Reply reference: the ORIGINAL message this one answers (if any). The
   * original's PREVIEW is resolved server-side (never stored on this row);
   * null/invalid when not a reply or the original was deleted. */
  replyTo: ReplyInfo | null;
}

/** Preview of the original message a reply points at. Compact — the app
 * renders the original sender's nickname + content directly above the reply
 * body. `exists` is false when the original was deleted (graceful degrade). */
export interface ReplyInfo {
  id: string;
  senderId: string;
  senderNickname: string;
  content: string;
  exists: boolean;
}

export interface MessagePage {
  messages: MessageItem[];
  hasMore: boolean;
}

// Reuses the shared author select (id + nickname + avatar + equipped
// nickname cosmetics) so chat nicknames render each user's own color/frame.
export const CHAT_USER_SELECT = AUTHOR_SELECT;

function toChatUser(
  user: { id: string; nickname: string; avatarUrl: string | null } & {
    equippedItems?: {
      slot: string;
      item: { id: string; name: string; assetUrl: string; config: string };
    }[];
  },
): ChatUser {
  const cosmetics = nicknameCosmetics(user);
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    ...cosmetics,
  };
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function ensureRecipient(otherUserId: string): Promise<void> {
  const other = await prisma.user.findUnique({
    where: { id: otherUserId },
    select: { id: true },
  });
  if (!other) throw ApiError.notFound('Usuário não encontrado.');
}

// ── Get-or-create a conversation with another user ───────────
// Only accepted friends may start a private conversation. Returns the
// existing conversation when one already exists — never creates duplicates.
export async function getOrCreateConversation(
  userId: string,
  otherUserId: string,
): Promise<ConversationItem> {
  if (userId === otherUserId) {
    throw ApiError.invalidRequest('Você não pode conversar consigo mesmo.');
  }
  await ensureRecipient(otherUserId);
  const friends = await areFriends(userId, otherUserId);
  if (!friends) {
    throw ApiError.forbidden('Vocês precisam ser amigos para iniciar uma conversa.');
  }
  const [one, two] = orderedPair(userId, otherUserId);
  let conversation = await prisma.conversation.findUnique({
    where: { userOneId_userTwoId: { userOneId: one, userTwoId: two } },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { userOneId: one, userTwoId: two },
    });
  }
  return loadConversationItem(conversation.id, userId);
}

// ── Conversations list (Chat tab) ────────────────────────────
// Returns every conversation the user participates in, ordered by last
// activity, each with the OTHER user embedded (their own name color/frame).
export async function listConversations(userId: string): Promise<ConversationItem[]> {
  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ userOneId: userId }, { userTwoId: userId }] },
    orderBy: { updatedAt: 'desc' },
    include: {
      userOne: { select: CHAT_USER_SELECT },
      userTwo: { select: CHAT_USER_SELECT },
    },
  });
  return Promise.all(conversations.map((c) => buildConversationItem(c, userId)));
}

// ── Load a single conversation (enforce membership) ──────────
async function loadConversationItem(
  conversationId: string,
  userId: string,
): Promise<ConversationItem> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      userOne: { select: CHAT_USER_SELECT },
      userTwo: { select: CHAT_USER_SELECT },
    },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  if (conversation.userOneId !== userId && conversation.userTwoId !== userId) {
    throw ApiError.forbidden('Você não tem acesso a esta conversa.');
  }
  return buildConversationItem(conversation, userId);
}

async function buildConversationItem(
  conversation: {
    id: string;
    userOneId: string;
    userTwoId: string;
    updatedAt: Date;
    userOne: {
      id: string;
      nickname: string;
      avatarUrl: string | null;
      equippedItems?: {
        slot: string;
        item: { id: string; name: string; assetUrl: string; config: string };
      }[];
    };
    userTwo: {
      id: string;
      nickname: string;
      avatarUrl: string | null;
      equippedItems?: {
        slot: string;
        item: { id: string; name: string; assetUrl: string; config: string };
      }[];
    };
  },
  userId: string,
): Promise<ConversationItem> {
  const other = conversation.userOneId === userId
    ? conversation.userTwo
    : conversation.userOne;

  const last = await prisma.message.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true, senderId: true, createdAt: true },
  });

  // Unread for THIS user = messages from the OTHER side not yet read.
  const unreadCount = await prisma.message.count({
    where: {
      conversationId: conversation.id,
      senderId: { not: userId },
      readAt: null,
    },
  });

  return {
    id: conversation.id,
    otherUser: toChatUser(other),
    lastMessage: last
      ? {
          id: last.id,
          content:
            last.content.length > PREVIEW_LENGTH
              ? `${last.content.slice(0, PREVIEW_LENGTH)}…`
              : last.content,
          senderId: last.senderId,
          createdAt: last.createdAt.toISOString(),
        }
      : null,
    lastMine: last ? last.senderId === userId : false,
    unreadCount,
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

// ── Messages (paginated, newest-batch) ───────────────────────
// Returns a chronological page ending at the newest message (opts.before
// starts an OLDER page going further back). Pagination uses the message id
// (lexicographic on cuid grows monotonically with creation order).
export async function getMessages(
  userId: string,
  conversationId: string,
  opts: { before?: string; limit?: number },
): Promise<MessagePage> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userOneId: true, userTwoId: true },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  if (conversation.userOneId !== userId && conversation.userTwoId !== userId) {
    throw ApiError.forbidden('Você não tem acesso a esta conversa.');
  }

  const safeLimit = Math.min(Math.max(1, opts.limit ?? 30), 100);
  const where = opts.before
    ? { conversationId, id: { lt: opts.before } }
    : { conversationId };

  // Fetch newest batch (reverse-chronological), then flip to chronological.
  const messages = await prisma.message.findMany({
    where,
    orderBy: { id: 'desc' },
    take: safeLimit + 1,
  });
  const hasMore = messages.length > safeLimit;
  const page = messages.slice(0, safeLimit).reverse();

  return {
    messages: await toMessageItems(page, conversationId, userId),
    hasMore,
  };
}

// ── Message serialization ────────────────────────────────────
// `readAt`/`replyTo` must come from the RECIPIENT's perspective (the [viewer]
// for load/list, or the conversation's OTHER participant for realtime
// broadcasts) — never the sender's. The read hint flips per participant.

async function toMessageItems(
  messages: Message[],
  conversationId: string,
  viewerId: string,
): Promise<MessageItem[]> {
  // Preconditions (bypass for callers that already enriched the rows).
  if (messages.length === 0) return [];

  const replyIds = messages
    .map((m) => m.replyToMessageId)
    .filter((id): id is string => !!id);
  let replyData = new Map<string, { senderId: string; nickname: string; content: string }>();
  if (replyIds.length > 0) {
    const originals = await prisma.message.findMany({
      where: { id: { in: replyIds } },
      select: {
        id: true,
        senderId: true,
        sender: { select: { nickname: true } },
        content: true,
      },
    });
    replyData = new Map(
      originals.map((o) => [o.id, { senderId: o.senderId, nickname: o.sender.nickname, content: o.content }]),
    );
  }

  return messages.map((m) => {
    let replyTo: ReplyInfo | null = null;
    if (m.replyToMessageId) {
      const original = replyData.get(m.replyToMessageId);
      if (original) {
        replyTo = {
          id: m.replyToMessageId,
          senderId: original.senderId,
          senderNickname: original.nickname,
          content: original.content,
          exists: true,
        };
      } else {
        // Original deleted → reference exists but no preview.
        replyTo = {
          id: m.replyToMessageId,
          senderId: '',
          senderNickname: '',
          content: '',
          exists: false,
        };
      }
    }
    return {
      id: m.id,
      conversationId,
      senderId: m.senderId,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      mine: m.senderId === viewerId,
      readAt: m.readAt ? m.readAt.toISOString() : null,
      replyTo,
    };
  });
}

// ── Send a message ───────────────────────────────────────────
// Server is authoritative: sender from token, membership enforced, friends-only
// rule enforced, size/empty validated. Returns the persisted MessageItem.
export async function sendMessage(
  userId: string,
  conversationId: string,
  content: string,
  replyToMessageId?: string,
): Promise<MessageItem> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  const isMember =
    conversation.userOneId === userId || conversation.userTwoId === userId;
  if (!isMember) {
    throw ApiError.forbidden('Você não tem acesso a esta conversa.');
  }
  const otherId =
    conversation.userOneId === userId ? conversation.userTwoId : conversation.userOneId;
  // Even if a conversation row exists, if the pair stopped being friends it
  // must not accept new messages (server-side rule, mirrors getOrCreate).
  if (!(await areFriends(userId, otherId))) {
    throw ApiError.forbidden('Vocês precisam ser amigos para conversar.');
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw ApiError.invalidRequest('A mensagem não pode estar vazia.');
  }
  if (trimmed.length > CONVERSATION_MESSAGE_LIMIT) {
    throw ApiError.invalidRequest(
      `A mensagem deve ter no máximo ${CONVERSATION_MESSAGE_LIMIT} caracteres.`,
    );
  }

  // Reply reference validation: the target must be a REAL message in the
  // SAME conversation (membership already guaranteed the pair, but the reply
  // must point at a message the sender is allowed to see). Only the id is
  // stored — the preview is resolved at load time.
  if (replyToMessageId && replyToMessageId.trim()) {
    const target = await prisma.message.findUnique({
      where: { id: replyToMessageId },
      select: { conversationId: true },
    });
    if (!target || target.conversationId !== conversationId) {
      throw ApiError.invalidRequest('Mensagem respondida não encontrada.');
    }
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        conversationId,
        senderId: userId,
        content: trimmed,
        replyToMessageId: replyToMessageId?.trim() || null,
      },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return created;
  });

  // Serialize from the RECIPIENT's perspective and deliver live (best-effort).
  // The viewer here is the OTHER side, so `mine` is false and `readAt` null —
  // this is the exact fix for the "every incoming message renders on the
  // RIGHT side" bug (the old code serialized with the SENDER as viewer).
  const [recipientView] = await toMessageItems([message], conversationId, otherId);
  dispatchChatMessage(otherId, {
    conversationId,
    message: recipientView,
  });

  // Return the sender's own view (readAt null until the peer opens it).
  const [ownView] = await toMessageItems([message], conversationId, userId);
  return ownView;
}

// ── Mark a conversation as read by the session user ──────────
export async function markConversationRead(
  userId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userOneId: true, userTwoId: true },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  const isMember =
    conversation.userOneId === userId || conversation.userTwoId === userId;
  if (!isMember) throw ApiError.forbidden('Você não tem acesso a esta conversa.');

  const otherId =
    conversation.userOneId === userId ? conversation.userTwoId : conversation.userOneId;

  // Mark every message FROM THE OTHER SIDE (unread by me) as read.
  const updated = await prisma.message.updateMany({
    where: {
      conversationId,
      senderId: { not: userId },
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  // Realtime: tell the OTHER side its messages were just read so their own
  // last sent bubble flips "enviado" → "visto agora" without refreshing.
  if (updated.count > 0) {
    dispatchChatRead(otherId, { conversationId });
  }
}

// ── Typing indicator ─────────────────────────────────────────
// Ephemeral realtime signal. Membership is enforced (only participants may
// signal typing); nothing is persisted. The peer's live sockets receive a
// `chat_typing` frame; the app is responsible for clearing it on its own
// time-out / when leaving the conversation.
export async function setTyping(
  userId: string,
  conversationId: string,
  typing: boolean,
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userOneId: true, userTwoId: true },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  const isMember =
    conversation.userOneId === userId || conversation.userTwoId === userId;
  if (!isMember) throw ApiError.forbidden('Você não tem acesso a esta conversa.');

  const otherId =
    conversation.userOneId === userId ? conversation.userTwoId : conversation.userOneId;
  dispatchChatTyping(otherId, { conversationId, typing });
}

// ── Unread conversations badge (Chat tab) ────────────────────
export async function unreadConversationCount(userId: string): Promise<number> {
  // Any conversation in which the other side sent a message I haven't read.
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [
        {
          userOneId: userId,
          messages: {
            some: { senderId: { not: userId }, readAt: null },
          },
        },
        {
          userTwoId: userId,
          messages: {
            some: { senderId: { not: userId }, readAt: null },
          },
        },
      ],
    },
    select: { id: true },
  });
  return conversations.length;
}