import { prisma } from '../../config/prisma.js';

// Safely parse a stored JSON string. Falls back to the raw string when the
// stored value is not valid JSON (e.g. legacy/manual entries).
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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
    config[row.key] = parseValue(row.value);
  }
  return config;
}

export async function getAllConfig() {
  const rows = await prisma.appConfig.findMany({ orderBy: { key: 'asc' } });
  // value is stored as a JSON string (SQLite has no Json type); parse it back
  // so the API contract stays an object, not a string.
  return rows.map((row) => ({ ...row, value: parseValue(row.value) }));
}

export async function setConfig(key: string, value: unknown, isPublic: boolean) {
  const serialized = JSON.stringify(value ?? null);
  const row = await prisma.appConfig.upsert({
    where: { key },
    update: { value: serialized, public: isPublic },
    create: { key, value: serialized, public: isPublic },
  });
  return { ...row, value: parseValue(row.value) };
}
