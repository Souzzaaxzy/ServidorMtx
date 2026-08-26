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

// ── Profile frames (AVATAR_FRAME) ────────────────────────────
// The official frame catalog. `assetUrl` is the KEY that maps to the APK's
// bundled sprite (assets/frames/<key>.png); the server owns which frame the
// sprite corresponds to, so adding/removing frames is a data operation. The
// `name` is the DISPLAY name shown in the picker. Frames are free catalog
// entries (price 0): equipping validates id/active/type only — ownership is a
// future collectible concern, the same rule NAME_COLOR already uses.
const FRAMES = [
  { id: 'frame_jormungandr', name: 'Jörmundgandr', assetUrl: 'frames/jormungandr', rarity: 'LEGENDARY' as const },
  { id: 'frame_buraco_negro', name: 'Buraco Negro', assetUrl: 'frames/buraco_negro', rarity: 'EPIC' as const },
  { id: 'frame_cometa', name: 'Cometa', assetUrl: 'frames/cometa', rarity: 'EPIC' as const },
  { id: 'frame_constelacao', name: 'Constelação', assetUrl: 'frames/constelacao', rarity: 'UNCOMMON' as const },
  { id: 'frame_coroa', name: 'Coroa', assetUrl: 'frames/coroa', rarity: 'LEGENDARY' as const },
  { id: 'frame_dragao', name: 'Dragão', assetUrl: 'frames/dragao', rarity: 'EPIC' as const },
  { id: 'frame_eclipse', name: 'Eclipse', assetUrl: 'frames/eclipse', rarity: 'RARE' as const },
  { id: 'frame_estrelas', name: 'Estrelas', assetUrl: 'frames/estrelas', rarity: 'UNCOMMON' as const },
  { id: 'frame_fantasma', name: 'Fantasma', assetUrl: 'frames/fantasma', rarity: 'RARE' as const },
  { id: 'frame_hydra', name: 'Hydra', assetUrl: 'frames/hydra', rarity: 'EPIC' as const },
  { id: 'frame_leviata', name: 'Leviatã', assetUrl: 'frames/leviata', rarity: 'EPIC' as const },
  { id: 'frame_lotus', name: 'Lotus', assetUrl: 'frames/lotus', rarity: 'UNCOMMON' as const },
  { id: 'frame_lua', name: 'Lua', assetUrl: 'frames/lua', rarity: 'RARE' as const },
  { id: 'frame_lua_crescente', name: 'Lua Crescente', assetUrl: 'frames/lua_crescente', rarity: 'UNCOMMON' as const },
  { id: 'frame_nebulosa', name: 'Nebulosa', assetUrl: 'frames/nebulosa', rarity: 'RARE' as const },
  { id: 'frame_olho_do_abismo', name: 'Olho do Abismo', assetUrl: 'frames/olho_do_abismo', rarity: 'EPIC' as const },
];

// A small starter catalog. Adding more is a data operation — no APK release.
// (Frames are defined in FRAMES above; other cosmetic categories stay here.)
const ITEMS = [
  { id: 'banner_cyber', type: 'PROFILE_BANNER' as const, name: 'Cyber Grid', assetUrl: 'banners/cyber_grid', rarity: 'UNCOMMON' as const, price: 150 },
  { id: 'badge_founder', type: 'BADGE' as const, name: 'Founder', assetUrl: 'badges/founder', rarity: 'LEGENDARY' as const, price: 0 },
  { id: 'effect_glitch', type: 'PROFILE_EFFECT' as const, name: 'Glitch', assetUrl: 'effects/glitch', rarity: 'EPIC' as const, price: 600 },
];

// ── Nickname color palette (NAME_COLOR) ──────────────────────
// The official, server-owned palette. The app NEVER hardcodes which colors
// exist — it renders whatever this catalog returns. `assetUrl` carries the
// hex value (the "asset" of a color is the color itself), `category` groups
// the palette for the picker UI and `sortOrder` keeps the curated order.
// Colors are free (price 0): equipping validates id/active/type only.
const NAME_COLORS = [
  { id: 'red', type: 'NAME_COLOR' as const, name: 'Vermelho', assetUrl: '#E53935', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 0 },
  { id: 'orange', type: 'NAME_COLOR' as const, name: 'Laranja', assetUrl: '#FB8C00', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 1 },
  { id: 'yellow', type: 'NAME_COLOR' as const, name: 'Amarelo', assetUrl: '#FDD835', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 2 },
  { id: 'green', type: 'NAME_COLOR' as const, name: 'Verde', assetUrl: '#43A047', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 3 },
  { id: 'blue', type: 'NAME_COLOR' as const, name: 'Azul', assetUrl: '#1E88E5', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 4 },
  { id: 'purple', type: 'NAME_COLOR' as const, name: 'Roxo', assetUrl: '#8E24AA', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 5 },
  { id: 'pink', type: 'NAME_COLOR' as const, name: 'Rosa', assetUrl: '#EC407A', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 6 },
  { id: 'cyan', type: 'NAME_COLOR' as const, name: 'Ciano', assetUrl: '#00ACC1', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 7 },
  { id: 'gray', type: 'NAME_COLOR' as const, name: 'Cinza', assetUrl: '#757575', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 8 },
  { id: 'black', type: 'NAME_COLOR' as const, name: 'Preto', assetUrl: '#212121', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 9 },
  { id: 'white', type: 'NAME_COLOR' as const, name: 'Branco', assetUrl: '#FAFAFA', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 10 },
  { id: 'brown', type: 'NAME_COLOR' as const, name: 'Marrom', assetUrl: '#795548', rarity: 'COMMON' as const, price: 0, category: 'basic', sortOrder: 11 },
  { id: 'dark_red', type: 'NAME_COLOR' as const, name: 'Vermelho Escuro', assetUrl: '#8E0000', rarity: 'COMMON' as const, price: 0, category: 'reds', sortOrder: 12 },
  { id: 'bright_red', type: 'NAME_COLOR' as const, name: 'Vermelho Vivo', assetUrl: '#FF1744', rarity: 'COMMON' as const, price: 0, category: 'reds', sortOrder: 13 },
  { id: 'crimson', type: 'NAME_COLOR' as const, name: 'Vermelho Carmesim', assetUrl: '#DC143C', rarity: 'COMMON' as const, price: 0, category: 'reds', sortOrder: 14 },
  { id: 'ruby', type: 'NAME_COLOR' as const, name: 'Vermelho Rubi', assetUrl: '#C2185B', rarity: 'COMMON' as const, price: 0, category: 'reds', sortOrder: 15 },
  { id: 'blood_red', type: 'NAME_COLOR' as const, name: 'Vermelho Sangue', assetUrl: '#6B0000', rarity: 'COMMON' as const, price: 0, category: 'reds', sortOrder: 16 },
  { id: 'dark_orange', type: 'NAME_COLOR' as const, name: 'Laranja Escuro', assetUrl: '#E65100', rarity: 'COMMON' as const, price: 0, category: 'oranges', sortOrder: 17 },
  { id: 'bright_orange', type: 'NAME_COLOR' as const, name: 'Laranja Vivo', assetUrl: '#FF6D00', rarity: 'COMMON' as const, price: 0, category: 'oranges', sortOrder: 18 },
  { id: 'burnt_orange', type: 'NAME_COLOR' as const, name: 'Laranja Queimado', assetUrl: '#BF5700', rarity: 'COMMON' as const, price: 0, category: 'oranges', sortOrder: 19 },
  { id: 'tangerine', type: 'NAME_COLOR' as const, name: 'Tangerina', assetUrl: '#FF8F00', rarity: 'COMMON' as const, price: 0, category: 'oranges', sortOrder: 20 },
  { id: 'peach', type: 'NAME_COLOR' as const, name: 'Pêssego', assetUrl: '#FFAB91', rarity: 'COMMON' as const, price: 0, category: 'oranges', sortOrder: 21 },
  { id: 'dark_yellow', type: 'NAME_COLOR' as const, name: 'Amarelo Escuro', assetUrl: '#C6A700', rarity: 'COMMON' as const, price: 0, category: 'yellows', sortOrder: 22 },
  { id: 'bright_yellow', type: 'NAME_COLOR' as const, name: 'Amarelo Vivo', assetUrl: '#FFEA00', rarity: 'COMMON' as const, price: 0, category: 'yellows', sortOrder: 23 },
  { id: 'gold', type: 'NAME_COLOR' as const, name: 'Dourado', assetUrl: '#D4AF37', rarity: 'COMMON' as const, price: 0, category: 'yellows', sortOrder: 24 },
  { id: 'amber', type: 'NAME_COLOR' as const, name: 'Âmbar', assetUrl: '#FFC107', rarity: 'COMMON' as const, price: 0, category: 'yellows', sortOrder: 25 },
  { id: 'lime', type: 'NAME_COLOR' as const, name: 'Limão', assetUrl: '#C6FF00', rarity: 'COMMON' as const, price: 0, category: 'yellows', sortOrder: 26 },
  { id: 'dark_green', type: 'NAME_COLOR' as const, name: 'Verde Escuro', assetUrl: '#1B5E20', rarity: 'COMMON' as const, price: 0, category: 'greens', sortOrder: 27 },
  { id: 'bright_green', type: 'NAME_COLOR' as const, name: 'Verde Vivo', assetUrl: '#00C853', rarity: 'COMMON' as const, price: 0, category: 'greens', sortOrder: 28 },
  { id: 'emerald', type: 'NAME_COLOR' as const, name: 'Verde Esmeralda', assetUrl: '#009688', rarity: 'COMMON' as const, price: 0, category: 'greens', sortOrder: 29 },
  { id: 'lime_green', type: 'NAME_COLOR' as const, name: 'Verde Limão', assetUrl: '#64DD17', rarity: 'COMMON' as const, price: 0, category: 'greens', sortOrder: 30 },
  { id: 'mint', type: 'NAME_COLOR' as const, name: 'Verde Menta', assetUrl: '#69F0AE', rarity: 'COMMON' as const, price: 0, category: 'greens', sortOrder: 31 },
  { id: 'olive', type: 'NAME_COLOR' as const, name: 'Verde Oliva', assetUrl: '#827717', rarity: 'COMMON' as const, price: 0, category: 'greens', sortOrder: 32 },
  { id: 'dark_blue', type: 'NAME_COLOR' as const, name: 'Azul Escuro', assetUrl: '#0D47A1', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 33 },
  { id: 'bright_blue', type: 'NAME_COLOR' as const, name: 'Azul Vivo', assetUrl: '#2962FF', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 34 },
  { id: 'navy', type: 'NAME_COLOR' as const, name: 'Azul Marinho', assetUrl: '#1A237E', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 35 },
  { id: 'royal_blue', type: 'NAME_COLOR' as const, name: 'Azul Royal', assetUrl: '#4169E1', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 36 },
  { id: 'electric_blue', type: 'NAME_COLOR' as const, name: 'Azul Elétrico', assetUrl: '#00B0FF', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 37 },
  { id: 'sky_blue', type: 'NAME_COLOR' as const, name: 'Azul Celeste', assetUrl: '#4FC3F7', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 38 },
  { id: 'ice_blue', type: 'NAME_COLOR' as const, name: 'Azul Gelo', assetUrl: '#B3E5FC', rarity: 'COMMON' as const, price: 0, category: 'blues', sortOrder: 39 },
  { id: 'dark_purple', type: 'NAME_COLOR' as const, name: 'Roxo Escuro', assetUrl: '#4A148C', rarity: 'COMMON' as const, price: 0, category: 'purples', sortOrder: 40 },
  { id: 'bright_purple', type: 'NAME_COLOR' as const, name: 'Roxo Vivo', assetUrl: '#AA00FF', rarity: 'COMMON' as const, price: 0, category: 'purples', sortOrder: 41 },
  { id: 'violet', type: 'NAME_COLOR' as const, name: 'Violeta', assetUrl: '#7C4DFF', rarity: 'COMMON' as const, price: 0, category: 'purples', sortOrder: 42 },
  { id: 'indigo', type: 'NAME_COLOR' as const, name: 'Índigo', assetUrl: '#3949AB', rarity: 'COMMON' as const, price: 0, category: 'purples', sortOrder: 43 },
  { id: 'amethyst', type: 'NAME_COLOR' as const, name: 'Ametista', assetUrl: '#9C64A6', rarity: 'COMMON' as const, price: 0, category: 'purples', sortOrder: 44 },
  { id: 'lavender', type: 'NAME_COLOR' as const, name: 'Lavanda', assetUrl: '#B39DDB', rarity: 'COMMON' as const, price: 0, category: 'purples', sortOrder: 45 },
  { id: 'dark_pink', type: 'NAME_COLOR' as const, name: 'Rosa Escuro', assetUrl: '#AD1457', rarity: 'COMMON' as const, price: 0, category: 'pinks', sortOrder: 46 },
  { id: 'bright_pink', type: 'NAME_COLOR' as const, name: 'Rosa Vivo', assetUrl: '#F50057', rarity: 'COMMON' as const, price: 0, category: 'pinks', sortOrder: 47 },
  { id: 'hot_pink', type: 'NAME_COLOR' as const, name: 'Rosa Choque', assetUrl: '#FF4081', rarity: 'COMMON' as const, price: 0, category: 'pinks', sortOrder: 48 },
  { id: 'baby_pink', type: 'NAME_COLOR' as const, name: 'Rosa Bebê', assetUrl: '#F8BBD0', rarity: 'COMMON' as const, price: 0, category: 'pinks', sortOrder: 49 },
  { id: 'magenta', type: 'NAME_COLOR' as const, name: 'Magenta', assetUrl: '#D500F9', rarity: 'COMMON' as const, price: 0, category: 'pinks', sortOrder: 50 },
  { id: 'fuchsia', type: 'NAME_COLOR' as const, name: 'Fúcsia', assetUrl: '#E040FB', rarity: 'COMMON' as const, price: 0, category: 'pinks', sortOrder: 51 },
  { id: 'turquoise', type: 'NAME_COLOR' as const, name: 'Turquesa', assetUrl: '#1DE9B6', rarity: 'COMMON' as const, price: 0, category: 'cyans', sortOrder: 52 },
  { id: 'aqua', type: 'NAME_COLOR' as const, name: 'Azul Água', assetUrl: '#18FFFF', rarity: 'COMMON' as const, price: 0, category: 'cyans', sortOrder: 53 },
  { id: 'pool_blue', type: 'NAME_COLOR' as const, name: 'Azul Piscina', assetUrl: '#00B8D4', rarity: 'COMMON' as const, price: 0, category: 'cyans', sortOrder: 54 },
  { id: 'aqua_green', type: 'NAME_COLOR' as const, name: 'Verde-Água', assetUrl: '#64FFDA', rarity: 'COMMON' as const, price: 0, category: 'cyans', sortOrder: 55 },
  { id: 'dark_gray', type: 'NAME_COLOR' as const, name: 'Cinza Escuro', assetUrl: '#424242', rarity: 'COMMON' as const, price: 0, category: 'grays', sortOrder: 56 },
  { id: 'light_gray', type: 'NAME_COLOR' as const, name: 'Cinza Claro', assetUrl: '#BDBDBD', rarity: 'COMMON' as const, price: 0, category: 'grays', sortOrder: 57 },
  { id: 'silver', type: 'NAME_COLOR' as const, name: 'Prata', assetUrl: '#E0E0E0', rarity: 'COMMON' as const, price: 0, category: 'grays', sortOrder: 58 },
  { id: 'dark_brown', type: 'NAME_COLOR' as const, name: 'Marrom Escuro', assetUrl: '#3E2723', rarity: 'COMMON' as const, price: 0, category: 'browns', sortOrder: 59 },
  { id: 'caramel', type: 'NAME_COLOR' as const, name: 'Caramelo', assetUrl: '#B87333', rarity: 'COMMON' as const, price: 0, category: 'browns', sortOrder: 60 },
  { id: 'chocolate', type: 'NAME_COLOR' as const, name: 'Chocolate', assetUrl: '#5D4037', rarity: 'COMMON' as const, price: 0, category: 'browns', sortOrder: 61 },
  { id: 'matrix_blue', type: 'NAME_COLOR' as const, name: 'Azul Matrix', assetUrl: '#0066FF', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 62 },
  { id: 'neon_blue', type: 'NAME_COLOR' as const, name: 'Azul Neon', assetUrl: '#00E5FF', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 63 },
  { id: 'electric_blue_special', type: 'NAME_COLOR' as const, name: 'Azul Elétrico Especial', assetUrl: '#2979FF', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 64 },
  { id: 'neon_purple', type: 'NAME_COLOR' as const, name: 'Roxo Neon', assetUrl: '#B388FF', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 65 },
  { id: 'neon_pink', type: 'NAME_COLOR' as const, name: 'Rosa Neon', assetUrl: '#FF80AB', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 66 },
  { id: 'neon_green', type: 'NAME_COLOR' as const, name: 'Verde Neon', assetUrl: '#76FF03', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 67 },
  { id: 'neon_yellow', type: 'NAME_COLOR' as const, name: 'Amarelo Neon', assetUrl: '#FFFF00', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 68 },
  { id: 'neon_orange', type: 'NAME_COLOR' as const, name: 'Laranja Neon', assetUrl: '#FF9100', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 69 },
  { id: 'neon_red', type: 'NAME_COLOR' as const, name: 'Vermelho Neon', assetUrl: '#FF5252', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 70 },
  { id: 'neon_cyan', type: 'NAME_COLOR' as const, name: 'Ciano Neon', assetUrl: '#84FFFF', rarity: 'COMMON' as const, price: 0, category: 'special', sortOrder: 71 },
];

const GAMES = [
  { slug: 'quiz', name: 'MATRIX Quiz', description: 'Teste seu conhecimento.' },
  { slug: 'detective', name: 'Detetive', description: 'Resolva o mistério.' },
  { slug: 'enigmas', name: 'Enigmas', description: 'Decifre os enigmas.' },
];

// The cosmetic catalog is server-owned configuration, not user data: it is
// upserted on EVERY boot so palette updates reach existing databases without
// migrations or manual steps.
async function syncCatalog() {
  await prisma.$transaction(ITEMS.map((i) => prisma.item.upsert({
    where: { id: i.id },
    update: i,
    create: i,
  })));
  await prisma.$transaction(FRAMES.map((f) => prisma.item.upsert({
    where: { id: f.id },
    update: { ...f, type: 'AVATAR_FRAME', price: 0 },
    create: { ...f, type: 'AVATAR_FRAME', price: 0 },
  })));
  await prisma.$transaction(NAME_COLORS.map((c) => prisma.item.upsert({
    where: { id: c.id },
    update: c,
    create: c,
  })));
  // Nickname effects were REMOVED from the product: retire the legacy
  // NAME_EFFECT catalog rows (deactivate, never delete catalog history) and
  // unequip the slot everywhere so no user keeps an effect the app can no
  // longer render. User accounts and their other cosmetics are untouched.
  await prisma.equippedItem.deleteMany({ where: { slot: 'NAME_EFFECT' } });
  await prisma.item.updateMany({
    where: { type: 'NAME_EFFECT' },
    data: { active: false },
  });
  console.log(`🎨 Catalog synced: ${ITEMS.length} items + ${NAME_COLORS.length} name colors.`);
}

async function main() {
  console.log('🌱 Seeding MATRIX database…');

  // Guard: never wipe a database that already has real users. This makes the
  // seed safe to run automatically on every start without destroying data.
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    await syncCatalog();
    console.log(`ℹ️  Database already has ${existingUsers} user(s). Skipping demo seed to preserve data.`);
    return;
  }

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

  await syncCatalog();

  await prisma.$transaction(LEVELS.map((l) => prisma.level.upsert({
    where: { id: l.id },
    update: l,
    create: l,
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
        nickname: 'leonardo',
        nicknameKey: 'leonardo',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        role: 'OWNER',
        bio: 'Fundador do MATRIX 💤 — construindo o futuro cronológico.',
        avatarUrl: 'https://i.pravatar.cc/300?img=12',
      },
    }),
    prisma.user.create({
      data: {
        nickname: 'maria',
        nicknameKey: 'maria',
        passwordHash: password,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        bio: 'Designer | Futurista | 💜 cyberpunk',
        avatarUrl: 'https://i.pravatar.cc/300?img=45',
      },
    }),
    prisma.user.create({
      data: {
        nickname: 'joao',
        nicknameKey: 'joao',
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
