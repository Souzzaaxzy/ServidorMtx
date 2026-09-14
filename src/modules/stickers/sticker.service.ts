import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';

// ── Stickers (figurinhas) ────────────────────────────────────
// Native sticker collection built on the MATRIX stack. Server-owned catalog
// (StickerPackage + Sticker), per-user installs (UserStickerPackage),
// favorites (StickerFavorite) and recents (StickerRecent). The art files are
// persisted under the standard /static/ storage — never deleted with a
// package, so favorites and message history keep rendering after a package
// is removed.

/** Maximum number of recent stickers persisted per user. */
export const STICKER_RECENTS_LIMIT = 40;

export interface StickerItem {
  id: string;
  packageId: string;
  order: number;
  fileUrl: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  /** True when the sticker is currently favorited by the requesting user. */
  favorited: boolean;
}

export interface StickerPackageItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  author: string;
  iconUrl: string;
  /** The user currently has this package installed (server-owned). */
  installed: boolean;
  stickerCount: number;
  stickers: StickerItem[];
}

const STICKER_SELECT = {
  id: true,
  packageId: true,
  order: true,
  fileUrl: true,
  thumbUrl: true,
  width: true,
  height: true,
} as const;

type StickerRow = {
  id: string;
  packageId: string;
  order: number;
  fileUrl: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
};

function toStickerItem(sticker: StickerRow, favorited: boolean): StickerItem {
  return {
    id: sticker.id,
    packageId: sticker.packageId,
    order: sticker.order,
    fileUrl: sticker.fileUrl,
    thumbUrl: sticker.thumbUrl ?? null,
    width: sticker.width ?? null,
    height: sticker.height ?? null,
    favorited,
  };
}

async function favoriteIds(userId: string, stickerIds: string[]): Promise<Set<string>> {
  if (stickerIds.length === 0) return new Set();
  const rows = await prisma.stickerFavorite.findMany({
    where: { userId, stickerId: { in: stickerIds } },
    select: { stickerId: true },
  });
  return new Set(rows.map((r) => r.stickerId));
}

async function installedPackageIds(userId: string, packageIds: string[]): Promise<Set<string>> {
  if (packageIds.length === 0) return new Set();
  const rows = await prisma.userStickerPackage.findMany({
    where: { userId, packageId: { in: packageIds } },
    select: { packageId: true },
  });
  return new Set(rows.map((r) => r.packageId));
}

// ── Catalog + installed packages ─────────────────────────────
export async function listStickerPackages(userId: string): Promise<StickerPackageItem[]> {
  const packages = await prisma.stickerPackage.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    include: {
      stickers: {
        orderBy: { order: 'asc' },
        select: STICKER_SELECT,
      },
    },
  });
  const installed = await installedPackageIds(userId, packages.map((p) => p.id));
  const favs = await favoriteIds(
    userId,
    packages.flatMap((p) => p.stickers.map((s) => s.id)),
  );
  // Only packages the user INSTALLED belong to the "meu pacote" picker set.
  return packages.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    author: p.author,
    iconUrl: p.iconUrl,
    installed: installed.has(p.id),
    stickerCount: p.stickers.length,
    stickers: p.stickers.map((s) => toStickerItem(s, favs.has(s.id))),
  }));
}

/** One package by id (active only) with its stickers, plus installed/fav flags. */
export async function getStickerPackage(userId: string, packageId: string): Promise<StickerPackageItem> {
  const pkg = await prisma.stickerPackage.findFirst({
    where: { id: packageId, active: true },
    include: { stickers: { orderBy: { order: 'asc' }, select: STICKER_SELECT } },
  });
  if (!pkg) throw ApiError.notFound('Pacote de figurinhas não encontrado.');
  const installed = await installedPackageIds(userId, [pkg.id]);
  const favs = await favoriteIds(userId, pkg.stickers.map((s) => s.id));
  return {
    id: pkg.id,
    name: pkg.name,
    slug: pkg.slug,
    description: pkg.description,
    author: pkg.author,
    iconUrl: pkg.iconUrl,
    installed: installed.has(pkg.id),
    stickerCount: pkg.stickers.length,
    stickers: pkg.stickers.map((s) => toStickerItem(s, favs.has(s.id))),
  };
}

// ── Install / remove packages (idempotent upsert / delete) ───
export async function installStickerPackage(userId: string, packageId: string): Promise<void> {
  const pkg = await prisma.stickerPackage.findFirst({
    where: { id: packageId, active: true },
    select: { id: true },
  });
  if (!pkg) throw ApiError.notFound('Pacote de figurinhas não encontrado.');
  await prisma.userStickerPackage.upsert({
    where: { userId_packageId: { userId, packageId } },
    update: {},
    create: { userId, packageId },
  });
}

export async function uninstallStickerPackage(userId: string, packageId: string): Promise<void> {
  await prisma.userStickerPackage.deleteMany({ where: { userId, packageId } });
}

// ── Favorites ────────────────────────────────────────────────
export async function listStickerFavorites(userId: string): Promise<StickerItem[]> {
  const rows = await prisma.stickerFavorite.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { sticker: { select: STICKER_SELECT } },
  });
  return rows.map((r) => toStickerItem(r.sticker, true));
}

export async function addStickerFavorite(userId: string, stickerId: string): Promise<void> {
  const sticker = await prisma.sticker.findUnique({
    where: { id: stickerId },
    select: { id: true },
  });
  if (!sticker) throw ApiError.notFound('Figurinha não encontrada.');
  // Favorites are independent of the package — even a deactivated package's
  // stickers may already be favorited and must keep working.
  await prisma.stickerFavorite.upsert({
    where: { userId_stickerId: { userId, stickerId } },
    update: {},
    create: { userId, stickerId },
  });
}

export async function removeStickerFavorite(userId: string, stickerId: string): Promise<void> {
  await prisma.stickerFavorite.deleteMany({ where: { userId, stickerId } });
}

// ── Recents ──────────────────────────────────────────────────
// Upsert (dedupe) + move-to-front + bound the total rows. Any sticker the
// user actually SENT is recorded here; a repeated send only refreshes usedAt.
export async function addStickerRecent(userId: string, stickerId: string): Promise<void> {
  await prisma.stickerRecent.upsert({
    where: { userId_stickerId: { userId, stickerId } },
    update: { usedAt: new Date() },
    create: { userId, stickerId },
  });
  // Keep the list bounded: after an upsert, prune rows beyond the same
  // user's newest limit. SQLite-compatible: one query per send is fine
  // (sends are user-driven and infrequent).
  const excess = await prisma.stickerRecent.findMany({
    where: { userId },
    orderBy: { usedAt: 'desc' },
    skip: STICKER_RECENTS_LIMIT,
    take: 100,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.stickerRecent.deleteMany({
      where: { id: { in: excess.map((r) => r.id) } },
    });
  }
}

export async function listStickerRecents(userId: string): Promise<StickerItem[]> {
  const rows = await prisma.stickerRecent.findMany({
    where: { userId },
    orderBy: { usedAt: 'desc' },
    take: STICKER_RECENTS_LIMIT,
    include: { sticker: { select: STICKER_SELECT } },
  });
  if (rows.length === 0) return [];
  const favs = await favoriteIds(
    userId,
    rows.map((r) => r.sticker.id),
  );
  return rows.map((r) => toStickerItem(r.sticker, favs.has(r.sticker.id)));
}