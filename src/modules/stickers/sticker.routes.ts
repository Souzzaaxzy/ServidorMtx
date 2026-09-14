import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toApiError } from '../../utils/errors.js';
import {
  addStickerFavorite,
  addStickerRecent,
  getStickerPackage,
  installStickerPackage,
  listStickerFavorites,
  listStickerPackages,
  listStickerRecents,
  removeStickerFavorite,
  uninstallStickerPackage,
} from './sticker.service.js';

const idParamSchema = z.string().min(1).max(64);

export const stickerRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Full sticker catalog (active packages with their stickers), each entry
  // carrying the requesting user's `installed` + per-sticker `favorited`
  // flags so the picker renders the right state immediately.
  app.get('/stickers/packages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const packages = await listStickerPackages(request.user!.id);
    return reply.send({ packages });
  });

  // One package (active) with its stickers + the same user flags.
  app.get('/stickers/packages/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      const pkg = await getStickerPackage(request.user!.id, id);
      return reply.send({ package: pkg });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Install a package (idempotent upsert). The package then appears in the
  // picker's package navigation + its stickers become available.
  app.post('/stickers/packages/:id/install', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      await installStickerPackage(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Remove a package (idempotent). Favorites/history keep working — the
  // sticker files are never deleted with the package.
  app.delete('/stickers/packages/:id/install', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      await uninstallStickerPackage(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // The user's favorites, newest first.
  app.get('/stickers/favorites', { onRequest: [app.authenticate] }, async (request, reply) => {
    const stickers = await listStickerFavorites(request.user!.id);
    return reply.send({ stickers });
  });

  // Favorite a sticker. Idempotent; works regardless of package installation.
  app.post('/stickers/:id/favorite', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      await addStickerFavorite(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Remove a favorite. Idempotent.
  app.delete('/stickers/:id/favorite', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      await removeStickerFavorite(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });

  // The user's recent stickers, newest first (deduped; bounded server-side).
  app.get('/stickers/recents', { onRequest: [app.authenticate] }, async (request, reply) => {
    const stickers = await listStickerRecents(request.user!.id);
    return reply.send({ stickers });
  });

  // Register a sticker as "used" (recent). Normally the server records this
  // automatically when a sticker MESSAGE is sent; this endpoint exists so
  // the app can also prime recents when the user simply picks a sticker
  // without sending it (e.g. before the message call resolves) — idempotent.
  app.post('/stickers/:id/recent', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      await addStickerRecent(request.user!.id, id);
      return reply.status(204).send();
    } catch (err) {
      throw toApiError(err);
    }
  });
};