import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { storeUpload } from './upload.service.js';
import { ApiError } from '../../utils/errors.js';

export const uploadRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // POST /uploads — multipart "file" field. Requires auth.
  // Returns { url, filename, mimetype, size }.
  app.post('/uploads', { onRequest: [app.authenticate] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      throw ApiError.validation('Nenhum arquivo enviado. Use o campo "file".');
    }
    const result = await storeUpload(file.filename, file.mimetype, file.file);
    return reply.status(201).send(result);
  });
};
