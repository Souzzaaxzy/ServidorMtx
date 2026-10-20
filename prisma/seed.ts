import { hashPassword, generateRecoveryCode, hashRecoveryCode } from '../src/utils/auth.js';
import { seedStickerPackages } from './seed-stickers.js';
import { createPrismaClient } from '../src/config/prisma.js';
import { allocatePublicId } from '../src/utils/public-id.js';

const prisma = createPrismaClient({ quiet: true });

// The level hierarchy. The APK renders the level name; the server owns the
// thresholds so re-balancing never needs an APK release.
const LEVELS = [
  { id: 1, name: 'RECRUTA', minXp: 0, color: '#6EB6FF' },
  { id: 2, name: 'MEMBRO', minXp: 500, color: '#008CFF' },
  { id: 3, name: 'VETERANO', minXp: 2500, color: '#0066FF' },
  { id: 4, name: 'ELITE', minXp: 10000, color: '#003B8F' },
  { id: 5, name: 'LENDA MATRIX', minXp: 50000, color: '#00FF88' },
];

// ── Profile frames (AVATAR_FRAME) ────────────────────────────
// The official frame catalog. `assetUrl` is the KEY that maps to the APK's
// bundled sprite (assets/frames/<key>.png); the server owns which frame the
// sprite corresponds to, so adding/removing frames is a data operation. The
// `name` is the DISPLAY name shown in the picker. Frames are free catalog
// entries (price 0): equipping validates id/active/type only — ownership is a
// future collectible concern, the same rule NAME_COLOR already uses.
const GAMES = [
  { slug: 'quiz', name: 'MATRIX Quiz', description: 'Teste seu conhecimento.' },
  { slug: 'detective', name: 'Detetive', description: 'Resolva o mistério.' },
  { slug: 'enigmas', name: 'Enigmas', description: 'Decifre os enigmas.' },
];

async function main() {
  console.log('🌱 Seeding MATRIX database…');

  // Guard: never wipe a database that already has real users. This makes the
  // seed safe to run automatically on every start without destroying data.
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    // Sticker packages are idempotent and additive — seed them even when the
    // demo users already exist (a fresh boot must always ship the catalog).
    await seedStickerPackages(prisma);
    console.log(`ℹ️  Database already has ${existingUsers} user(s). Skipping demo seed to preserve data.`);
    return;
  }

  // Wipe in dependency order so re-seeding is idempotent.
  const models = [
    prisma.gameResult, prisma.gameSession, prisma.game,
    prisma.musicVote, prisma.playlistTrack, prisma.playlist, prisma.track,
    prisma.eventReward, prisma.eventParticipant, prisma.event,
    prisma.userBadge, prisma.badge, prisma.userAchievement, prisma.achievement,
    prisma.coinTransaction, prisma.matrixCoin, prisma.xpTransaction, prisma.level,
    prisma.callParticipant, prisma.callRoom,
    prisma.appConfig,
    prisma.comment, prisma.like, prisma.post, prisma.session, prisma.user,
  ];
  for (const m of models) {
    await (m as { deleteMany: () => Promise<unknown> }).deleteMany();
  }

  await prisma.$transaction(LEVELS.map((l) => prisma.level.upsert({
    where: { id: l.id },
    update: l,
    create: l,
  })));

  await seedStickerPackages(prisma);

  await prisma.$transaction(GAMES.map((g) => prisma.game.upsert({
    where: { slug: g.slug },
    update: g,
    create: g,
  })));

  const password = await hashPassword('Password123');

  // The public `#id` is allocated per user, in creation order, so the demo
  // accounts get #00000001..#00000003 on a fresh database.
  const users = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const data of [
      {
        nickname: 'leonardo',
        nicknameKey: 'leonardo',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        role: 'OWNER',
        bio: 'Fundador do MATRIX \u{1F4A4} \u2014 construindo o futuro cronol\u00f3gico.',
        avatarUrl: 'https://i.pravatar.cc/300?img=12',
      },
      {
        nickname: 'maria',
        nicknameKey: 'maria',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        bio: 'Designer | Futurista | \u{1F49C} cyberpunk',
        avatarUrl: 'https://i.pravatar.cc/300?img=45',
      },
      {
        nickname: 'joao',
        nicknameKey: 'joao',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        bio: 'Dev backend. Coffee-driven.',
        avatarUrl: 'https://i.pravatar.cc/300?img=33',
      },
    ]) {
      const publicId = await allocatePublicId(tx);
      created.push(await tx.user.create({ data: { ...data, publicId } }));
    }
    return created;
  });

  const [leonardo, maria, joao] = users;

  const posts = await prisma.$transaction([
    prisma.post.create({
      data: {
        userId: leonardo.id,
        text: 'Bem-vindos ao MATRIX 💤 — a rede social do futuro cronológico. Tudo aqui é persistente agora!',
        imageUrl: null,
      },
    }),
    prisma.post.create({
      data: {
        userId: maria.id,
        text: 'Adorando a estética cyberpunk dessa nova versão. 🔮✨ #matrix',
        imageUrl: null,
      },
    }),
    prisma.post.create({
      data: {
        userId: joao.id,
        text: 'Backend em Fastify + Prisma + SQLite rodando liso. Migrações aplicadas, seed no ar. 🚀',
        imageUrl: null,
      },
    }),
  ]);

  // Likes: spread some engagement across posts.
  await prisma.$transaction([
    prisma.like.create({ data: { userId: maria.id, postId: posts[0].id } }),
    prisma.like.create({ data: { userId: joao.id, postId: posts[0].id } }),
    prisma.like.create({ data: { userId: leonardo.id, postId: posts[1].id } }),
    prisma.like.create({ data: { userId: joao.id, postId: posts[1].id } }),
    prisma.like.create({ data: { userId: leonardo.id, postId: posts[2].id } }),
  ]);

  // Comments: a small thread under the welcome post.
  await prisma.$transaction([
    prisma.comment.create({
      data: { userId: maria.id, postId: posts[0].id, text: 'Ficou incrível, Leo! Parabéns. 🎉' },
    }),
    prisma.comment.create({
      data: { userId: joao.id, postId: posts[0].id, text: 'Persistência finally. Bom trabalho no backend.' },
    }),
    prisma.comment.create({
      data: { userId: leonardo.id, postId: posts[1].id, text: 'Ficou perfeito, Maria!' },
    }),
  ]);

  // Grant the founder badge to Leonardo.
  await prisma.userBadge.create({
    data: { userId: leonardo.id, badgeId: 'badge_founder' },
  }).catch(() => void 0);

  // Public dynamic config defaults. SQLite stores config values as JSON
  // strings (the schema has no Json type), so serialize non-string values.
  await prisma.appConfig.upsert({
    where: { key: 'minAppVersion' },
    update: { value: JSON.stringify('1.0.0'), public: true },
    create: { key: 'minAppVersion', value: JSON.stringify('1.0.0'), public: true },
  });
  await prisma.appConfig.upsert({
    where: { key: 'maintenance' },
    update: { value: JSON.stringify(false), public: true },
    create: { key: 'maintenance', value: JSON.stringify(false), public: true },
  });

  console.log(`✅ Seeded ${LEVELS.length} levels, ${GAMES.length} games, ${users.length} users, ${posts.length} posts.`);
  console.log('   Login with any of: leonardo / maria / joao  — password: Password123');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
