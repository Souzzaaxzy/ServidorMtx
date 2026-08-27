import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  getMessages,
  getOrCreateConversation,
  listConversations,
  markConversationRead,
  sendMessage,
  unreadConversationCount,
  setTyping,
  CONVERSATION_MESSAGE_LIMIT,
} from './chat.service.js';

const sendMessageSchema = z.object({
  content: z.string().max(CONVERSATION_MESSAGE_LIMIT, 'Mensagem muito longa.'),
  replyToMessageId: z.string().min(1).max(64).optional(),
});

const typingBodySchema = z.object({
  typing: z.boolean(),
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
};