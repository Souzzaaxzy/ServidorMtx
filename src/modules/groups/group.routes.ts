import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  addGroupMember,
  banGroupMember,
  unbanGroupMember,
  createGroup,
  deleteGroup,
  deleteGroupMessageForEveryone,
  deleteGroupMessageForMe,
  getGroupInfo,
  getGroupMessageReaders,
  getGroupMessages,
  groupUnreadCount,
  hideGroup,
  leaveGroup,
  listGroups,
  markGroupRead,
  sendGroupMediaMessage,
  sendGroupMessage,
  sendGroupStickerMessage,
  sendGroupVoiceMessage,
  setGroupRecording,
  setGroupTyping,
  updateGroup,
  updateGroupAvatar,
  GROUP_MESSAGE_LIMIT,
} from './group.service.js';

const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'O nome do grupo não pode ser vazio.').max(50, 'O nome do grupo deve ter no máximo 50 caracteres.'),
  description: z.string().max(200, 'A descrição do grupo deve ter no máximo 200 caracteres.').optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  participantIds: z.array(z.string().min(1).max(64)).optional().default([]),
});

const mentionRangeSchema = z
  .object({
    userId: z.string().min(1).max(64).optional(),
    all: z.boolean().optional(),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .strict();

const sendMessageSchema = z.object({
  content: z.string().max(GROUP_MESSAGE_LIMIT, 'Mensagem muito longa.'),
  replyToMessageId: z.string().min(1).max(64).optional(),
  mentionUserIds: z.array(z.string().min(1).max(64)).max(64).optional().default([]),
  mentionAll: z.boolean().optional().default(false),
  // Range-anchored mentions (the ONLY mentions a real client sends). Each
  // carries the exact "@Nickname"/"@todos" token range inside content.
  mentions: z.array(mentionRangeSchema).max(64).optional().default([]),
});

const typingBodySchema = z.object({
  typing: z.boolean(),
});

const recordingBodySchema = z
  .object({
    recording: z.boolean().optional(),
    typing: z.boolean().optional(),
  })
  .refine((d) => d.recording !== undefined || d.typing !== undefined, {
    message: 'Informe recording ou typing.',
  });

const messageQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const groupRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Groups list of the authenticated user (Chat tab, newest activity first).
  app.get('/groups', { onRequest: [app.authenticate] }, async (request, reply) => {
    const groups = await listGroups(request.user!.id);
    return reply.send({ groups });
  });

  // Group profile info — identity block + member list with server-computed
  // `isOwner` flags (the only place the app learns who owns a group).
  app.get('/groups/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const info = await getGroupInfo(request.user!.id, id);
      return reply.send(info);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Owner-only: edit group identity (name/description). Server re-reads
  // the persisted owner and rejects any non-owner — forge-proof.
  app.patch('/groups/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const bodySchema = z.object({
      name: z.string().trim().min(1).max(50).optional(),
      description: z.string().max(200).optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const group = await updateGroup(request.user!.id, id, parsed.data);
      return reply.send({ group });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Owner-only: replace group avatar. The URL comes from an image already
  // uploaded via the standard avatar-upload flow (same as the app avatar).
  app.patch('/groups/:id/avatar', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const bodySchema = z.object({
      avatarUrl: z.string().max(500).nullable(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const group = await updateGroupAvatar(request.user!.id, id, parsed.data.avatarUrl);
      return reply.send({ group });
    } catch (err) {
      throw toApiError(err);
    }
  });



  // Owner-only: add a member (must be an existing user + friend of owner)..
  app.post('/groups/:id/members', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const bodySchema = z.object({
      userId: z.string().min(1).max(64),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const group = await addGroupMember(request.user!.id, id, parsed.data.userId);
      return reply.send({ group });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Owner-only: BAN a member (server-authoritative soft-removal). The
  // owner cannot be banned; a banned member loses access immediately on
  // every read/write path. The row is kept so the owner can re-add later..
  app.post('/groups/:id/members/:userId/ban', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    try {
      const group = await banGroupMember(request.user!.id, id, userId);
      return reply.send({ group });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Owner-only: UNBAN a member (server-authoritative). Clears the
  // `bannedAt` marker so the user is an ACTIVE member again and can be
  // re-added / access the group normally. The row and message history stay
  // intact; the header broadcast refreshes every remaining member.
  app.post('/groups/:id/members/:userId/unban', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    try {
      const group = await unbanGroupMember(request.user!.id, id, userId);
      return reply.send({ group });
    } catch (err) {
      throw toApiError(err);
    }
  });


  // Unread groups badge for the Chat tab.

  app.get('/groups/unread-count', { onRequest: [app.authenticate] }, async (request, reply) => {
    const unreadCount = await groupUnreadCount(request.user!.id);
    return reply.send({ unreadCount });
  });

  // Creates a group (name required; participants must be friends of the
  // creator — enforced server-side). The creator is added as OWNER
  // automatically. Returns the created item so the app opens its chat.

  app.post('/groups', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const group = await createGroup(request.user!.id, parsed.data);
      return reply.status(201).send({ group });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Messages of a group the user belongs to (paginated, chronological).
  app.get('/groups/:id/messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = messageQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    }
    try {
      const page = await getGroupMessages(request.user!.id, id, parsed.data);
      return reply.send(page);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Visto/Enviado — who read a specific group message and who hasn't yet.
  // Resolved from the persisted per-user MessageRead rows (the ONLY source
  // of truth). Only the message SENDER receives the full breakdown; other
  // members can call it but only learn their OWN state.
  app.get('/groups/:id/messages/:messageId/readers', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    try {
      const readers = await getGroupMessageReaders(request.user!.id, id, messageId);
      return reply.send(readers);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Send a group message. SenderId is ALWAYS the auth token's user; the
  // sender identity is embedded in every persisted bubble. May carry an
  // optional replyToMessageId belonging to the SAME group (server-validated).
  app.post('/groups/:id/messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const message = await sendGroupMessage(
        request.user!.id,
        id,
        parsed.data.content,
        parsed.data.replyToMessageId,
        parsed.data.mentionUserIds,
        parsed.data.mentionAll,
        parsed.data.mentions,
      );
      return reply.status(201).send({ message });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // MEDIA group message (image/video) — the file is uploaded via the
  // standard upload endpoints; here the client passes kind + url (and an
  // optional reply). Server validates membership, URL and reply target.
  app.post('/groups/:id/media', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const mediaSchema = z.object({
      kind: z.enum(['image', 'video']),
      url: z.string().min(1).max(500),
      replyToMessageId: z.string().min(1).max(64).optional(),
    });
    const parsed = mediaSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const message = await sendGroupMediaMessage(request.user!.id, id, parsed.data);
      return reply.status(201).send({ message });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // STICKER group message — the sticker id references the server catalog
  // (validated server-side). Same rules + realtime channel as the other
  // group message kinds.
  app.post('/groups/:id/sticker', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const stickerSchema = z.object({
      stickerId: z.string().min(1).max(64),
      replyToMessageId: z.string().min(1).max(64).optional(),
    });
    const parsed = stickerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const message = await sendGroupStickerMessage(
        request.user!.id,
        id,
        parsed.data.stickerId,
        parsed.data.replyToMessageId,
      );
      return reply.status(201).send({ message });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // VOICE group message — multipart with a "file" audio field; durationMs
  // as query param. Same rules as DM voices (1–60s, validated).
  app.post('/groups/:id/voice', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { durationMs?: string; replyToMessageId?: string };
    const durationMs = Number(query.durationMs);
    const part = await request.file({
      limits: { fileSize: 16 * 1024 * 1024 },
    });
    if (!part) {
      throw ApiError.validation('Nenhum arquivo de áudio enviado. Use o campo "file".');
    }
    try {
      const message = await sendGroupVoiceMessage(request.user!.id, id, {
        file: part.file,
        durationMs: Number.isFinite(durationMs) ? durationMs : NaN,
        replyToMessageId: query.replyToMessageId,
      });
      request.log.info(
        {
          groupId: id,
          durationMs,
          messageId: message.id,
          audioUrl: message.audioUrl,
        },
        'group voice message stored',
      );
      return reply.status(201).send({ message });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Realtime voice-recording indicator (group) — ephemeral frame.
  app.post('/groups/:id/recording', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = recordingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      await setGroupRecording(request.user!.id, id, parsed.data.recording ?? parsed.data.typing!);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });


  // Realtime typing indicator (group) — ephemeral frame, nothing persists.

  app.post('/groups/:id/typing', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = typingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      await setGroupTyping(request.user!.id, id, parsed.data.typing);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });


  // Mark a group as read by the session user (clears the unread badge).
  app.post('/groups/:id/read', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await markGroupRead(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });


  // Excluir mensagem PARA MIM (group) — viewer-specific soft-delete.Idempotent.

  app.delete('/groups/:id/messages/:messageId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    try {
      await deleteGroupMessageForMe(request.user!.id, id, messageId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Excluir mensagem PARA TODOS (group) — server-authoritative soft-delete +
  // realtime broadcast to all other members.

  app.delete('/groups/:id/messages/:messageId/everyone', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    try {
      await deleteGroupMessageForEveryone(request.user!.id, id, messageId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });


  // Excluir grupo PARA MIM — removes the group from the caller's list only
  // (a new incoming message un-hides it server-side. Idempotent).
  app.delete('/groups/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await hideGroup(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // PERMANENTLY DELETE the group — owner-only (server re-validates the
  // persisted `createdById`; a forged client flag is never trusted). All
  // membership rows (active + banned), per-user hides, messages, replies and
  // voice files are removed in one transaction; every participant's live
  // sockets get a `chat_group_deleted` frame. After this the group can never
  // reappear or receive messages again.
  app.delete('/groups/:id/permanent', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteGroup(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // SAIR DO GRUPO — member-initiated removal. Only an ACTIVE member may call
  // it (server re-validates membership; the OWNER is rejected — leaving would
  // orphan the group). The group keeps existing for the other members; the
  // leaving user's sockets get `chat_group_deleted` and the others a
  // `chat_group_updated` refresh.
  app.post('/groups/:id/leave', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await leaveGroup(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};
