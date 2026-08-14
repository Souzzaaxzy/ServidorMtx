import { prisma } from '../../config/prisma.js';

// ── Dynamic configuration ─────────────────────────────────────
// The app reads this at startup to toggle features, announce maintenance,
// or push personalizations without an APK update. Public keys are safe to
// expose to all clients; private keys are staff-only.

const DEFAULT_PUBLIC_CONFIG = {
  minAppVersion: '1.0.0',
  maintenance: false,
  activeEvents: [],
  features: {
    feed: true,
    community: true,
    games: true,
    music: true,
    calls: true,
    akame: true,
  },
};

export async function getPublicConfig(): Promise<Record<string, unknown>> {
  const rows = await prisma.appConfig.findMany({ where: { public: true } });
  const config: Record<string, unknown> = { ...DEFAULT_PUBLIC_CONFIG };
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

export async function getAllConfig() {
  return prisma.appConfig.findMany({ orderBy: { key: 'asc' } });
}

export async function setConfig(key: string, value: unknown, isPublic: boolean) {
  return prisma.appConfig.upsert({
    where: { key },
    update: { value: value as never, public: isPublic },
    create: { key, value: value as never, public: isPublic },
  });
}
