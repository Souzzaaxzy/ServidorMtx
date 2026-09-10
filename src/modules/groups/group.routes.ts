import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  createGroup,
  deleteGroupMessageForEveryone,
  deleteGroupMessageForMe,
  getGroupInfo,
  getGroupMessages,
  groupUnreadCount,
  hideGroup,
  listGroups,
  markGroupRead,
  sendGroupMessage,
  sendGroupVoiceMessage,
  setGroupRecording,
  setGroupTyping,
  GROUP_MESSAGE_LIMIT,
} from './group.service.js';

const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'O nome do grupo não pode ser vazio.').max(50, 'O nome do grupo deve ter no máximo 50 caracteres.'),
  description: z.string().max(200, 'A descrição do grupo deve ter no máximo 200 caracteres.').optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  participantIds: z.array(z.string().min(1).max(64)).optional().default([]),
});

const sendMessageSchema = z.object({
  content: z.string().max(GROUP_MESSAGE_LIMIT, 'Mensagem muito longa.'),
  replyToMessageId: z.string().min(1).max(64).optional(),
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
    const durationRaw = (request.query as { durationMs?: string }).durationMs;
    const durationMs = Number(durationRaw);
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
};