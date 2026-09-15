import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toApiError } from '../../utils/errors.js';
import {
  addStickerFavorite,
  addStickerRecent,
  deleteStickerPackage,
  getStickerPackage,
  importStickerPackage,
  installStickerPackage,
  listStickerFavorites,
  listStickerPackages,
  listStickerRecents,
  removeStickerFavorite,
  uninstallStickerPackage,
  type ImportedStickerInput,
} from './sticker.service.js';
import {
  fetchStickerlyPack,
  findExistingStickerlyPackage,
  importStickerlyPack,
  parseStickerlyCode,
} from './stickerly.service.js';

const idParamSchema = z.string().min(1).max(64);

// Corpo do lookup/import de um pacote do Sticker.ly (código ou link).
const stickerlySchema = z.object({
  code: z.string().min(1).max(200),
});

// Corpo do import de figurinhas vindas do compartilhamento do Android.
const importSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  stickers: z
    .array(
      z.object({
        url: z.string().min(1).max(500),
        hash: z.string().min(1).max(128).optional().nullable(),
        width: z.number().int().positive().max(4096).optional().nullable(),
        height: z.number().int().positive().max(4096).optional().nullable(),
      }),
    )
    .min(1)
    .max(60),
});

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

  // Delete a package from the collection. Only the OWNER of a user-imported
  // package may delete it (the official catalog is not deletable by regular
  // users). The package is ARCHIVED, never physically wiped — old messages
  // keep rendering — and the user's FAVORITED stickers are preserved as
  // standalone copies so the favorites collection survives.
  app.delete('/stickers/packages/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!idParamSchema.safeParse(id).success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Identificador inválido.' } });
    }
    try {
      const result = await deleteStickerPackage(request.user!.id, id);
      return reply.send(result);
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

  // Import stickers received through the Android share intent. The app
  // uploads the images via /api/uploads and calls this endpoint with the
  // resulting URLs; the server creates a USER-owned package, installs it
  // automatically and dedupes by file hash (repeated shares don't duplicate).
  app.post('/stickers/import', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Dados inválidos para importar figurinhas.' } });
    }
    const { name, stickers } = parsed.data as {
      name?: string;
      stickers: ImportedStickerInput[];
    };
    try {
      const result = await importStickerPackage(request.user!.id, name ?? '', stickers);
      return reply.status(201).send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });

  // ── Importação por código do Sticker.ly ────────────────────
  // O download/validação acontece AQUI (o APK nunca fala com o Sticker.ly
  // nem carrega credenciais). Ambos os endpoints exigem autenticação.

  // Prévia: devolve os dados do pacote SEM importar (nome, autor, capa e a
  // lista de figurinhas) para o app exibir a confirmação. `existingPackageId`
  // sinaliza que o usuário já tem esse pacote na coleção.
  app.post('/stickers/stickerly/preview', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = stickerlySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Informe o código do pacote do Sticker.ly.' } });
    }
    try {
      const code = parseStickerlyCode(parsed.data.code);
      const existing = await findExistingStickerlyPackage(request.user!.id, code);
      const pack = await fetchStickerlyPack(code);
      return reply.send({
        code: pack.code,
        name: pack.name,
        author: pack.author,
        iconUrl: pack.iconUrl,
        shareUrl: pack.shareUrl,
        animated: pack.animated,
        stickerCount: pack.stickerCount,
        stickers: pack.stickers.map((s) => ({ url: s.url })),
        alreadyInstalled: existing !== null,
        existingPackageId: existing?.id ?? null,
      });
    } catch (err) {
      throw toApiError(err);
    }
  });

  // Importação: baixa, valida os bytes, guarda e cria um pacote do usuário
  // (dedupe por hash/origem). Reimportar o mesmo código não duplica.
  app.post('/stickers/stickerly/import', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = stickerlySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Informe o código do pacote do Sticker.ly.' } });
    }
    try {
      const code = parseStickerlyCode(parsed.data.code);
      const result = await importStickerlyPack(request.user!.id, code);
      return reply.status(result.created > 0 ? 201 : 200).send(result);
    } catch (err) {
      throw toApiError(err);
    }
  });
};