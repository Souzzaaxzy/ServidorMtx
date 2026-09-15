import { randomBytes } from 'node:crypto';
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
    // User-imported packages (authorId set) are private to their owner; the
    // official catalog (authorId null) is shared. Active only.
    where: {
      active: true,
      OR: [{ authorId: null }, { authorId: userId }],
    },
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

// ── Delete a package (remove from the user's collection) ─────
// A user may only delete a package THEY own (imported from share/Sticker.ly).
// The official/system catalog is administered elsewhere (RBAC) — a regular
// user must not be able to wipe it.
//
// Deleting a package must NOT break the user's FAVORITES: favorites are an
// independent collection. Before archiving the package, every favorited
// sticker is RE-CREATED as a standalone sticker (same bytes, new row under a
// hidden per-user archive package) so the favorite — and any message that
// referenced it — keeps rendering. Sticker files are never deleted with the
// package (message history depends on them).
export async function deleteStickerPackage(
  userId: string,
  packageId: string,
): Promise<{ deleted: boolean; preservedFavorites: number }> {
  const pkg = await prisma.stickerPackage.findFirst({
    where: { id: packageId },
    select: {
      id: true,
      slug: true,
      name: true,
      authorId: true,
      active: true,
      stickers: { select: { id: true, fileUrl: true, thumbUrl: true, width: true, height: true, hash: true } },
    },
  });
  if (!pkg || !pkg.active) {
    throw ApiError.notFound('Pacote de figurinhas não encontrado.');
  }
  if (pkg.authorId !== userId) {
    throw ApiError.forbidden('Você só pode excluir os pacotes que importou.');
  }

  const stickerIds = pkg.stickers.map((s) => s.id);
  const favorites = stickerIds.length
    ? await prisma.stickerFavorite.findMany({
        where: { userId, stickerId: { in: stickerIds } },
        select: { stickerId: true },
      })
    : [];
  const favoritedIds = new Set(favorites.map((f) => f.stickerId));
  const favorited = pkg.stickers.filter((s) => favoritedIds.has(s.id));

  let preservedFavorites = 0;
  if (favorited.length > 0) {
    // Hidden per-user archive: keeps favorited stickers usable/sendable
    // after the original package disappears from the picker.
    const archive = await ensureFavoriteArchivePackage(userId);
    const maxOrder = await prisma.sticker.aggregate({
      where: { packageId: archive.id },
      _max: { order: true },
    });
    let order = (maxOrder._max.order ?? -1) + 1;
    for (const s of favorited) {
      const copy = await prisma.sticker.create({
        data: {
          packageId: archive.id,
          order: order++,
          fileUrl: s.fileUrl,
          thumbUrl: s.thumbUrl,
          width: s.width,
          height: s.height,
          hash: s.hash,
          authorId: userId,
        },
      });
      // Move the favorite to the standalone copy (same bytes/URL).
      await prisma.stickerFavorite.update({
        where: { userId_stickerId: { userId, stickerId: s.id } },
        data: { stickerId: copy.id },
      });
      // Keep the sender's "recentes" working too.
      await prisma.stickerRecent.updateMany({
        where: { userId, stickerId: s.id },
        data: { stickerId: copy.id },
      });
      preservedFavorites++;
    }
  }

  // Archive the package: removed from the picker/catalog, kept in the DB so
  // old messages (which reference the original ids) keep resolving.
  await prisma.stickerPackage.update({
    where: { id: pkg.id },
    data: { active: false },
  });
  await prisma.userStickerPackage.deleteMany({ where: { userId, packageId: pkg.id } });

  return { deleted: true, preservedFavorites };
}

/** Pacote oculto por usuário que guarda cópias autônomas das favoritas. */
async function ensureFavoriteArchivePackage(userId: string) {
  const slug = `favoritos-${userId.slice(0, 16)}`;
  const existing = await prisma.stickerPackage.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.stickerPackage.create({
    data: {
      name: 'Favoritas',
      slug,
      description: 'Figurinhas favoritas salvas pelo usuário.',
      author: 'MATRIX',
      iconUrl: '',
      // Inactive on purpose: never appears in the picker/catalog — it exists
      // only so favorited stickers survive their package's deletion.
      active: false,
      authorId: userId,
      source: 'favorites',
    },
    select: { id: true },
  });
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

/**
 * Removes a sticker from the user's RECENTS only (idempotent).
 *
 * Deliberately scoped: it deletes just the `sticker_recent` row of THIS
 * user. The sticker itself, its package, its FAVORITE and any message that
 * references it are untouched — the art file is never removed here.
 */
export async function removeStickerRecent(userId: string, stickerId: string): Promise<void> {
  await prisma.stickerRecent.deleteMany({ where: { userId, stickerId } });
}


// ── Import (Android share) ───────────────────────────────────
// Stickers recibidos pelo compartilhamento do Android: o app envia os
// arquivos pelo upload padrão (/api/uploads) e chama este endpoint com as
// URLs resultantes. Aqui criamos um pacote DO USUÁRIO (authorId = userId),
// instalamos para ele e deduplicamos por SHA-256 dos bytes — reenviar a
// mesma imagem não duplica figuras no mesmo escopo do usuário.

export interface ImportedStickerInput {
  url: string;
  hash?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ImportStickerResult {
  /** Pacote criado; null quando NADA era novo (tudo já importado). */
  package: StickerPackageItem | null;
  created: number;
  skipped: number;
  /**
   * True quando o pacote já existia na coleção do usuário (reimportação do
   * mesmo código/origem) — o app usa isso para informar sem duplicar.
   */
  alreadyInstalled?: boolean;
}

function slugify(value: string): string {
  const clean = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return clean || 'meus-stickers';
}

export async function importStickerPackage(
  userId: string,
  name: string,
  stickers: ImportedStickerInput[],
): Promise<ImportStickerResult> {
  const cleanName = name.trim().slice(0, 40) || 'Meus stickers';

  const hashes = stickers
    .map((s) => s.hash?.trim())
    .filter((h): h is string => !!h);
  let existingHashSet = new Set<string>();
  if (hashes.length > 0) {
    const existing = await prisma.sticker.findMany({
      where: { authorId: userId, hash: { in: Array.from(new Set(hashes)) } },
      select: { hash: true },
    });
    existingHashSet = new Set(existing.map((r) => r.hash).filter(Boolean) as string[]);
  }

  // Deduplicate within THIS batch too (same file shared twice at once) and
  // skip anything already imported by this user.
  const seen = new Set<string>();
  const toCreate: ImportedStickerInput[] = [];
  let skipped = 0;
  for (const st of stickers) {
    const h = st.hash?.trim();
    if (h && (existingHashSet.has(h) || seen.has(h))) {
      skipped++;
      continue;
    }
    if (h) seen.add(h);
    toCreate.push(st);
  }

  if (toCreate.length === 0) {
    return { package: null, created: 0, skipped };
  }

  const first = toCreate[0];
  const pkg = await prisma.stickerPackage.create({
    data: {
      name: cleanName,
      slug: `${slugify(cleanName)}-${randomBytes(4).toString('hex')}`,
      description: 'Importado do compartilhamento do Android.',
      author: 'MATRIX',
      iconUrl: first.url,
      active: true,
      // Owned by the user (source=share) so the catalog only shows it to them.
      authorId: userId,
      source: 'share',
      stickers: {
        create: toCreate.map((st, i) => ({
          order: i,
          fileUrl: st.url,
          hash: st.hash?.trim() || null,
          width: st.width ?? null,
          height: st.height ?? null,
          authorId: userId,
        })),
      },
    },
  });

  await prisma.userStickerPackage.upsert({
    where: { userId_packageId: { userId, packageId: pkg.id } },
    update: {},
    create: { userId, packageId: pkg.id },
  });

  const packageItem = await getStickerPackage(userId, pkg.id);
  return { package: packageItem, created: toCreate.length, skipped };
}
