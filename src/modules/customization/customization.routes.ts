import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  listCatalog,
  getInventory,
  getEquipped,
  equipItem,
  unequipSlot,
  getCosmetics,
  saveCosmetics,
  type ItemType,
  type NicknameCosmeticsInput,
} from './customization.service.js';

const VALID_SLOTS: ItemType[] = ['AVATAR_FRAME', 'PROFILE_BANNER', 'BADGE', 'PROFILE_EFFECT', 'THEME_ACCCENT', 'NAME_COLOR'];

// Customization routes — all driven by server-owned data.
//   GET    /customization/catalog          list active items (colors, frames, ...)
//   GET    /customization/inventory        my owned (non-expired) items
//   GET    /customization/equipped         my currently equipped items
//   GET    /customization/cosmetics        my consolidated nickname cosmetics
//   PUT    /customization/cosmetics        save nickname cosmetics in ONE operation
//   POST   /customization/equip/:itemId    equip an owned item
//   DELETE /customization/equip/:slot      unequip a slot
export const customizationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/customization/catalog', async (request, reply) => {
    const type = (request.query as { type?: ItemType })?.type;
    const items = await listCatalog(type);
    return reply.send({ items });
  });

  app.get('/customization/inventory', { onRequest: [app.authenticate] }, async (request, reply) => {
    const items = await getInventory(request.user!.id);
    return reply.send({ items });
  });

  app.get('/customization/equipped', { onRequest: [app.authenticate] }, async (request, reply) => {
    const equipped = await getEquipped(request.user!.id);
    return reply.send({ equipped });
  });

  app.get('/customization/cosmetics', { onRequest: [app.authenticate] }, async (request, reply) => {
    const cosmetics = await getCosmetics(request.user!.id);
    return reply.send({ cosmetics });
  });

  app.put('/customization/cosmetics', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    // Strict allow-list: the client sends catalog IDs only — never CSS,
    // JavaScript, HTML or arbitrary definitions. Unknown fields are
    // rejected so future slots (frameId, badgeId, …) fail loudly until the
    // server supports them.
    const ALLOWED = new Set(['nameColorId']);
    for (const key of Object.keys(body)) {
      if (!ALLOWED.has(key)) throw ApiError.invalidRequest(`Campo não suportado: ${key}`);
    }
    const input: NicknameCosmeticsInput = {};
    for (const field of ['nameColorId'] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== 'string') {
        throw ApiError.invalidRequest(`${field} deve ser um id de catálogo ou null.`);
      }
      input[field] = value;
    }
    try {
      const cosmetics = await saveCosmetics(request.user!.id, input);
      return reply.send({ cosmetics });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.post('/customization/equip/:itemId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { itemId } = request.params as { itemId: string };
    try {
      const slot = await equipItem(request.user!.id, itemId);
      return reply.send({ equipped: slot });
    } catch (err) {
      throw toApiError(err);
    }
  });

  app.delete('/customization/equip/:slot', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { slot } = request.params as { slot: ItemType };
    if (!VALID_SLOTS.includes(slot)) throw ApiError.invalidRequest('Slot inválido.');
    await unequipSlot(request.user!.id, slot);
    return reply.status(204).send();
  });
};
