import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { ItemType } from '../../types/enums.js';

// ── Personalization Engine ─────────────────────────────────────
// The APK renders generic item "types" (avatar_frame, profile_banner, …).
// The server owns which items exist, their rarity, pricing and validity.
// Adding a new frame/banner/badge is a data operation — no APK release.

export interface CatalogItem {
  id: string;
  type: string;
  name: string;
  assetUrl: string;
  rarity: string;
  price: number;
  category: string | null;
  sortOrder: number;
  active: boolean;
}

export async function listCatalog(type?: ItemType): Promise<CatalogItem[]> {
  const items = await prisma.item.findMany({
    where: { active: true, ...(type ? { type } : {}) },
    // Curated order: category groups first, then the explicit sortOrder
    // inside each group (falls back to rarity/name for legacy rows).
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { rarity: 'asc' }, { name: 'asc' }],
  });
  return items.map((i) => ({
    id: i.id,
    type: i.type,
    name: i.name,
    assetUrl: i.assetUrl,
    rarity: i.rarity,
    price: i.price,
    category: i.category,
    sortOrder: i.sortOrder,
    active: i.active,
  }));
}

export interface UserInventoryEntry {
  itemId: string;
  name: string;
  type: string;
  assetUrl: string;
  rarity: string;
  quantity: number;
  acquiredAt: string;
  expiresAt: string | null;
  source: string;
}

// Returns the user's inventory, filtering out expired temporary items so the
// client never renders something the user no longer owns.
export async function getInventory(userId: string): Promise<UserInventoryEntry[]> {
  const now = new Date();
  const entries = await prisma.userItem.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { item: true },
    orderBy: { acquiredAt: 'desc' },
  });
  return entries.map((e) => ({
    itemId: e.item.id,
    name: e.item.name,
    type: e.item.type,
    assetUrl: e.item.assetUrl,
    rarity: e.item.rarity,
    quantity: e.quantity,
    acquiredAt: e.acquiredAt.toISOString(),
    expiresAt: e.expiresAt?.toISOString() ?? null,
    source: e.source,
  }));
}

export interface EquippedSlot {
  slot: string;
  itemId: string;
  name: string;
  assetUrl: string;
  rarity: string;
}

export async function getEquipped(userId: string): Promise<EquippedSlot[]> {
  const rows = await prisma.equippedItem.findMany({
    where: { userId },
    include: { item: true },
  });
  return rows.map((r) => ({
    slot: r.slot,
    itemId: r.item.id,
    name: r.item.name,
    assetUrl: r.item.assetUrl,
    rarity: r.item.rarity,
  }));
}

// Equip an item. The server is the ONLY authority on what can be equipped:
//   1. the item must exist in the catalog;
//   2. it must be active;
//   3. its slot is ALWAYS derived from the item's own type — the client can
//      never claim an item belongs to a different slot;
//   4. ownership is enforced for collectible items (frames, banners, ...).
//      NAME_COLOR entries are free palette colors, so ownership is not
//      required — the validation above is what stops arbitrary values
//      (a client-sent hex is meaningless here; only catalog ids equip).
export async function equipItem(userId: string, itemId: string): Promise<EquippedSlot> {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item || !item.active) throw ApiError.notFound('Item não encontrado.');

  if (item.type !== ItemType.NAME_COLOR) {
    const owned = await prisma.userItem.findUnique({
      where: { userId_itemId: { userId, itemId } },
    });
    if (!owned) throw ApiError.notFound('Item não encontrado no inventário.');
    if (owned.expiresAt && owned.expiresAt < new Date()) {
      throw ApiError.invalidRequest('Item expirado.');
    }
  }

  const slot = item.type;
  await prisma.equippedItem.upsert({
    where: { userId_slot: { userId, slot } },
    update: { itemId },
    create: { userId, itemId, slot },
  });
  return {
    slot,
    itemId: item.id,
    name: item.name,
    assetUrl: item.assetUrl,
    rarity: item.rarity,
  };
}

export async function unequipSlot(userId: string, slot: ItemType): Promise<void> {
  await prisma.equippedItem.deleteMany({ where: { userId, slot } });
}

export { ItemType } from '../../types/enums.js';
