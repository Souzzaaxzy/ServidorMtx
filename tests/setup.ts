import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { config } from 'dotenv';
import { prisma } from '../src/config/prisma.js';

// Load .env.test before anything reads process.env.
config({ path: '.env.test' });

// ── Env ──────────────────────────────────────────────────────
// Tests target a real PostgreSQL instance. A dedicated test database
// is created/reset before the run so we never touch dev data.
const TEST_DB = process.env.TEST_DATABASE_URL;
const usingTestDb = Boolean(TEST_DB);

if (!usingTestDb) {
  // Fall back to the dev DATABASE_URL so `npm test` works locally without
  // extra config; tests still truncate tables between cases.
  process.env.DATABASE_URL ??= 'postgresql://matrix:matrix@localhost:5432/matrix?schema=public';
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-very-long-random-string-0123456789';
process.env.JWT_ACCESS_EXPIRES_IN ??= '15m';
process.env.JWT_REFRESH_EXPIRES_IN ??= '7d';
process.env.CORS_ORIGIN ??= '*';
process.env.STORAGE_DRIVER ??= 'local';
process.env.STORAGE_PUBLIC_BASE_URL ??= 'http://localhost:3000';
process.env.MAX_UPLOAD_BYTES ??= '5242880';

// ── Schema bootstrap ─────────────────────────────────────────
// Ensure the test database schema exists. We use `prisma migrate deploy`
// so the schema is created deterministically without prompting.
beforeAll(async () => {
  if (usingTestDb) {
    try {
      execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
    } catch {
      // If migrations haven't been generated, push the schema directly.
      execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env: process.env });
    }
  }
  await prisma.$connect();
});

// ── Isolation: truncate all tables between tests ─────────────
afterEach(async () => {
  // Cascade truncates all rows in dependency-safe order.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE ' +
      '"game_results", "game_sessions", "games", ' +
      '"music_votes", "playlist_tracks", "playlists", "tracks", ' +
      '"event_rewards", "event_participants", "events", ' +
      '"equipped_items", "user_items", "items", ' +
      '"user_badges", "badges", "user_achievements", "achievements", ' +
      '"coin_transactions", "matrix_coins", "xp_transactions", "levels", ' +
      '"call_participants", "call_rooms", ' +
      '"app_config", ' +
      '"comments", "likes", "posts", "sessions", "users" ' +
      'RESTART IDENTITY CASCADE;',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Silence pino logs during tests.
vi.spyOn(console, 'log').mockImplementation(() => {});
