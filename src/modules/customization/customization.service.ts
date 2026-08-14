import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import type { ItemType } from '../../generated/index.js';

// ── Personalization Engine ─────────────────────────────────────
// The APK renders generic item "types" (avatar_frame, profile_banner, …).
// The server owns which items exist, their rarity, pricing and validity.
// Adding a new frame/banner/badge is a data operation — no APK release.

export interface CatalogItem {
  id: string;
  type: ItemType;
  name: string;
  assetUrl: string;
  rarity: string;
  price: number;
  active: boolean;
}

export async function listCatalog(type?: ItemType): Promise<CatalogItem[]> {
  const items = await prisma.item.findMany({
    where: { active: true, ...(type ? { type } : {}) },
    orderBy: [{ rarity: 'asc' }, { name: 'asc' }],
  });
  return items.map((i) => ({
    id: i.id,
    type: i.type,
    name: i.name,
    assetUrl: i.assetUrl,
    rarity: i.rarity,
    price: i.price,
    active: i.active,
  }));
}

export interface UserInventoryEntry {
  itemId: string;
  name: string;
  type: ItemType;
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
  slot: ItemType;
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

// Equip an item the user owns. Enforces ownership + (for temporary items)
// that the item has not expired.
export async function equipItem(userId: string, itemId: string): Promise<EquippedSlot> {
  const owned = await prisma.userItem.findUnique({
    where: { userId_itemId: { userId, itemId } },
    include: { item: true },
  });
  if (!owned) throw ApiError.notFound('Item não encontrado no inventário.');
  if (owned.expiresAt && owned.expiresAt < new Date()) {
    throw ApiError.invalidRequest('Item expirado.');
  }

  const slot = owned.item.type;
  await prisma.equippedItem.upsert({
    where: { userId_slot: { userId, slot } },
    update: { itemId },
    create: { userId, itemId, slot },
  });
  return {
    slot,
    itemId: owned.item.id,
    name: owned.item.name,
    assetUrl: owned.item.assetUrl,
    rarity: owned.item.rarity,
  };
}

export async function unequipSlot(userId: string, slot: ItemType): Promise<void> {
  await prisma.equippedItem.deleteMany({ where: { userId, slot } });
}

export { ItemType } from '../../generated/index.js';
