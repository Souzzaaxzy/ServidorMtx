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
  CONVERSATION_MESSAGE_LIMIT,
} from './chat.service.js';

const sendMessageSchema = z.object({
  content: z.string().max(CONVERSATION_MESSAGE_LIMIT, 'Mensagem muito longa.'),
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

  // Send a message. SenderId is ALWAYS derived from the token.
  app.post('/conversations/:id/messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.validation('Dados inválidos.', parsed.error.issues);
    }
    try {
      const message = await sendMessage(request.user!.id, id, parsed.data.content);
      return reply.status(201).send({ message });
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