import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { AUTHOR_SELECT, nicknameCosmetics } from '../../utils/dto.js';
import { areFriends } from '../friends/friend.service.js';
import { deleteLocalFileByUrl, saveAudioFile } from '../uploads/upload.service.js';
import {
  dispatchChatGroupBanned,
  dispatchChatGroupDeleted,
  dispatchChatGroupUpdated,
  dispatchChatMessage,
  dispatchChatMessageDeleted,
  dispatchChatRead,
  dispatchChatRecording,
  dispatchChatTyping,
} from '../push/push.service.js';
import { addStickerRecent } from '../stickers/sticker.service.js';
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

/** Stable preview content stored for every sticker message. */
export const STICKER_PREVIEW = '🧩 Figurinha';

export interface ChatUser {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  nameColor: string | null;
  nameColorId: string | null;
  frameId: string | null;
   frameAsset: string | null;
  /** Group-scoped ban state: true when this user is CURRENTLY banned from the
   * group the payload belongs to (set only in group-message senders). Private
   * chat peers never carry it — the flag is meaningless outside a group. */
  banned: boolean;
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
   /** True when the last visible message of this group MENTIONS the viewer
    * (individual @user or @todos) — powers the "@" indicator in the Chat
    * list, WhatsApp-style. Resolved from the persisted mention rows (never a
    * client flag). */
   mentioned: boolean;
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
   type: 'text' | 'voice' | 'image' | 'video' | 'sticker' | string;
   audioUrl: string | null;
   durationMs: number | null;
   imageUrl: string | null;
   videoUrl: string | null;
   /** Absolute URL of the persisted sticker art (sticker messages only). */
   stickerUrl: string | null;
   /** The sticker's stable id (sticker messages only). */
   stickerId: string | null;
   /** The package this sticker belongs to (sticker messages only). */
   stickerPackageId: string | null;
   /** Structured mentions: every mentioned user id + live nickname. */
   mentions: MentionInfo[];
   /** True when this message contains @todos. */
   mentionAll: boolean;
   /** True when the VIEWER is directly mentioned (their id is inside
    * [mentions] or mentionAll is true). Render highlight accordingly. */
   mentioned: boolean;
}

export interface MentionInfo {
   userId: string;
   nickname: string;
   /** Token range inside the message content — null for legacy (pre-range)
    * mentions, where the client falls back to a best-effort text scan. */
   start: number | null;
   end: number | null;
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
  banned = false,
): ChatUser {
  const cosmetics = nicknameCosmetics(user);
  return {

    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    ...cosmetics,
    banned,
  };
}

async function mapChatUsers(
 senderIds: string[],
 groupId?: string,
): Promise<Map<string, ChatUser>> {
 if (senderIds.length === 0) return new Map();
 const users = await prisma.user.findMany({
   where: { id: { in: senderIds } },
   select: CHAT_USER_SELECT,
 });
 // Group-scoped ban state: only meaningful in group contexts. Resolved from
 // the SAME membership row the read paths enforce, so the flag always
 // matches the persisted state (never a client-supplied value).
 let bannedIds = new Set<string>();
 if (groupId) {
   const rows = await prisma.groupMember.findMany({
     where: { groupId, userId: { in: senderIds }, bannedAt: { not: null } },
     select: { userId: true },
   });
   bannedIds = new Set(rows.map((r) => r.userId));
 }
 return new Map(users.map((u) => [u.id, toChatUser(u, bannedIds.has(u.id))]));
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
  // "@" indicator: does the last visible message MENTION the viewer?
  let mentioned = false;
  if (last) {
    const lastMentions = await prisma.messageMention.findMany({
      where: { messageId: last.id },
      select: { userId: true, mentionAll: true },
    });
    mentioned = lastMentions.some(
      (m) => m.mentionAll || m.userId === userId,
    );
  }
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
    mentioned,
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
): Promise<{
  group: GroupHeader;
  members: { id: string; nickname: string; avatarUrl: string | null; isOwner: boolean }[];
  bannedMembers: { id: string; nickname: string; avatarUrl: string | null }[];
}> {

  await assertGroupMembership(groupId, userId);

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { members: { where: { bannedAt: null }, select: { role: true, user: { select: { id: true, nickname: true, avatarUrl: true } } } } },
  });
  if (!group) throw ApiError.notFound('Grupo não encontrado.');

  // Banned participants are NOT active members — they never appear in the
  // member list/count. They are returned separately (id/nickname/avatar) so
  // the owner UI can list them and unban without ever confusing them with
  // active members.
  const bannedMemberRows = await prisma.groupMember.findMany({
    where: { groupId, bannedAt: { not: null } },
    select: { user: { select: { id: true, nickname: true, avatarUrl: true } } },
  });

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
    bannedMembers: bannedMemberRows.map((b) => ({
      id: b.user.id,
      nickname: b.user.nickname,
      avatarUrl: b.user.avatarUrl,
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

  // The membership row is KEPT when a user is banned (bannedAt set) so
  // history is preserved. Re-adding must therefore distinguish an ACTIVE
  // member (bannedAt null) from a BANNED one — a banned user is NOT an
  // active member and needs to be unbanned first, not reported as
  // "já participa do grupo".
  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: newUserId } },
    select: { id: true, bannedAt: true },
  });
  if (existing) {
    if (existing.bannedAt) {
      throw ApiError.invalidRequest(
        'Este usuário está banido deste grupo. Desbanir antes de adicionar.',
      );
    }
    throw ApiError.invalidRequest('Esse usuário já participa do grupo.');
  }



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

/** Owner-only unban: clears the `bannedAt`/`bannedById` markers on the
 * membership row so the user becomes an ACTIVE member again (same row,
 * history preserved) and can be re-added / access the group normally.
 * Requires the target to be a currently-banned member; unbunning a non-banned
 * member or the OWNER is rejected. Broadcasts the fresh header to the other
 * members (the unbanned user included) so client state stays in sync. */
export async function unbanGroupMember(
  userId: string,
  groupId: string,
  targetUserId: string,
): Promise<GroupConversationItem> {

  await assertGroupOwner(groupId, userId);

  if (targetUserId === userId) {
    throw ApiError.invalidRequest('O dono do grupo não é um membro banido.');
  }

  const target = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { id: true, role: true, bannedAt: true },
  });
  if (!target) throw ApiError.notFound('Usuário não está no grupo.');
  if (!target.bannedAt) {
    throw ApiError.invalidRequest('Este usuário não está banido deste grupo.');
  }

  await prisma.groupMember.update({
    where: { id: target.id },
    data: { bannedAt: null, bannedById: null },
  });

  await prisma.group.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });

  // The unbanned user is an ACTIVE member again → include them in the fan-out
  // so their cached list/screen refreshes like every other member.
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

  // Banned sender ids (full list) for the realtime payload — open
  // conversation screens use them to tag "banido(a)" on the affected
  // messages live (group-scoped, never leaked to other groups).
  const bannedRows = await prisma.groupMember.findMany({
    where: { groupId, bannedAt: { not: null } },
    select: { userId: true },
  });
  const bannedUserIds = bannedRows.map((r) => r.userId);

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
    bannedUserIds,
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
 
  // "@" indicator map: which groups' last message mentions the viewer.
  const lastIds = [...lastByGroup.values()].map((m) => m.id);
  const mentionActive = new Set<string>();
  if (lastIds.length > 0) {
    const lastMentions = await prisma.messageMention.findMany({
      where: { userId, messageId: { in: lastIds } },
      select: { messageId: true, mentionAll: true },
    });
    const mentionAllIds = await prisma.messageMention.findMany({
      where: { mentionAll: true, messageId: { in: lastIds } },
      select: { messageId: true },
    });
    for (const row of lastMentions) mentionActive.add(row.messageId);
    for (const row of mentionAllIds) mentionActive.add(row.messageId);
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
      mentioned: last ? mentionActive.has(last.id) : false,
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
  const users = await mapChatUsers(senderIds, groupId);

  // Resolve structured mentions for all these messages in one query. Each
  // mention carries its exact token RANGE inside the message content (the
  // only link between text and user reference); legacy rows keep null.
  const messageIds = messages.map((m) => m.id);
  const mentionRows = await prisma.messageMention.findMany({
    where: { messageId: { in: messageIds } },
    select: {
      messageId: true,
      mentionAll: true,
      rangeStart: true,
      rangeEnd: true,
      user: { select: { id: true, nickname: true } },
    },
  });
  const mentionsByMessage = new Map<string, MentionInfo[]>();
  const allByMessage = new Set<string>();
  for (const row of mentionRows) {
    if (row.mentionAll) {
      allByMessage.add(row.messageId);
      continue;
    }
    if (row.user == null) continue;
    const list = mentionsByMessage.get(row.messageId) ?? [];
    list.push({
      userId: row.user.id,
      nickname: row.user.nickname,
      start: row.rangeStart,
      end: row.rangeEnd,
    });
    mentionsByMessage.set(row.messageId, list);
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
        replyTo = {
          id: m.replyToMessageId,
          senderId: '',
          senderNickname: '',
          content: '',
          exists: false,
        };
      }
    }
    const mentions = mentionsByMessage.get(m.id) ?? [];
    const mentionAll = allByMessage.has(m.id);
    const mentioned =
      mentionAll || mentions.some((mention) => mention.userId === viewerId);
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
      imageUrl: m.imageUrl ?? null,
      videoUrl: m.videoUrl ?? null,
      stickerUrl: m.stickerUrl ?? null,
      stickerId: m.stickerId ?? null,
      stickerPackageId: m.stickerPackageId ?? null,
      mentions,
      mentionAll,
      mentioned,
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

/** Visto/Enviado — resolves WHO has read a specific group message and who
 * has not, from the persisted per-user MessageRead rows (the ONLY source of
 * truth — never "online"/"received"/"opened" proxies). Only the message
 * SENDER may query the full breakdown; other active members may still call
 * it but only learn their own state. Result users are active (non-banned)
 * members at the moment of the call, so removed/banned members drop out. */
export async function getGroupMessageReaders(
  viewerId: string,
  groupId: string,
  messageId: string,
): Promise<{ read: ChatUser[]; unread: ChatUser[] }> {
  await assertGroupMembership(groupId, viewerId);

  const message = await prisma.message.findUnique({
    where: { id: messageId, groupId },
    select: { id: true, senderId: true },
  });
  if (!message) throw ApiError.notFound('Mensagem não encontrada.');

  // Everyone (except the sender) is a candidate reader.
  const members = await prisma.groupMember.findMany({
    where: { groupId, bannedAt: null, userId: { not: message.senderId } },
    select: { userId: true },
  });
  const memberIds = members.map((m) => m.userId);

  const readRows = await prisma.messageRead.findMany({
    where: { messageId, userId: { in: memberIds } },
    select: { userId: true },
  });
  const readIds = new Set(readRows.map((r) => r.userId));

  // Common members may only see their OWN receipt state.
  const asSender = message.senderId === viewerId;
  const visibleIds = asSender
    ? memberIds
    : memberIds.filter((id) => id === viewerId);

  const read = await mapChatUsers(visibleIds.filter((id) => readIds.has(id)), groupId);
  const unread = await mapChatUsers(visibleIds.filter((id) => !readIds.has(id)), groupId);
  return {
    read: [...read.values()].map((u) => u),
    unread: [...unread.values()].map((u) => u),
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

interface IncomingMentionRange {
  userId?: string;
  all?: boolean;
  start: number;
  end: number;
}

/// Validates the '@' before a mention token sits at a word boundary and the
/// char right after the token doesn't glue it to the next word.
function atWordBoundary(text: string, start: number, end: number): boolean {
  if (start < 0 || end > text.length || end <= start) return false;
  if (start > 0 && !/\s/.test(text[start - 1])) return false;
  if (end < text.length && /[\w\u00C0-\uFFFF]/.test(text[end])) return false;
  return true;
}

export async function sendGroupMessage(
  userId: string,
  groupId: string,
  content: string,
  replyToMessageId?: string,
  mentionUserIds: string[] = [],
  mentionAll = false,
  mentions: IncomingMentionRange[] = [],
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

  // Mentions — SERVER-authoritative. Two accepted wire shapes:
  //  1. RANGE-ANCHORED ([mentions]) — the ONLY form a real client sends:
  //     each entry has the exact "@Nickname"/"@todos" token range inside
  //     [trimmed]. The server re-validates the substring matches a REAL
  //     ACTIVE member (individual) or `@todos` (owner-only) — a mention is
  //     NEVER inferred from text coincidence, and a forged range/user is
  //     rejected.
  //  2. LEGACY ([mentionUserIds]/[mentionAll]) — kept for older clients;
  //     the same membership/owner rules apply.

  // A real client sends either the range-anchored form OR the legacy ids —
  // mixing them is a sign of a tampered payload.
  const hasRanges = mentions.length > 0;
  if (hasRanges && (mentionUserIds.length > 0 || mentionAll)) {
    throw ApiError.invalidRequest(
      'Formato de menção inválido: use intervalos ou ids, não ambos.',
    );
  }

  // Resolve the group owner once (needed for @todos both wire shapes).
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { createdById: true },
  });
  if (!group) throw ApiError.notFound('Grupo não encontrado.');

  // ── Validate @todos (range or legacy) — owner-only. ──
  const rangeAll = mentions.filter((m) => m.all === true);
  if (rangeAll.length > 1) {
    throw ApiError.invalidRequest('Menção @todos duplicada.');
  }
  if (mentionAll || rangeAll.length > 0) {
    if (group.createdById !== userId) {
      throw ApiError.forbidden('Somente o dono do grupo pode usar "@todos".');
    }
    if (rangeAll.length === 1) {
      const r = rangeAll[0];
      if (!atWordBoundary(trimmed, r.start, r.end) ||
          trimmed.slice(r.start, r.end) !== '@todos') {
        throw ApiError.invalidRequest('Menção @todos não corresponde ao texto.');
      }
    }
  }

  // ── Validate individual ranges — every range must point at a REAL active
  // member AND its substring must match their CURRENT nickname exactly. ──
  const validatedRangeRows: {
    userId: string;
    start: number;
    end: number;
  }[] = [];

  if (mentions.length > 0) {
    // Reject overlapping/duplicate ranges from a tampering client.
    const sorted = [...mentions]
      .filter((m) => m.all !== true)
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.end <= cur.start || cur.start >= trimmed.length + 1) {
        throw ApiError.invalidRequest('Menção com intervalo inválido.');
      }
      if (prev && cur.start < prev.end) {
        throw ApiError.invalidRequest('Menções sobrepostas não são permitidas.');
      }
    }

    const rangeUserIds = [
      ...new Set(sorted.map((m) => m.userId).filter(Boolean) as string[]),
    ];
    const memberRows = rangeUserIds.length
      ? await prisma.groupMember.findMany({
          where: { groupId, userId: { in: rangeUserIds }, bannedAt: null },
          select: {
            userId: true,
            user: { select: { nickname: true } },
          },
        })
      : [];
    const memberByUserId = new Map(
      memberRows.map((r) => [r.userId, r.user.nickname]),
    );

    for (const m of sorted) {
      if (!m.userId) {
        throw ApiError.invalidRequest('Menção sem usuário.');
      }
      const nickname = memberByUserId.get(m.userId);
      if (!nickname) {
        throw ApiError.invalidRequest(
          'Menção inválida: usuário não pertence ao grupo.',
        );
      }
      if (m.userId === userId) {
        throw ApiError.invalidRequest('Você não pode mencionar a si mesmo.');
      }
      const expected = `@${nickname}`;
      if (m.start + expected.length !== m.end) {
        throw ApiError.invalidRequest('Menção com texto inconsistente.');
      }
      const token = trimmed.slice(m.start, m.end);
      if (token !== expected) {
        throw ApiError.invalidRequest('Menção não corresponde ao texto.');
      }
      if (!atWordBoundary(trimmed, m.start, m.end)) {
        throw ApiError.invalidRequest('Menção em posição inválida.');
      }
      validatedRangeRows.push({ userId: m.userId, start: m.start, end: m.end });
    }
  }

  // ── Legacy individual ids — validated membership (kept for old clients). ──
  const validatedMentionIds = new Set<string>();
  if (mentionUserIds.length > 0) {
    const uniqueIds = [...new Set(mentionUserIds)];
    const rows = await prisma.groupMember.findMany({
      where: { groupId, userId: { in: uniqueIds }, bannedAt: null },
      select: { userId: true },
    });
    const active = new Set(rows.map((r) => r.userId));
    for (const id of uniqueIds) {
      if (!active.has(id)) {
        throw ApiError.invalidRequest(
          'Menção inválida: usuário não pertence ao grupo.',
        );
      }
      if (id !== userId) validatedMentionIds.add(id);
    }
  }

  const mentionRows: {
    userId?: string;
    mentionAll?: boolean;
    rangeStart: number | null;
    rangeEnd: number | null;
  }[] = [
    ...(mentionAll || rangeAll.length > 0
      ? [{
          mentionAll: true,
          rangeStart: rangeAll[0]?.start ?? null,
          rangeEnd: rangeAll[0]?.end ?? null,
        }]
      : []),
    ...validatedRangeRows.map((r) => ({
      userId: r.userId,
      rangeStart: r.start,
      rangeEnd: r.end,
    })),
    // Legacy (no-range) rows keep NULL ranges so clients fall back to their
    // best-effort history scan for these old payloads.
    ...[...validatedMentionIds].map((id) => ({
      userId: id,
      rangeStart: null as number | null,
      rangeEnd: null as number | null,
    })),
  ];

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        groupId,
        senderId: userId,
        content: trimmed,
        replyToMessageId: replyToMessageId?.trim() || null,
        mentions: {
          create: mentionRows,
        },
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

/** Send a media message (image/video) to a GROUP. The file is already
 * stored via the standard upload endpoints; this persists the message
 * (type = "image"|"video", stable preview label) with the media reference,
 * validates the reply target belongs to the SAME group and fans it out
 * through the exact same realtime channel as text/voice. */
export async function sendGroupMediaMessage(
  userId: string,
  groupId: string,
  media: { kind: 'image' | 'video'; url: string; replyToMessageId?: string },
): Promise<GroupMessageItem> {
  await assertGroupMembership(groupId, userId);
  if (media.replyToMessageId && media.replyToMessageId.trim()) {
    const target = await prisma.message.findUnique({
      where: { id: media.replyToMessageId },
      select: { groupId: true },
    });
    if (!target || target.groupId !== groupId) {
      throw ApiError.invalidRequest('Mensagem respondida não encontrada.');
    }
  }

  const label = media.kind === 'video' ? '🎥 Vídeo' : '📷 Foto';
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        groupId,
        senderId: userId,
        content: label,
        type: media.kind,
        ...(media.kind === 'image'
          ? { imageUrl: media.url }
          : { videoUrl: media.url }),
        replyToMessageId: media.replyToMessageId?.trim() || null,
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

/** Sends a STICKER message to a GROUP. The sticker id is validated against
 * the server catalog (server-authoritative); the persisted message carries
 * only the references and fans out to every OTHER member through the SAME
 * realtime channel as text/voice/media. The sticker is also recorded in the
 * sender's recents (deduped + bounded). */
export async function sendGroupStickerMessage(
  userId: string,
  groupId: string,
  stickerId: string,
  replyToMessageId?: string,
): Promise<GroupMessageItem> {
  await assertGroupMembership(groupId, userId);
  if (replyToMessageId && replyToMessageId.trim()) {
    const target = await prisma.message.findUnique({
      where: { id: replyToMessageId },
      select: { groupId: true },
    });
    if (!target || target.groupId !== groupId) {
      throw ApiError.invalidRequest('Mensagem respondida não encontrada.');
    }
  }

  const sticker = await prisma.sticker.findUnique({
    where: { id: stickerId },
    include: { package: { select: { id: true, active: true } } },
  });
  if (!sticker || !sticker.package.active) {
    throw ApiError.notFound('Figurinha não encontrada.');
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        groupId,
        senderId: userId,
        content: STICKER_PREVIEW,
        type: 'sticker',
        stickerUrl: sticker.fileUrl,
        stickerId: sticker.id,
        stickerPackageId: sticker.packageId,
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

  await addStickerRecent(userId, sticker.id);

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

  // The group coarse `readAt` badge stays (marks that the reader caught
  // up), and we ALSO persist a per-user MessageRead row for every
  // message the reader just caught up on — that row is the source for
  // "Visto/Enviado". Idempotent: re-reading never duplicates.
  const unread = await prisma.message.findMany({
    where: {
      groupId,
      senderId: { not: userId },
      readAt: null,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (unread.length > 0) {
    const ids = unread.map((m) => m.id);
    await prisma.$transaction(async (tx) => {
      const readRows: { messageId: string; userId: string }[] = ids.map(
        (id) => ({ messageId: id, userId }),
      );
      // Idempotence: the unique (messageId, userId) constraint makes a
      // duplicate create a no-op failure we can swallow safely.
      for (const row of readRows) {
        await tx.messageRead
          .create({ data: row })
          .catch((err) => {
            if (err?.code === 'P2002') return; // already read
            throw err;
          });
      }
      await tx.message.updateMany({
        where: { id: { in: ids } },
        data: { readAt: new Date() },
      });
    });
    const peers = await otherMemberIds(groupId, userId);
    for (const peerId of peers) {
      dispatchChatRead(peerId, { groupId, userId, messageIds: ids });
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

// ── Permanently DELETE a group (owner-only) ────────────────
// The owner destroys the group AND everything tied to it through a single
// transaction: every membership row (active + banned), every per-user hide,
// every message + per-message hide + reply references + audio files. The
// row is really deleted — a deleted group can never reappear via a stale
// cache/re-sync. All live sockets (every member, banned members included)
// get a `chat_group_deleted` frame so open screens and cached lists drop it
// immediately.
export async function deleteGroup(
  userId: string,
  groupId: string,
): Promise<void> {
  await assertGroupOwner(groupId, userId);

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { name: true, createdById: true },
  });
  if (!group) throw ApiError.notFound('Grupo não encontrado.');

  const memberRows = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  const recipientIds = memberRows.map((r) => r.userId);

  const voiceMessages = await prisma.message.findMany({
    where: { groupId, type: 'voice' },
    select: { audioUrl: true },
  });

  await prisma.$transaction(async (tx) => {
    // Order matters on SQLite + Prisma: erase the child rows whose ON DELETE
    // behavior could block or leave dangling references BEFORE the parent,
    // so the final cascade has nothing left to fight over.
    await tx.messageHide.deleteMany({ where: { message: { groupId } } });
    await tx.message.deleteMany({ where: { groupId } });
    await tx.groupMember.deleteMany({ where: { groupId } });
    await tx.groupHidden.deleteMany({ where: { groupId } });
    await tx.group.delete({ where: { id: groupId } });
  });

  // Best-effort: drop the persisted voice files referenced by this group.
  for (const m of voiceMessages) {
    if (!m.audioUrl) continue;
    await deleteLocalFileByUrl(m.audioUrl).catch(() => void 0);
  }

  // Realtime fan-out — every participant (active + banned) is told the group
  // is gone. Banned users receive it too so their stale list never holds a
  // group they can't even see.
  const frame = { groupId, groupName: group.name };
  for (const id of recipientIds) {
    dispatchChatGroupDeleted(id, frame);
  }
}

// ── Leave a group (member-initiated) ────────────────────────
// Removes ONLY the caller from the group. The group — its other members,
// messages and history — keeps existing. The OWNER cannot leave without
// destroying the group (there is no transfer mechanism in the current
// architecture; leaving would orphan every member). Every other member gets
// the standard `chat_group_updated` refresh so their member count / list
// stay in sync without polling.
export async function leaveGroup(
  userId: string,
  groupId: string,
): Promise<void> {
  const member = await assertGroupMembership(groupId, userId);
  if (member.role === 'OWNER') {
    throw ApiError.forbidden(
      'O dono do grupo não pode sair. Para encerrar o grupo, use "Excluir grupo".',
    );
  }

  await prisma.groupMember.delete({
    where: { groupId_userId: { groupId, userId } },
  });
  await prisma.groupHidden.deleteMany({ where: { groupId, userId } });
  await prisma.group.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });

  // The leaving user's own devices drop the group immediately; the other
  // members get the standard group-updated refresh (fresh member count).
  dispatchChatGroupDeleted(userId, {
    groupId,
    groupName: (await groupNameById(groupId)) ?? '',
  });
  await broadcastGroupUpdate(groupId, userId);
}

async function groupNameById(groupId: string): Promise<string | null> {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { name: true },
  });
  return group?.name ?? null;
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
