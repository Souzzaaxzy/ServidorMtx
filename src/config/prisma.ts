// This is the single shared PrismaClient instance for the whole API.
// Lazily created and cached on the global to avoid creating multiple
// instances during hot-reload in development.
//
// The client uses the `node:sqlite` driver adapter (see ../db/node-sqlite-adapter)
// instead of Prisma's Rust query engine, so the API runs on hosts where that
// engine cannot load — notably Termux/Android (bionic). `engineType = "client"`
// in schema.prisma makes the client Rust-free; the adapter supplies the
// connection. Linux/Docker use the same path, so behavior is identical
// everywhere and no native binary is required on any platform.

import { PrismaClient } from '../generated/index.js';
import { MatrixNodeSQLiteAdapterFactory } from '../db/node-sqlite-adapter.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// NOTE: this module deliberately does NOT import src/config/env.ts. Doing so
// would evaluate that module (and snapshot process.env) as a side effect of
// importing the Prisma client — earlier than before, which changes behavior
// for callers that set env vars after import (e.g. tests/setup.ts). The two
// values needed here are read from process.env directly, with the same
// defaults as env.ts.
function databaseUrl(): string {
  return process.env.DATABASE_URL || `file:${process.cwd()}/data/matrix.db`;
}

function createClient(): PrismaClient {
  const adapter = new MatrixNodeSQLiteAdapterFactory(
    // Resolved at CONNECT time so a DATABASE_URL set after import is honored.
    { url: databaseUrl },
    // Prisma's native SQLite driver stored DateTime as epoch-milliseconds;
    // keeping that format makes existing data/matrix.db files readable.
    { timestampFormat: 'unixepoch-ms' },
  );
  return new PrismaClient({ adapter, log: ['error', 'warn'] });
}

/**
 * Builds an independent PrismaClient wired to the same `node:sqlite` adapter.
 * Used by the seed scripts, which must NOT share the API's client instance
 * (they run as separate processes / before the server boots).
 *
 * `quiet` mirrors the original `new PrismaClient()` used by the seeds (no
 * error logging), so operations the seed intentionally swallows with
 * `.catch()` stay silent exactly as before.
 */
export function createPrismaClient(options?: { quiet?: boolean }): PrismaClient {
  const adapter = new MatrixNodeSQLiteAdapterFactory(
    { url: databaseUrl },
    { timestampFormat: 'unixepoch-ms' },
  );
  return new PrismaClient({
    adapter,
    log: options?.quiet ? [] : ['error', 'warn'],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
