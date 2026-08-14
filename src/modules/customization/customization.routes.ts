import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ApiError, toApiError } from '../../utils/errors.js';
import {
  listCatalog,
  getInventory,
  getEquipped,
  equipItem,
  unequipSlot,
  type ItemType,
} from './customization.service.js';

const VALID_SLOTS: ItemType[] = ['AVATAR_FRAME', 'PROFILE_BANNER', 'BADGE', 'PROFILE_EFFECT', 'THEME_ACCCENT'];

// Customization routes — all driven by server-owned data.
//   GET    /customization/catalog          list active items
//   GET    /customization/inventory        my owned (non-expired) items
//   GET    /customization/equipped         my currently equipped items
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
