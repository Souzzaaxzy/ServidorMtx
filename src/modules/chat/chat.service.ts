import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, nicknameCosmetics } from '../../utils/dto.js';
import { areFriends } from '../friends/friend.service.js';
import { saveAudioFile } from '../uploads/upload.service.js';
import {
  dispatchChatMessage,
  dispatchChatMessageDeleted,
  dispatchChatRead,
  dispatchChatRecording,
  dispatchChatTyping,
} from '../push/push.service.js';
import type { Message } from '../../generated/index.js';
import type { Readable } from 'node:stream';

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
  /** The raw message text. For VOICE messages this is the stable preview
   * string "🎤 Áudio" (the app renders the inline audio player instead). */
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
  /** "text" (default) | "voice". Voice messages carry [audioUrl] +
   * [durationMs] instead of rendering [content] as plain text. */
  type: 'text' | 'voice' | string;
  /** Absolute URL of the persisted voice-message audio file (voice only). */
  audioUrl: string | null;
  /** Recorded length in milliseconds, validated server-side (3–60s). */
  durationMs: number | null;
}

/** Optional sender identity embedded on realtime incoming frames so the
 * receiving app renders the avatar + synthesizes a conversation preview
 * without a second server call. */
export interface ChatPeerPayload {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  nameColor: string | null;
  nameColorId: string | null;
  frameId: string | null;
  frameAsset: string | null;
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
// Returns every conversation the user participates in (minus the ones the
// user explicitly HID for themselves — "Excluir conversa"), ordered by last
// activity, each with the OTHER user embedded (their own name color/frame).
export async function listConversations(userId: string): Promise<ConversationItem[]> {
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [{ userOneId: userId }, { userTwoId: userId }],
      // "Excluir conversa (para mim)" hides it from THIS user's list only.
      hiddenBy: { none: { userId } },
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      userOne: { select: CHAT_USER_SELECT },
      userTwo: { select: CHAT_USER_SELECT },
    },
  });

  if (conversations.length === 0) return [];

  const ids = conversations.map((c) => c.id);

  // ── Batch the per-conversation aggregates (no N+1) ──────────
  // The old load did 2 extra queries PER conversation (last message + unread
  // count), i.e. O(N) round-trips that delayed the Chat tab and the preview.
  // This replaces them with a constant number of batched queries.
  const hiddenForMe = await prisma.messageHide.findMany({
    where: { userId, message: { conversationId: { in: ids } } },
    select: { messageId: true },
  });
  const hiddenIds = new Set(hiddenForMe.map((h) => h.messageId));

  // Last visible message per conversation. cuid ids are lexicographically
  // monotonically increasing with creation time, and we ORDER BY id DESC, so
  // the FIRST non-hidden, non-deleted row per conversation IS its newest
  // visible message. Bounded to a small surplus of the conversation count so
  // a busy pair can never force a huge fetch.
  const newest = await prisma.message.findMany({
    where: { conversationId: { in: ids }, deletedAt: null },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      conversationId: true,
      content: true,
      senderId: true,
      createdAt: true,
    },
    take: ids.length * 10,
  });
  const lastByConversation = new Map<string, (typeof newest)[number]>();
  for (const m of newest) {
    if (hiddenIds.has(m.id)) continue;
    if (!lastByConversation.has(m.conversationId)) {
      lastByConversation.set(m.conversationId, m);
    }
  }

  // Unread count per conversation in ONE grouped query: messages FROM THE
  // OTHER side, not yet read, still visible to this viewer (not hidden for me,
  // not deleted for everyone).
  const unreadRows = await prisma.$queryRawUnsafe<{ conversationId: string; c: number }[]>(
    `SELECT "conversationId", COUNT(*) AS c
       FROM "messages"
      WHERE "conversationId" IN (${ids.map(() => '?').join(',')})
        AND "senderId" <> ?
        AND "readAt" IS NULL
        AND "deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "message_hides" h
           WHERE h."messageId" = "messages"."id" AND h."userId" = ?
        )
      GROUP BY "conversationId"`,
    ...ids,
    userId,
    userId,
  );
  const unreadMap = new Map<string, number>();
  for (const row of unreadRows) {
    unreadMap.set(row.conversationId, Number(row.c));
  }

  return conversations.map((c) => {
    const other = c.userOneId === userId ? c.userTwo : c.userOne;
    const last = lastByConversation.get(c.id) ?? null;
    return {
      id: c.id,
      otherUser: toChatUser(other),
      lastMessage: last
        ? {
            id: last.id,
            content: truncatePreview(last.content),
            senderId: last.senderId,
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      lastMine: last ? last.senderId === userId : false,
      unreadCount: unreadMap.get(c.id) ?? 0,
      updatedAt: c.updatedAt.toISOString(),
    };
  });
}

/** Truncates a preview string to the shared preview length. */
function truncatePreview(content: string): string {
  return content.length > PREVIEW_LENGTH
    ? `${content.slice(0, PREVIEW_LENGTH)}…`
    : content;
}

/**
 * Prisma "where" for the messages of [conversationId] that [viewerId] is
 * still allowed to see:
 *   - not soft-deleted for everyone (`deletedAt` null), AND
 *   - not hidden for the viewer specifically ("Excluir para mim").
 */
function visibleMessageWhere(conversationId: string, viewerId: string) {
  return {
    conversationId,
    deletedAt: null,
    hiddenBy: { none: { userId: viewerId } },
  } as const;
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
  const other =
    conversation.userOneId === userId ? conversation.userTwo : conversation.userOne;

  const last = await prisma.message.findFirst({
    where: visibleMessageWhere(conversationId, userId),
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true, senderId: true, createdAt: true },
  });
  const unreadCount = await prisma.message.count({
    where: {
      ...visibleMessageWhere(conversationId, userId),
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
          content: truncatePreview(last.content),
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
  // Only VISIBLE messages are returned: "Excluir para mim" (viewer-specific)
  // and "Excluir para todos" messages never reach the client.
  const baseWhere = visibleMessageWhere(conversationId, userId);
  const where = opts.before
    ? { ...baseWhere, id: { lt: opts.before } }
    : baseWhere;

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
  let replyData = new Map<string, { senderId: string; senderNickname: string; content: string; deleted: boolean }>();
  if (replyIds.length > 0) {
    const originals = await prisma.message.findMany({
      where: { id: { in: replyIds } },
      select: {
        id: true,
        senderId: true,
        sender: { select: { nickname: true } },
        content: true,
        deletedAt: true,
      },
    });
    replyData = new Map(
      originals.map((o) => [
        o.id,
        {
          senderId: o.senderId,
          senderNickname: o.sender.nickname,
          content: o.content,
          deleted: o.deletedAt !== null,
        },
      ]),
    );
  }

  return messages.map((m) => {
    let replyTo: ReplyInfo | null = null;
    if (m.replyToMessageId) {
      const original = replyData.get(m.replyToMessageId);
      if (original && !original.deleted) {
        replyTo = {
          id: m.replyToMessageId,
          senderId: original.senderId,
          senderNickname: original.senderNickname,
          content: original.content,
          exists: true,
        };
      } else {
        // Original deleted ("Excluir para todos" soft-delete, or a hard
        // delete that nulled the reference) → reference exists but no preview.
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
      type: m.type ?? 'text',
      audioUrl: m.audioUrl ?? null,
      durationMs: m.durationMs ?? null,
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
    // A NEW message to this recipient un-hides the conversation for them so
    // it reappears in their list (matches the "Excluir conversa para mim"
    // lifecycle: hidden until the peer writes again).
    await tx.conversationHidden.deleteMany({
      where: { conversationId, userId: otherId },
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
    // The SENDER's own identity — used by the receiving app for the avatar,
    // the conversation preview and the native message notification.
    peer: await chatPeerPayload(userId),
  });

  // Return the sender's own view (readAt null until the peer opens it).
  const [ownView] = await toMessageItems([message], conversationId, userId);
  return ownView;
}

// ── Send a voice message ──────────────────────────────────────
// Uploads the audio file first, then persists a "voice" message that
// references it. Authorization mirrors sendMessage: membership enforced,
// friends-only, the file is size+type validated server-side and the
// duration must be within 3–60s. The receiver gets a normal `chat_message`
// frame so it renders the inline player in realtime. Returns the persisted
// MessageItem (type === 'voice') or throws an ApiError.
export async function sendVoiceMessage(
  userId: string,
  conversationId: string,
  audio: { file: Readable; durationMs: number },
): Promise<MessageItem> {
  const duration = Math.round(audio.durationMs);
  if (!Number.isFinite(duration) || duration < 3000 || duration > 60_000) {
    throw ApiError.invalidRequest('A duração do áudio deve ser entre 3 e 60 segundos.');
  }

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
  if (!(await areFriends(userId, otherId))) {
    throw ApiError.forbidden('Vocês precisam ser amigos para conversar.');
  }

  // Persist the file FIRST (validates bytes + size); then the message. If
  // the message insert fails the orphan file is deleted best-effort.
  const stored = await saveAudioFile(audio.file);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        conversationId,
        senderId: userId,
        content: VOICE_PREVIEW,
        type: 'voice',
        audioUrl: stored.url,
        durationMs: duration,
      },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    await tx.conversationHidden.deleteMany({
      where: { conversationId, userId: otherId },
    });
    return created;
  });

  const [recipientView] = await toMessageItems([message], conversationId, otherId);
  dispatchChatMessage(otherId, {
    conversationId,
    message: recipientView,
    peer: await chatPeerPayload(userId),
  });

  const [ownView] = await toMessageItems([message], conversationId, userId);
  return ownView;
}

/** Stable preview content stored for every voice message. The app uses the
 * message `type` to render the inline player and shows this as the
 * conversation-list preview. */
export const VOICE_PREVIEW = '🎤 Áudio';

/** Loads the compact realtime peer identity for a user (avatar + cosmetics)
 * so incoming chat frames can render the sender without an extra lookup. */
async function chatPeerPayload(userId: string): Promise<ChatPeerPayload> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: CHAT_USER_SELECT,
  });
  if (!user) {
    return {
      id: userId,
      nickname: 'desconhecido',
      avatarUrl: null,
      nameColor: null,
      nameColorId: null,
      frameId: null,
      frameAsset: null,
    };
  }
  return toChatUser(user);
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

// ── Voice "gravando áudio" indicator ──────────────────────────
// Ephemeral realtime signal (same shape as typing). The session user POSTs
// it when a voice capture STARTS / ENDS (or is cancelled/failed/interrupted)
//so the peer's open conversation can show/hide the "gravando áudio" hint
// immediately, without polling or a second transport. Membership is
// enforced; nothing is persisted — the peer auto-clears it (plus the local
// sender clears it on its own release/cancel/error) so it can never get stuck.

export async function setRecording(
  userId: string,
  conversationId: string,
  recording: boolean,
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

  dispatchChatRecording(otherId, { conversationId, recording });
}


// ── Delete a message FOR ME (viewer-specific) ────────────────
// Persists a MessageHide row: the message disappears for THIS user only —
// the peer continues to see it, and it survives app restarts (server-stored).
// Idempotent: deleting an already-hidden message is a no-op success.
export async function deleteMessageForMe(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const conversation = await assertMembership(conversationId, userId);
  void conversation;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true },
  });
  if (!message || message.conversationId !== conversationId) {
    throw ApiError.notFound('Mensagem não encontrada.');
  }
  await prisma.messageHide.upsert({
    where: { messageId_userId: { messageId, userId } },
    update: {},
    create: { messageId, userId },
  });
}

// ── Delete a message for EVERYONE ────────────────────────────
// Server-authoritative soft-delete: marks `deletedAt` so ALL participants
// stop seeing it (all read paths filter it out), keeps the row + original
// content for audit and so replies still resolve a "Mensagem apagada"
// placeholder. Broadcasts a realtime `chat_message_deleted` frame to the
// PEER so an open conversation updates live.
export async function deleteMessageForEveryone(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userOneId: true, userTwoId: true },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  const isMember =
    conversation.userOneId === userId || conversation.userTwoId === userId;
  if (!isMember) {
    throw ApiError.forbidden('Você não tem acesso a esta conversa.');
  }
  const otherId =
    conversation.userOneId === userId ? conversation.userTwoId : conversation.userOneId;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true },
  });
  if (!message || message.conversationId !== conversationId) {
    throw ApiError.notFound('Mensagem não encontrada.');
  }

  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), deletedById: userId },
  });

  // Realtime: tell the peer their copy is gone too (open conversation
  // updates live, no manual refresh).
  dispatchChatMessageDeleted(otherId, { conversationId, messageId });
}

// ── Delete/Hide a conversation FOR ME ────────────────────────
// "Excluir conversa" only ever removes the conversation from the CALLER's
// own list. The conversation row + all messages stay intact for the peer.
// Idempotent. A new incoming message un-hides it (see sendMessage).
export async function hideConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await assertMembership(conversationId, userId);
  void conversation;
  await prisma.conversationHidden.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    update: {},
    create: { conversationId, userId },
  });
}

/** Membership check shared by deletion ops — returns the conversation row. */
async function assertMembership(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userOneId: true, userTwoId: true },
  });
  if (!conversation) throw ApiError.notFound('Conversa não encontrada.');
  const isMember =
    conversation.userOneId === userId || conversation.userTwoId === userId;
  if (!isMember) {
    throw ApiError.forbidden('Você não tem acesso a esta conversa.');
  }
  return conversation;
}

// ── Unread conversations badge (Chat tab) ────────────────────
export async function unreadConversationCount(userId: string): Promise<number> {
  // Any conversation in which the other side sent a message I haven't read —
  // ignoring messages deleted for everyone and ones I hid for myself. Also
  // count only conversations I have NOT hidden ("Excluir conversa para mim").
  const visibleUnread = {
    senderId: { not: userId },
    readAt: null,
    deletedAt: null,
    hiddenBy: { none: { userId } },
  };
  const conversations = await prisma.conversation.findMany({
    where: {
      hiddenBy: { none: { userId } },
      OR: [
        { userOneId: userId, messages: { some: visibleUnread } },
        { userTwoId: userId, messages: { some: visibleUnread } },
      ],
    },
    select: { id: true },
  });
  return conversations.length;
}