import { PrismaClient } from '../src/generated/index.js';
import { hashPassword, generateRecoveryCode, hashRecoveryCode } from '../src/utils/auth.js';

const prisma = new PrismaClient();

// The level hierarchy. The APK renders the level name; the server owns the
// thresholds so re-balancing never needs an APK release.
const LEVELS = [
  { id: 1, name: 'RECRUTA', minXp: 0, color: '#6EB6FF' },
  { id: 2, name: 'MEMBRO', minXp: 500, color: '#008CFF' },
  { id: 3, name: 'VETERANO', minXp: 2500, color: '#0066FF' },
  { id: 4, name: 'ELITE', minXp: 10000, color: '#003B8F' },
  { id: 5, name: 'LENDA MATRIX', minXp: 50000, color: '#00FF88' },
];

// A small starter catalog. Adding more is a data operation — no APK release.
const ITEMS = [
  { id: 'frame_neon_blue', type: 'AVATAR_FRAME' as const, name: 'Neon Blue', assetUrl: 'frames/neon_blue', rarity: 'RARE' as const, price: 200 },
  { id: 'frame_void', type: 'AVATAR_FRAME' as const, name: 'Void Edge', assetUrl: 'frames/void_edge', rarity: 'EPIC' as const, price: 800 },
  { id: 'banner_cyber', type: 'PROFILE_BANNER' as const, name: 'Cyber Grid', assetUrl: 'banners/cyber_grid', rarity: 'UNCOMMON' as const, price: 150 },
  { id: 'badge_founder', type: 'BADGE' as const, name: 'Founder', assetUrl: 'badges/founder', rarity: 'LEGENDARY' as const, price: 0 },
  { id: 'effect_glitch', type: 'PROFILE_EFFECT' as const, name: 'Glitch', assetUrl: 'effects/glitch', rarity: 'EPIC' as const, price: 600 },
];

const GAMES = [
  { slug: 'quiz', name: 'MATRIX Quiz', description: 'Teste seu conhecimento.' },
  { slug: 'detective', name: 'Detetive', description: 'Resolva o mistério.' },
  { slug: 'enigmas', name: 'Enigmas', description: 'Decifre os enigmas.' },
];

async function main() {
  console.log('🌱 Seeding MATRIX database…');

  // Wipe in dependency order so re-seeding is idempotent.
  const models = [
    prisma.gameResult, prisma.gameSession, prisma.game,
    prisma.musicVote, prisma.playlistTrack, prisma.playlist, prisma.track,
    prisma.eventReward, prisma.eventParticipant, prisma.event,
    prisma.equippedItem, prisma.userItem, prisma.item,
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

  await prisma.$transaction(ITEMS.map((i) => prisma.item.upsert({
    where: { id: i.id },
    update: i,
    create: i,
  })));

  await prisma.$transaction(GAMES.map((g) => prisma.game.upsert({
    where: { slug: g.slug },
    update: g,
    create: g,
  })));

  const password = await hashPassword('Password123');

  const users = await prisma.$transaction([
    prisma.user.create({
      data: {
        name: 'Leonardo Souza',
        username: 'leonardo',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        role: 'OWNER',
        bio: 'Fundador do MATRIX 💤 — construindo o futuro cronológico.',
        avatarUrl: 'https://i.pravatar.cc/300?img=12',
      },
    }),
    prisma.user.create({
      data: {
        name: 'Maria Silva',
        username: 'maria',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        bio: 'Designer | Futurista | 💜 cyberpunk',
        avatarUrl: 'https://i.pravatar.cc/300?img=45',
      },
    }),
    prisma.user.create({
      data: {
        name: 'João Pedro',
        username: 'joao',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        bio: 'Dev backend. Coffee-driven.',
        avatarUrl: 'https://i.pravatar.cc/300?img=33',
      },
    }),
  ]);

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
        text: 'Backend em Fastify + Prisma + PostgreSQL rodando liso. Migrações aplicadas, seed no ar. 🚀',
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

  // Public dynamic config defaults.
  await prisma.appConfig.upsert({
    where: { key: 'minAppVersion' },
    update: { value: '1.0.0', public: true },
    create: { key: 'minAppVersion', value: '1.0.0', public: true },
  });
  await prisma.appConfig.upsert({
    where: { key: 'maintenance' },
    update: { value: false, public: true },
    create: { key: 'maintenance', value: false, public: true },
  });

  console.log(`✅ Seeded ${LEVELS.length} levels, ${ITEMS.length} items, ${GAMES.length} games, ${users.length} users, ${posts.length} posts.`);
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
