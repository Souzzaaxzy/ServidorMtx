import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { saveAudioFile, saveVideoFile, storeUpload } from './upload.service.js';
import { MAX_VIDEO_BYTES } from '../../utils/storage.js';
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

  // POST /uploads/audio — multipart "file" field (AAC/m4a voice message).
  // Returns { url, filename, mimetype, size }. The real bytes are validated
  // (never the declared type/extension) and the size is capped server-side.
  app.post('/uploads/audio', { onRequest: [app.authenticate] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      throw ApiError.validation('Nenhum arquivo enviado. Use o campo "file".');
    }
    const result = await saveAudioFile(file.file);
    return reply.status(201).send(result);
  });

  // POST /uploads/video — multipart "file" field (MP4/ISOBMFF for Post
  // videos). The real bytes are validated (never the declared extension) and
  // the size is capped at MAX_VIDEO_BYTES. This route allows the video limit
  // (larger than the generic 5MB upload cap).
  app.post('/uploads/video', { onRequest: [app.authenticate] }, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_VIDEO_BYTES } });
    if (!file) {
      throw ApiError.validation('Nenhum arquivo enviado. Use o campo "file".');
    }
    // Optional `durationMs` multipart field: the REAL media duration read by
    // the app (media metadata, not a local counter). It is re-validated here
    // so a modified client cannot exceed the 2-minute video limit.
    const rawDuration = (file.fields?.durationMs as { value?: unknown } | undefined)?.value;
    const durationMs = rawDuration === undefined ? null : Number(rawDuration);
    const result = await saveVideoFile(file.file, durationMs);
    return reply.status(201).send(result);
  });
};
