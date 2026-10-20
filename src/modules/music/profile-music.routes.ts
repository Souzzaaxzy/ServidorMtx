import path from 'node:path';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import { publicBase } from '../../utils/storage.js';
import { ensurePreviewFile } from './profile-music.ytdlp.js';
import {
  clearProfileMusic,
  getProfileMusic,
  searchMusic,
  setProfileMusic,
} from './profile-music.service.js';

// Música do perfil.
//   GET    /music/profile/search?q=...   (auth) → até 3 resultados
//   GET    /music/profile/preview?...    (auth) → URL do áudio da prévia
//   GET    /music/profile                (auth) → a música do próprio perfil
//   PUT    /music/profile                (auth) → define o trecho (<= 1 min)
//   DELETE /music/profile                (auth) → remove a música
//
// A busca e o download acontecem SEMPRE no servidor — o APK nunca fala com o
// YouTube, e nenhuma credencial externa existe.
export const profileMusicRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/music/profile/search', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { q } = request.query as { q?: string };
    try {
      const results = await searchMusic(q ?? '');
      return reply.send({ results });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // GET /music/profile/preview?sourceId=...
  //
  // Garante que a faixa esteja disponível e devolve a URL pública dela, para
  // o usuário OUVIR antes de confirmar. Sem isto a escolha do trecho era no
  // escuro (o download definitivo só acontece na confirmação).
  //
  // Devolve a FAIXA INTEIRA e o app usa `setClip` para tocar só a janela
  // escolhida. Vantagem: arrastar as alças NÃO baixa de novo — a faixa é
  // baixada uma vez e fica em cache no servidor. O arquivo é servido pelo
  // /static, que já responde a Range (o player precisa buscar o offset).
  app.get('/music/profile/preview', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { sourceId } = request.query as { sourceId?: string };
    if (!sourceId) throw ApiError.validation('Música inválida.');
    try {
      const file = await ensurePreviewFile(sourceId);
      // URL a partir do nome do arquivo: o /static serve uploads/.
      const name = path.basename(file.path);
      return reply.send({
        url: `${publicBase()}/static/music/preview/${name}`,
        durationMs: file.durationMs,
      });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.get('/music/profile', { onRequest: [app.authenticate] }, async (request, reply) => {
    const music = await getProfileMusic(request.user!.id);
    return reply.send({ music });
  });

  app.put('/music/profile', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      sourceId?: unknown;
      title?: unknown;
      artist?: unknown;
      coverUrl?: unknown;
      startMs?: unknown;
      durationMs?: unknown;
    };
    if (typeof body.sourceId !== 'string' || body.sourceId.trim() === '') {
      throw ApiError.validation('Selecione uma música.');
    }
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw ApiError.validation('Nome da música obrigatório.');
    }
    if (body.durationMs === undefined || body.durationMs === null) {
      throw ApiError.validation('Informe a duração do trecho.');
    }
    try {
      const music = await setProfileMusic(request.user!.id, {
        sourceId: body.sourceId.trim(),
        title: body.title,
        artist: typeof body.artist === 'string' ? body.artist : '',
        coverUrl: typeof body.coverUrl === 'string' ? body.coverUrl : null,
        startMs: body.startMs === undefined || body.startMs === null ? 0 : Number(body.startMs),
        durationMs: Number(body.durationMs),
      });
      return reply.status(201).send({ music });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/music/profile', { onRequest: [app.authenticate] }, async (request, reply) => {
    await clearProfileMusic(request.user!.id);
    return reply.status(204).send();
  });
};
