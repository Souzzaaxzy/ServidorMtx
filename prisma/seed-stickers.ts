// Sticker catalog seeding. The art files live in `prisma/sticker_art/<slug>/`
// (NOT under uploads/ — they are bundled with the repo so fresh deployments
// get the official catalog without any upload step). At seed time the files
// are copied into the standard `/static/stickers/` storage folder and the
// DB rows are created (idempotent: an existing slug is left untouched).
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PrismaClient } from '../src/generated/index.js';

const ART_ROOT = path.resolve(process.cwd(), 'prisma', 'sticker_art');
const STORAGE_ROOT = path.resolve(process.cwd(), 'uploads', 'stickers');

export interface SeedSticker {
  order: number;
  fileUrl: string;
  width: number;
  height: number;
}

export interface SeedStickerPackageInput {
  slug: string;
  name: string;
  description: string;
  author: string;
  iconFile: string;
  stickers: SeedSticker[];
}

function publicBase(): string {
  return (
    process.env.STORAGE_PUBLIC_BASE_URL ??
    process.env.PUBLIC_API_URL ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

async function copyArt(slug: string, filename: string): Promise<{ url: string; width: number; height: number }> {
  const src = path.join(ART_ROOT, slug, filename);
  const destDir = path.join(STORAGE_ROOT, slug);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  await fs.copyFile(src, dest);
  return {
    url: `${publicBase()}/static/stickers/${slug}/${filename}`,
    width: 256,
    height: 256,
  };
}

export async function seedStickerPackages(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.stickerPackage.findFirst();
  if (existing) return; // idempotent — never duplicate the catalog

  const matrixCore = await fs
    .readdir(path.join(ART_ROOT, 'matrix-core'))
    .catch(() => [] as string[]);
  const neonBugs = await fs
    .readdir(path.join(ART_ROOT, 'neon-bugs'))
    .catch(() => [] as string[]);

  const builds: SeedStickerPackageInput[] = [
    {
      slug: 'matrix-core',
      name: 'Matrix Core',
      description: 'Núcleo do sistema — o pacote oficial do MATRIX.',
      author: 'MATRIX',
      iconFile: 'sticker_1.png',
      stickers: [],
    },
    {
      slug: 'neon-bugs',
      name: 'Neon Bugs',
      description: 'Bugs, glitches e robôs neon — o lado core do grid.',
      author: 'MATRIX',
      iconFile: 'sticker_1.png',
      stickers: [],
    },
  ];

  const iconUrls = new Map<string, { url: string; width: number; height: number }>();

  for (const pkg of builds) {
    const icon = await copyArt(pkg.slug, pkg.iconFile);
    iconUrls.set(pkg.slug, icon);
    const dir = pkg.slug === 'matrix-core' ? matrixCore : neonBugs;
    const files = dir
      .filter((f) => /^sticker_\d+\.png$/.test(f))
      .sort((a, b) => {
        const na = Number(a.replace(/\D+/g, ''));
        const nb = Number(b.replace(/\D+/g, ''));
        return na - nb;
      });
    if (files.length === 0) {
      // No bundled art? Skip silently — the seed must never fail a fresh boot
      // just because art is missing (the picker short-circuits with an empty
      // state and the user can still be seeded later).
      continue;
    }
    for (let i = 0; i < files.length; i++) {
      const art = await copyArt(pkg.slug, files[i]);
      pkg.stickers.push({
        order: i,
        fileUrl: art.url,
        width: art.width,
        height: art.height,
      });
    }
    if (pkg.stickers.length === 0) continue;

    await prisma.stickerPackage.create({
      data: {
        slug: pkg.slug,
        name: pkg.name,
        description: pkg.description,
        author: pkg.author,
        iconUrl: iconUrls.get(pkg.slug)!.url,
        stickers: {
          create: pkg.stickers,
        },
      },
    });
  }

  const count = await prisma.stickerPackage.count();
  if (count > 0) {
    const stickerCount = await prisma.sticker.count();
    console.log(`✅ Seeded ${count} sticker packages, ${stickerCount} stickers.`);
  }
}