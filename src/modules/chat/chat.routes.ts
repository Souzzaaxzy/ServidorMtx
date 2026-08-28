import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  deleteMessageForEveryone,
  deleteMessageForMe,
  getMessages,
  getOrCreateConversation,
  hideConversation,
  listConversations,
  markConversationRead,
  sendMessage,
  sendVoiceMessage,
  unreadConversationCount,
  setTyping,
  setRecording,
  CONVERSATION_MESSAGE_LIMIT,
} from './chat.service.js';

const sendMessageSchema = z.object({
  content: z.string().max(CONVERSATION_MESSAGE_LIMIT, 'Mensagem muito longa.'),
  replyToMessageId: z.string().min(1).max(64).optional(),
});

const typingBodySchema = z.object({
  typing: z.boolean(),
});

const recordingBodySchema = z
  .object({
    recording: z.boolean().optional(),
    // Backward compat: earlier app builds posted the typing key for this
    // endpoint — accept it as a fallback so no stale client starts echoing.
    typing: z.boolean().optional(),
  })
  .refine((d) => d.recording !== undefined || d.typing !== undefined, {
    message: 'Informe recording ou typing.',
  });

const messageQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const chatRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Conversations list of the authenticated user (Chat tab).
  app.get('/conversations', { onRequest: [app.authenticate] }, async (request, reply) => {
    const conversations = await listConversations(request.user!.id);
    return reply.send({ conversations });
  });

  // Unread badge for the Chat tab.
  app.get('/conversations/unread-count', { onRequest: [app.authenticate] }, async (request, reply) => {
    const unreadCount = await unreadConversationCount(request.user!.id);
    return reply.send({ unreadCount });
  });

  // Get-or-create the (single) conversation with another user. Friends only.
  app.post('/conversations/:otherUserId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { otherUserId } = request.params as { otherUserId: string };
    try {
      const conversation = await getOrCreateConversation(request.user!.id, otherUserId);
      return reply.send({ conversation });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Messages of a conversation the user belongs to (paginated).
  app.get('/conversations/:id/messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = messageQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw ApiError.validation('Parâmetros inválidos.', parsed.error.issues);
    }
    try {
      const page = await getMessages(request.user!.id, id, parsed.data);
      return reply.send(page);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Send a message. SenderId is ALWAYS derived from the token. May carry an
  // optional replyToMessageId pointing at an existing message of the SAME
  // conversation (only the reference is stored server-side).
  app.post('/conversations/:id/messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const message = await sendMessage(
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

  // Send a VOICE message — multipart with a "file" audio field; the recorded
  // duration is passed as a query param so multipart field-typing never gets
  // in the way of reading it. The server persists the file (validating the
  // real bytes + size) and creates a "voice" message that references it.
  // SenderId comes from the token, membership + friends-only are enforced.
  // Duration gate is 1–60s, matching the app's clamp (short hold-to-talk
  // notes must not be silently rejected). The peer receives a normal
  // `chat_message` realtime frame.
  app.post('/conversations/:id/voice', { onRequest: [app.authenticate] }, async (request, reply) => {
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
      const message = await sendVoiceMessage(request.user!.id, id, {
        file: part.file,
        durationMs: Number.isFinite(durationMs) ? durationMs : NaN,
      });
      // Production-safe telemetry: captures the persisted result so the
      // upload→storage→message chain is auditable (no payload, no tokens).
      request.log.info(
        {
          conversationId: id,
          durationMs,
          messageId: message.id,
          audioUrl: message.audioUrl,
          bytes: message.content.length,
        },
        'voice message stored',
      );
      return reply.status(201).send({ message });
    } catch (err) {
      throw toApiError(err);
    }
  });

    // Realtime voice-recording indicator ("gravando áudio"). Same ephemeral
  // shape as the typing signal — the peer's open conversation shows/hides the
  // hint in realtime (the sender also clears it on release/cancel/error).
  app.post('/conversations/:id/recording', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = recordingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      await setRecording(request.user!.id, id, parsed.data.recording ?? parsed.data.typing!);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

// Realtime typing indicator. The server only relays an ephemeral frame to
  // the peer's live sockets — nothing is persisted, so there is no "typing
  // stuck" state to clean up server-side; the peer also auto-clears it on a
  // time-out or when it stops watching the conversation.
  app.post('/conversations/:id/typing', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = typingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      await setTyping(request.user!.id, id, parsed.data.typing);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Mark a conversation as read by the session user (clears the unread badge).
  app.post('/conversations/:id/read', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await markConversationRead(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Excluir mensagem PARA MIM (viewer-specific soft-delete). The message
  // disappears for the caller only — the peer keeps it. Idempotent. Server
  // validates membership + that the message belongs to the conversation.
  app.delete('/conversations/:id/messages/:messageId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    try {
      await deleteMessageForMe(request.user!.id, id, messageId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Excluir mensagem PARA TODOS (server-authoritative soft-delete). Marks the
  // message deleted so BOTH participants stop seeing it, and broadcasts a
  // realtime `chat_message_deleted` frame to the peer's live sockets.
  // A message may be deleted for everyone by EITHER participant.
  app.delete('/conversations/:id/messages/:messageId/everyone', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    try {
      await deleteMessageForEveryone(request.user!.id, id, messageId);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Excluir conversa PARA MIM — removes the conversation from the caller's
  // list only (the peer keeps it + all messages). A new incoming message from
  // the peer un-hides it so it reappears, per normal chat behavior. Idempotent.
  app.delete('/conversations/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await hideConversation(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};