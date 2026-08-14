import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError } from '../../utils/errors.js';
import { getAIProvider } from './ai_provider.js';

// Akame routes — the app talks to the backend; the backend talks to the AI
// provider. The provider key is never exposed to the client.
//   POST /akame/chat
export const akameRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/akame/chat', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body as { prompt?: string; history?: { role: 'user' | 'assistant'; content: string }[] };
    const prompt = body.prompt?.trim();
    if (!prompt) throw ApiError.invalidRequest('Mensagem obrigatória.');

    const provider = getAIProvider();
    const response = await provider.generateResponse({
      prompt,
      history: body.history,
      systemPrompt:
        'You are Akame, the assistant of the MATRIX social platform. Reply concisely in Portuguese (pt-BR).',
    });
    return reply.send({ response, provider: provider.name });
  });
};
