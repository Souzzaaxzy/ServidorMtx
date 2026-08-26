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
  config: Record<string, unknown>;
  active: boolean;
}

// The catalog stores `config` as a JSON string (SQLite has no Json type).
// A malformed row must never break the whole catalog — fall back to {}.
function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
    config: parseConfig(i.config),
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
  config: Record<string, unknown>;
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
    config: parseConfig(r.item.config),
  }));
}

// Free cosmetic types: no ownership required. NAME_COLOR entries are free
// palette colors — the id/active/type validation is what stops arbitrary
// values (a client-sent hex is meaningless here; only catalog ids equip).
const FREE_EQUIP_TYPES: ItemType[] = [ItemType.NAME_COLOR];

// Equip an item. The server is the ONLY authority on what can be equipped:
//   1. the item must exist in the catalog;
//   2. it must be active;
//   3. its slot is ALWAYS derived from the item's own type — the client can
//      never claim an item belongs to a different slot;
//   4. ownership is enforced for collectible items (frames, banners, ...).
export async function equipItem(userId: string, itemId: string): Promise<EquippedSlot> {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item || !item.active) throw ApiError.notFound('Item não encontrado.');

  if (!FREE_EQUIP_TYPES.includes(item.type as ItemType)) {
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
    config: parseConfig(item.config),
  };
}

export async function unequipSlot(userId: string, slot: ItemType): Promise<void> {
  await prisma.equippedItem.deleteMany({ where: { userId, slot } });
}

// ── Consolidated nickname cosmetics ──────────────────────────
// The app sends the WHOLE pending personalization in one operation ("SALVAR
// ALTERAÇÕES") instead of saving each slot individually.
//   - string id → equip (must exist, be active and have the right type);
//   - null      → unequip the slot (default color);
//   - absent    → leave the slot untouched.
// Future slots (frameId, badgeId, …) extend this same shape.
export interface NicknameCosmeticsInput {
  nameColorId?: string | null;
}

export interface NicknameCosmetics {
  nameColorId: string | null;
}

async function validateCatalogId(itemId: string, expectedType: ItemType): Promise<void> {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item || !item.active || item.type !== expectedType) {
    throw ApiError.invalidRequest('Personalização inválida.');
  }
}

export async function saveCosmetics(
  userId: string,
  input: NicknameCosmeticsInput,
): Promise<NicknameCosmetics> {
  if (input.nameColorId != null) await validateCatalogId(input.nameColorId, ItemType.NAME_COLOR);

  await prisma.$transaction(async (tx) => {
    const apply = async (slot: ItemType, itemId: string | null | undefined) => {
      if (itemId === undefined) return;
      if (itemId === null) {
        await tx.equippedItem.deleteMany({ where: { userId, slot } });
      } else {
        await tx.equippedItem.upsert({
          where: { userId_slot: { userId, slot } },
          update: { itemId },
          create: { userId, itemId, slot },
        });
      }
    };
    await apply(ItemType.NAME_COLOR, input.nameColorId);
  });

  return getCosmetics(userId);
}

export async function getCosmetics(userId: string): Promise<NicknameCosmetics> {
  const rows = await prisma.equippedItem.findMany({
    where: { userId, slot: ItemType.NAME_COLOR },
    select: { slot: true, itemId: true },
  });
  const bySlot = new Map(rows.map((r) => [r.slot, r.itemId]));
  return {
    nameColorId: bySlot.get(ItemType.NAME_COLOR) ?? null,
  };
}

export { ItemType } from '../../types/enums.js';
