// This is the single shared PrismaClient instance for the whole API.
// Lazily created and cached on the global to avoid creating multiple
// instances during hot-reload in development.

import { PrismaClient } from '../generated/index.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
