import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, nicknameCosmetics } from '../../utils/dto.js';
import { areFriends } from '../friends/friend.service.js';
import { saveAudioFile } from '../uploads/upload.service.js';
import {
  dispatchChatGroupBanned,
  dispatchChatGroupUpdated,
  dispatchChatMessage,
  dispatchChatMessageDeleted,
  dispatchChatRead,
  dispatchChatRecording,
  dispatchChatTyping,
} from '../push/push.service.js';
import type { Message } from '../../generated/index.js';
import type { Readable } from 'node:stream';

// ── Group chat ─────────────────────────────────────────────
// Named group with 2+ members (creator is OWNER). Messaging rides the SAME
// `Message` table as DMs — group messages carry a non-null `groupId` (and a
// null `conversationId`). Membership is enforced on every read/write;
// participants must be accepted friends of the creator at creation time
// (server-validated).

/** Hard server-side limit for a single message (the authority). */
export const GROUP_MESSAGE_LIMIT = 4000;

/** Truncated preview length for the groups list. */
const PREVIEW_LENGTH = 80;

/** Stable preview content stored for every voice message. */
export const VOICE_PREVIEW = '🎤 Áudio';

export interface ChatUser {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  nameColor: string | null;
  nameColorId: string | null;
  frameId: string | null;
   frameAsset: string | null;
}

export interface GroupHeader {
  id: string;
   name: string;
   avatarUrl: string | null;
   description: string;
   createdById: string;
   memberCount: number;
}

export interface GroupConversationItem {
  
   id: string;
   group: GroupHeader;
   lastMessage: {
    id: string;
    content: string;
    senderId: string;
    createdAt: string;
    senderNickname: string | null;
  } | null;
   lastMine: boolean;
   unreadCount: number;
   updatedAt: string;
}

export interface GroupMessageItem {
  
  id: string;
   conversationId: string | null;
   groupId: string;
   sender: ChatUser | null;
   senderId: string;
   content: string;
   createdAt: string;
   mine: boolean;
   readAt: string | null;
   replyTo: ReplyInfo | null;
   type: 'text' | 'voice' | string;
   audioUrl: string | null;
   durationMs: number | null;
}

export interface ChatPeerPayload {
  
  id: string;
   nickname: string;
   avatarUrl: string | null;
   nameColor: string | null;
   nameColorId: string | null;
   frameId: string | null;
   frameAsset: string | null;
}

export interface ReplyInfo {
  
  id: string;
   senderId: string;
   senderNickname: string;
   content: string;
   exists: boolean;
}

export interface GroupMessagePage {
  
  messages: GroupMessageItem[];
   hasMore: boolean;
}

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

async function mapChatUsers(
 senderIds: string[],
): Promise<Map<string, ChatUser>> {
 if (senderIds.length === 0) return new Map();
 const users = await prisma.user.findMany({
   where: { id: { in: senderIds } },
   select: CHAT_USER_SELECT,
 });
 return new Map(users.map((u) => [u.id, toChatUser(u)]));
}

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

function truncatePreview(content: string): string {
 return content.length > PREVIEW_LENGTH
   ? `${content.slice(0, PREVIEW_LENGTH)}…`
   : content;
}

async function assertGroupMembership(groupId: string, userId: string) {
  
 const member = await prisma.groupMember.findUnique({
   where: { groupId_userId: { groupId, userId } },
   select: { role: true, bannedAt: true },
 });
  if (!member) {
   throw ApiError.forbidden('Você não é membro deste grupo.');
  }
  if (member.bannedAt) {
   throw ApiError.forbidden('Você foi banido deste grupo.');
  }
  return member;
}

/** Server-authoritative owner check — the only user allowed to run admin
 * operations (edit identity, add members, delete any member's message).
 * The check is ALWAYS a DB lookup against the persisted `createdById`,
 * NEVER a client-sent flag, so a forged "isOwner" payload gets denied. */
async function assertGroupOwner(groupId: string, userId: string): Promise<void> {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { createdById: true },
  });
  if (!group) throw ApiError.notFound('Grupo não encontrado.');
  await assertGroupMembership(groupId,userId);
  if (group.createdById !== userId) {
    throw ApiError.forbidden('Somente o dono do grupo pode executar esta ação.');
  }
}

async function loadGroupConversationItem(
  groupId: string,
  userId: string,
): Promise<GroupConversationItem> {
 
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: { where: { bannedAt: null }, select: { id: true } },
    },
  });
  if (!group) throw ApiError.notFound('Grupo não encontrado.');
  await assertGroupMembership(groupId,userId);
  const memberIds = group.members.map((m) => m.id);
  const last = await prisma.message.findFirst({
    where: {
      groupId,
      senderId: { in: memberIds },
      deletedAt: null,
      hiddenBy: { none: { userId } },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      content: true,
      senderId: true,
      createdAt: true,
      sender: { select: { nickname: true } },
    },
  });
  const unreadCount = await prisma.message.count({
    where: {
      groupId,
      senderId: { not: userId },
      readAt: null,
      deletedAt: null,
      hiddenBy: { none: { userId } },
    },
  });
  return {
    id: group.id,
    group: {
      id: group.id,
      name: group.name,
      avatarUrl: group.avatarUrl,
      description: group.description,
      createdById: group.createdById,
      memberCount: memberIds.length,
    },
    lastMessage: last
      ? {
          id: last.id,
          content: truncatePreview(last.content),
          senderId: last.senderId,
          createdAt: last.createdAt.toISOString(),
          senderNickname: last.sender.nickname,
        }
      : null,
    lastMine: last ? last.senderId === userId : false,
    unreadCount,
    updatedAt: group.updatedAt.toISOString(),
  };
}

export async function createGroup(
  userId: string,
  input: { name: string; description?: string; avatarUrl?: string | null; participantIds: string[] },
): Promise<GroupConversationItem> {
 
  const name = input.name.trim();
  if (name.length === 0) {
    throw ApiError.invalidRequest('O nome do grupo não pode ser vazio.');
  }
  if (name.length > 50) {
    throw ApiError.invalidRequest('O nome do grupo deve ter no máximo 50 caracteres.');
  }
 

  const description = (input.description ?? '').trim();
 
 
 
  if (description.length > 200) {
    throw ApiError.invalidRequest('A descrição do grupo deve ter no máximo 200 caracteres.');
  }
 
  const ids = [...new Set(input.participantIds.filter((id) => id !== userId))];
  if (ids.length > 50) {
    throw ApiError.invalidRequest('Um grupo pode ter no máximo 50 participantes.');
  }
 
  for (const id of ids) {
    const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw ApiError.notFound('Participante não encontrado.');
    if (!(await areFriends(userId, id))) {
      throw ApiError.forbidden('Todos os participantes precisam ser seus amigos.');
    }
  }
 
  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.group.create({
      data: {
        name,
        description,
        avatarUrl: input.avatarUrl ?? null,
        createdById: userId,
        members: {
          create: [
            { userId, role: 'OWNER' },
            ...ids.map((id) => ({ userId: id, role: 'MEMBER' as const })),
          ],
        },
      },
    });
    return created;
  });
 
  return loadGroupConversationItem(group.id, userId);
}

/** Group detail for the profile menu: identity block + participant list with
 * a server-computed `isOwner` flag per member (never trusted from the
 * client). The caller must be a member; the response always reflets the
 * persisted rows — no client-supplied identity. */
export async function getGroupInfo(
  userId: string,
  groupId: string,
): Promise<{ group: GroupHeader; members: { id: string; nickname: string; avatarUrl: string | null; isOwner: boolean }[] }> {

  await assertGroupMembership(groupId, userId);

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { members: { where: { bannedAt: null }, select: { role: true, user: { select: { id: true, nickname: true, avatarUrl: true } } } } },
  });
  if (!group) throw ApiError.notFound('Grupo não encontrado.');

  const memberIds = group.members.map((m) => m.user.id);
  return {
    group: {
      id: group.id,
      name: group.name,
      avatarUrl: group.avatarUrl,
      description: group.description,
      createdById: group.createdById,
      memberCount: memberIds.length,
    },
    members: group.members.map((m) => ({
      id: m.user.id,
      nickname: m.user.nickname,
      avatarUrl: m.user.avatarUrl,
      isOwner: m.user.id === group.createdById,
    })),
  };
}

/** Owner-only identity edit (name/description;avatar set separately via the
 * existing upload flow — see updateGroupAvatar). Server-validated: name
 * length, authentication and owner permissions are ALL checked here;the
 * client can never bypass by sending forged flags. Broadcasts the fresh
 * header to every other member (realtime), updating their AppBar /
 * profile menu / chat list live. */

export async function updateGroup(
  userId: string,
  groupId: string,
  input: { name?: string; description?: string },
): Promise<GroupHeader> {

  await assertGroupOwner(groupId, userId);

  if (input.name != null) {
    const name = input.name.trim();
    if (name.length === 0) {
      throw ApiError.invalidRequest('O nome do grupo não pode ser vazio.');
    }
    if (name.length > 50) {
      throw ApiError.invalidRequest('O nome do grupo deve ter no máximo50 caracteres.');
    }
  }

  if (input.description != null) {
    const description = input.description.trim();
    if (description.length > 200) {
      throw ApiError.invalidRequest('A descrição do grupo deve ter no máximo200 caracteres.');
    }
  }

  const updated = await prisma.group.update({
    where: { id: groupId },
    data: {
      ...(input.name != null ? { name: input.name.trim() } : {}),
      ...(input.description != null ? { description: input.description.trim() } : {}),
      updatedAt: new Date(),
    },
  });

  await broadcastGroupUpdate(groupId, userId);
  return toGroupHeader(updated, null);
}

/** Owner-only group avatar replacement. Validates the authenticated user is
 * the owner (server-side) and persists the provided avatar URL — the same
 * URL is served to every participant via the list/detail/update broadcasts. */

export async function updateGroupAvatar(
  userId: string,
  groupId: string,
  avatarUrl: string | null,
): Promise<GroupHeader> {

  await assertGroupOwner(groupId, userId);

  const updated = await prisma.group.update({
    where: { id: groupId },
    data: { avatarUrl, updatedAt: new Date() },
  });

  await broadcastGroupUpdate(groupId, userId);
  return toGroupHeader(updated, null);
}

/** Owner-only member addition. Every new participant MUST be:
 *  1. a valid existing user;
 *  2. a friend of the owner (same rule as group creation);
 *  3. not already a member. */

export async function addGroupMember(
  userId: string,
  groupId: string,
  newUserId: string,
): Promise<GroupConversationItem> {

  await assertGroupOwner(groupId, userId);

  if (newUserId === userId) {
    throw ApiError.invalidRequest('Você já participa deste grupo.');
  }

  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: newUserId } },
    select: { id: true },
  });
  if (existing) throw ApiError.invalidRequest('Esse usuário já participa do grupo.');



  const user = await prisma.user.findUnique({
    where: { id: newUserId },
    select: { id: true },
  });
  if (!user) throw ApiError.notFound('Usuário não encontrado.');
  if (!(await areFriends(userId, newUserId))) {

    throw ApiError.forbidden('Você só pode adicionar amigos ao grupo.');
  }



  await prisma.groupMember.create({
    data: { groupId, userId: newUserId, role: 'MEMBER' },
  });



  await prisma.group.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });


  await broadcastGroupUpdate(groupId, userId);
  return loadGroupConversationItem(groupId, userId);
}

export async function banGroupMember(
  userId: string,
  groupId: string,
  targetUserId: string,
): Promise<GroupConversationItem> {

  await assertGroupOwner(groupId, userId);

  if (targetUserId === userId) {
    throw ApiError.invalidRequest('O dono não pode ser banido.');
  }

  const target = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { id: true, role: true, bannedAt: true },
  });
  if (!target) throw ApiError.notFound('Usuário não está no grupo.');



  if (target.role === 'OWNER') {
    throw ApiError.forbidden('O dono do grupo não pode ser banido.');
  }

  await prisma.groupMember.update({
    where: { id: target.id },
    data: { bannedAt: new Date(), bannedById: userId },
  });

  await prisma.group.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });

  const groupRow = await prisma.group.findUnique({
    where: { id: groupId },
    select: { name: true },
  });

  // Realtime fan-out:
  //  1. The BANNED user gets a `chat_group_banned` frame so their open
  //     group screen kicks them out live (no waiting for a 403).
  //  2. The REMAINING members get the standard `chat_group_updated`
  //     refresh (member count shrinks immediately).
  dispatchChatGroupBanned(targetUserId, {
    groupId,
    groupName: groupRow?.name ?? '',
  });

  await broadcastGroupUpdate(groupId, userId);
  return loadGroupConversationItem(groupId, userId);
}

/** Realtime fan-out-of a fresh `GroupHeader` to every member (except the
 * acting user). Called after every owner edit so receivers never poll.. */

async function broadcastGroupUpdate(groupId: string, actingUserId: string): Promise<void> {

  const rows = await prisma.groupMember.findMany({
    where: { groupId, userId: { not: actingUserId }, bannedAt: null },
    select: { userId: true },
  });

  const memberRows = await prisma.groupMember.findMany({
    where: { groupId, bannedAt: null },
    select: { id: true },
  });

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      name: true,
      avatarUrl: true,
      description: true,
      createdById: true,
      updatedAt: true,
    },
  });

  if (!group) return;

  const payload = {
    groupId,
    group: {
      id: groupId,
      name: group.name,
      avatarUrl: group.avatarUrl,
      description: group.description,
      createdById: group.createdById,
      memberCount: memberRows.length,
    },
  };
  dispatchChatGroupUpdated(
    rows.map((r) => r.userId),
    payload,
  );
}

type GroupRow = { id: string; name: string; avatarUrl: string | null; description: string; createdById: string };

/** Converts a Group row into the `GroupHeader` DTO. */
function toGroupHeader(group: GroupRow, memberIds: string[] | null): GroupHeader {
  return {
    id: group.id,
    name: group.name,
    avatarUrl: group.avatarUrl,
    description: group.description,
    createdById: group.createdById,
    memberCount: memberIds ? memberIds.length : 0,
  };
}

export async function listGroups(
  userId: string): Promise<GroupConversationItem[]> {
 
  const memberships = await prisma.groupMember.findMany({
    where: {
      userId,
      bannedAt: null,
      group: { hiddenBy: { none: { userId } } },
    },
    include: {
      group: {
        include: {
          members: { select: { id: true } },
        },
      },
    },
    orderBy: { group: { updatedAt: 'desc' } },
  });
 
  if (memberships.length === 0) return [];
 
  const ids = memberships.map((m) => m.groupId);
  const memberIdsByGroup = new Map<string, string[]>();
  for (const m of memberships) {
    memberIdsByGroup.set(m.groupId, m.group.members.map((mm) => mm.id));
  }
 
 
  const newest = await prisma.message.findMany({
    where: {
      groupId: { in: ids },
      deletedAt: null,
      hiddenBy: { none: { userId } },
    },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      groupId: true,
      content: true,
      senderId: true,
      createdAt: true,
      sender: { select: { nickname: true } },
    },
    take: ids.length * 10,
  });
  const lastByGroup = new Map<string, (typeof newest)[number]>();
  for (const m of newest) {
    if (m.groupId == null) continue;
    if (!lastByGroup.has(m.groupId)) {
      lastByGroup.set(m.groupId, m);
    }
  }
 
  const unreadRows = await prisma.$queryRawUnsafe<{ groupId: string; c: number }[]>(
    `SELECT "groupId", COUNT(*) AS c
       FROM "messages"
      WHERE "groupId" IN (${ids.map(() => '?').join(',')})
        AND "senderId" <> ?
        AND "readAt" IS NULL
        AND "deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "message_hides" h
           WHERE h."messageId" = "messages"."id" AND h."userId" = ?
        )
      GROUP BY "groupId"`,
    ...ids,
    userId,
    userId,
  );
  const unreadMap = new Map<string, number>();
  for (const row of unreadRows) {
    unreadMap.set(row.groupId, Number(row.c));
  }
 
  return memberships.map((m) => {
    const group = m.group;
    const last = lastByGroup.get(m.groupId) ?? null;
    const memberIds = memberIdsByGroup.get(m.groupId) ?? [];
    return {
      id: group.id,
      group: {
        id: group.id,
        name: group.name,
        avatarUrl: group.avatarUrl,
        description: group.description,
        createdById: group.createdById,
        memberCount: memberIds.length,
      },
      lastMessage: last
        ? {
            id: last.id,
            content: truncatePreview(last.content),
            senderId: last.senderId,
            createdAt: last.createdAt.toISOString(),
            senderNickname: last.sender.nickname,
          }
        : null,
      lastMine: last ? last.senderId === userId : false,
      unreadCount: unreadMap.get(m.groupId) ?? 0,
      updatedAt: group.updatedAt.toISOString(),
    };
  });
}

// ── Group messages ─────────────────────────────────────────────
// Same paginated chronological shape as private messages, but every bubble
// carries the real sender embedded (`sender` chat user) so the app can render
// avatars for every participant. The `conversationId` field is always null
// for group messages (DM messages carry it; group messages never do).

function groupVisibleMessageWhere(groupId: string, userId: string) {
  return {
    groupId,
    deletedAt: null,
    hiddenBy: { none: { userId } },
  };
}

async function toGroupMessageItems(
  messages: Message[],
  groupId: string,
  viewerId: string,
): Promise<GroupMessageItem[]> {
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

  const senderIds = [...new Set(messages.map((m) => m.senderId))];
  const users = await mapChatUsers(senderIds);

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
      conversationId: null,
      groupId,
      sender: users.get(m.senderId) ?? null,
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

export async function getGroupMessages(
  userId: string,
  groupId: string,
  opts: { before?: string; limit?: number },
): Promise<GroupMessagePage> {
 
  await assertGroupMembership(groupId, userId);

  const safeLimit = Math.min(Math.max(1, opts.limit ?? 30),100);
  const baseWhere = groupVisibleMessageWhere(groupId, userId);
  const where = opts.before
    ? { ...baseWhere, id: { lt: opts.before } }
    : baseWhere;

  const messages = await prisma.message.findMany({
    where,
    orderBy: { id: 'desc' },
    take: safeLimit + 1,
  });
  const hasMore = messages.length > safeLimit;
  const page = messages.slice(0, safeLimit).reverse();

  return {
    messages: await toGroupMessageItems(page, groupId, userId),
    hasMore,
 };
}

/** Resolves the OTHER members of a group (all except the session user).
 * Used by every realtime broadcast so all participants get live updates. */
async function otherMemberIds(groupId: string, userId: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { groupId, userId: { not: userId }, bannedAt: null },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

export async function sendGroupMessage(
  userId: string,
  groupId: string,
  content: string,
  replyToMessageId?: string,
): Promise<GroupMessageItem> {
 
 
  await assertGroupMembership(groupId, userId);

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw ApiError.invalidRequest('A mensagem não pode estar vazia.');
  }
  if (trimmed.length > GROUP_MESSAGE_LIMIT) {
    throw ApiError.invalidRequest(
      `A mensagem deve ter no máximo ${GROUP_MESSAGE_LIMIT} caracteres.`,
    );
  }

  if (replyToMessageId && replyToMessageId.trim()) {

    const target = await prisma.message.findUnique({
      where: { id: replyToMessageId },
      select: { id: true, groupId: true },
    });
    if (!target || target.groupId !== groupId) {
      throw ApiError.invalidRequest('Mensagem respondida não encontrada.');
    }
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        groupId,
        senderId: userId,
        content: trimmed,
        replyToMessageId: replyToMessageId?.trim() || null,
      },
    });
    await tx.group.update({
      where: { id: groupId },
      data: { updatedAt: new Date() },
    });
    await tx.groupHidden.deleteMany({
      where: { groupId, userId: { not: userId } },
    });
    return created;
  });

  // Deliver live to every OTHER member (the sender's peers). Each
  // recipient's row is serialized from THEIR perspective so `mine` renders
  // correctly on each device. `peer` is the chunk sender identity for the
  // receiving app's avatar + notification.
 const peers = await otherMemberIds(groupId, userId);
  const [ownView] = await toGroupMessageItems([message], groupId, userId);
  for (const peerId of peers) {
    const [peerView] = await toGroupMessageItems([message], groupId, peerId);
    dispatchChatMessage(peerId, {
      groupId,
      message: peerView,
      peer: await chatPeerPayload(userId),
    });
  }
  return ownView;
}

export async function sendGroupVoiceMessage(
  userId: string,
  groupId: string,
  audio: { file: Readable; durationMs: number; replyToMessageId?: string },
): Promise<GroupMessageItem> {

  const duration = Math.round(audio.durationMs);
  if (!Number.isFinite(duration) || duration < 1000 || duration > 60_000) {
    throw ApiError.invalidRequest('A duração do áudio deve ser entre 1 e 60 segundos.');
  }

 
  await assertGroupMembership(groupId, userId);
  if (audio.replyToMessageId && audio.replyToMessageId.trim()) {

    const target = await prisma.message.findUnique({
      where: { id: audio.replyToMessageId },
      select: { groupId: true },
    });
    if (!target || target.groupId !== groupId) {
      throw ApiError.invalidRequest('Mensagem respondida não encontrada.');
    }
  }


  const stored = await saveAudioFile(audio.file);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        groupId,
        senderId: userId,
        content: VOICE_PREVIEW,
        type: 'voice',
        audioUrl: stored.url,
        durationMs: duration,
        replyToMessageId: audio.replyToMessageId?.trim() || null,
      },
    });
    await tx.group.update({
      where: { id: groupId },
      data: { updatedAt: new Date() },
    });
    await tx.groupHidden.deleteMany({
      where: { groupId, userId: { not: userId } },
    });
    return created;
  });

  const peers = await otherMemberIds(groupId, userId);
  const [ownView] = await toGroupMessageItems([message], groupId, userId);
  for (const peerId of peers) {
    const [peerView] = await toGroupMessageItems([message], groupId, peerId);
    dispatchChatMessage(peerId, {
      groupId,
      message: peerView,
      peer: await chatPeerPayload(userId),
    });
  }
  return ownView;
}

// ── Mark a group as read ─────────────────────────────────────
export async function markGroupRead(
  userId: string,
  groupId: string,
): Promise<void> {
 
 
  await assertGroupMembership(groupId, userId);

  const updated = await prisma.message.updateMany({
    where: {
      groupId,
      senderId: { not: userId },
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  if (updated.count > 0) {
    const peers = await otherMemberIds(groupId, userId);
    for (const peerId of peers) {
      dispatchChatRead(peerId, { groupId });
    }
  }
}

// ── Typing / recording indicators ──────────────────────────────
async function memberNickname(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { nickname: true },
  });
  return user?.nickname ?? null;
}

export async function setGroupTyping(
  userId: string,
  groupId: string,
  typing: boolean,
): Promise<void> {

  await assertGroupMembership(groupId, userId);
  const [nickname, peers] = await Promise.all([
    memberNickname(userId),
    otherMemberIds(groupId, userId),
  ]);
  for (const peerId of peers) {
    dispatchChatTyping(peerId, { groupId, typing, userId, nickname });
  }
}

export async function setGroupRecording(
  userId: string,
  groupId: string,
  recording: boolean,
): Promise<void> {

  await assertGroupMembership(groupId, userId);
  const [nickname, peers] = await Promise.all([
    memberNickname(userId),
    otherMemberIds(groupId, userId),
  ]);
  for (const peerId of peers) {
    dispatchChatRecording(peerId, { groupId, recording, userId, nickname });
  }
}



// ── Delete a group message ───────────────────────────────────
export async function deleteGroupMessageForMe(
  userId: string,
  groupId: string,
  messageId: string,
): Promise<void> {
 
 
  await assertGroupMembership(groupId, userId);

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, groupId: true },
  });
  if (!message || message.groupId !== groupId) {
    throw ApiError.notFound('Mensagem não encontrada.');
  }
  await prisma.messageHide.upsert({
    where: { messageId_userId: { messageId, userId } },
    update: {},
    create: { messageId, userId },
  });
}

export async function deleteGroupMessageForEveryone(
  userId: string,
  groupId: string,
  messageId: string,
): Promise<void> {
 
 
  await assertGroupMembership(groupId, userId);

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, groupId: true, senderId: true },
  });
  if (!message || message.groupId !== groupId) {
    throw ApiError.notFound('Mensagem não encontrada.');
  }

  // Owner permission: a member may delete their OWN message for everyone;
  // deleting ANOTHER member's message requires the OWNER (server-validated,so
  // a forged client flag can never delete someone else's bubble)..
  if (message.senderId !== userId) {
    await assertGroupOwner(groupId,userId);
  }

  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), deletedById: userId },
  });

  // Realtime: let EVERY member (including the deleter's other devices) drop
  // their bubble live ((same frame shape as DM).
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  for (const row of members) {
    dispatchChatMessageDeleted(row.userId, { groupId, messageId });
  }
}

// ── Hide a group FOR ME (removes it from the caller's list only) ───
export async function hideGroup(
  userId: string,
  groupId: string,
): Promise<void> {

  await assertGroupMembership(groupId, userId);
  await prisma.groupHidden.upsert({
    where: { groupId_userId: { groupId, userId } },
    update: {},
    create: { groupId, userId },
  });
}

// ── Unread groups badge (Chat tab) ─────────────────────────
export async function groupUnreadCount(userId: string): Promise<number> {
  const groups = await prisma.group.findMany({
    where: {
      hiddenBy: { none: { userId } },
      members: { some: { userId, bannedAt: null } },
      messages: { some: { senderId: { not: userId }, readAt: null, deletedAt: null, hiddenBy: { none: { userId } } } },
    },
    select: { id: true },
  });
  return groups.length;
}
