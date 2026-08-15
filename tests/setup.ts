import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { config } from 'dotenv';
import { prisma } from '../src/config/prisma.js';

// Load .env.test before anything reads process.env.
config({ path: '.env.test' });

// ── Env ──────────────────────────────────────────────────────
// Tests use a throwaway SQLite database file (data/test.db) so they never
// touch the real data/matrix.db used in development/production. We use an
// ABSOLUTE path so the Prisma client (src/generated, run by vitest) and the
// CLI (migrate deploy) open the exact same file regardless of how each
// resolves relative `file:` paths. The file is wiped before each run.
const TEST_DB_URL =
  process.env.DATABASE_URL ?? `file:${process.cwd()}/data/test.db`;
process.env.DATABASE_URL = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-very-long-random-string-0123456789';
process.env.JWT_ACCESS_EXPIRES_IN ??= '15m';
process.env.JWT_REFRESH_EXPIRES_IN ??= '7d';
process.env.CORS_ORIGIN ??= '*';
process.env.STORAGE_DRIVER ??= 'local';
process.env.STORAGE_PUBLIC_BASE_URL ??= 'http://localhost:3000';
process.env.MAX_UPLOAD_BYTES ??= '5242880';

// ── Schema bootstrap ─────────────────────────────────────────
// Apply the SQLite migration baseline to the test DB so the schema exists.
// `migrate deploy` is non-destructive and idempotent; on a fresh file it
// creates all tables, on an already-migrated file it is a no-op.
beforeAll(async () => {
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
  } catch {
    // Fallback: push the schema directly if no migration history exists.
    execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env: process.env });
  }
  await prisma.$connect();
});

// ── Isolation: delete all rows between tests ─────────────────
// SQLite has no TRUNCATE; we DELETE in dependency-safe (child-first) order.
// PRAGMA foreign_keys is ON (Prisma enables it), so order matters.
const TABLES = [
  'game_results',
  'game_sessions',
  'games',
  'music_votes',
  'playlist_tracks',
  'playlists',
  'tracks',
  'event_rewards',
  'event_participants',
  'events',
  'equipped_items',
  'user_items',
  'items',
  'user_badges',
  'badges',
  'user_achievements',
  'achievements',
  'coin_transactions',
  'matrix_coins',
  'xp_transactions',
  'levels',
  'call_participants',
  'call_rooms',
  'app_config',
  'comments',
  'likes',
  'posts',
  'sessions',
  'users',
];

afterEach(async () => {
  // Disable FK checks during the bulk wipe so order is irrelevant, then
  // re-enable. This is safe inside a transaction.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF'),
    ...TABLES.map((t) => prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)),
    prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON'),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Silence pino logs during tests.
vi.spyOn(console, 'log').mockImplementation(() => {});
