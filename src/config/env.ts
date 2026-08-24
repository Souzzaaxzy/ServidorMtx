import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// Port resolution: PORT (absolute priority, injected by the panel or set
// manually) → SERVER_PORT (Pterodactyl's standard allocation variable) →
// 3000 as a LAST RESORT for local development only. The port is NEVER
// hardcoded and never needs to be typed by the user in production.
const portFallback = process.env.PORT ?? process.env.SERVER_PORT ?? '3000';

// JWT_SECRET is the only truly required variable (it signs auth tokens).
// In production there is NO fallback: a missing secret must fail fast with
// a clear message. A fixed or auto-generated secret is never used — a fixed
// one would be insecure and a generated one would invalidate tokens on
// every restart. Dev/test keep a convenience fallback so `npm run dev` and
// `npm test` work out of the box.
function jwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (value && value !== '') return value;
  if (isProd) {
    throw new Error(
      'JWT_SECRET não configurado. Configure esta variável no painel da Pterodactyl/Bronxys.',
    );
  }
  return 'dev-insecure-secret-change-me';
}

export const env = {
  isProd,
  isDev: !isProd,
  isTest,
  port: int('PORT', Number.parseInt(portFallback, 10) || 3000),
  corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()),
  // SQLite file (created at <project root>/data/matrix.db by start.sh).
  // DATABASE_URL is optional in production; this default points at an
  // ABSOLUTE path so the Prisma client (dev or compiled dist) and the CLI
  // all open the same file regardless of how they resolve relative paths.
  databaseUrl: required('DATABASE_URL', `file:${process.cwd()}/data/matrix.db`),
  jwt: {
    secret: jwtSecret(),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
  },
  storage: {
    endpoint: process.env.STORAGE_ENDPOINT ?? '',
    accessKey: process.env.STORAGE_ACCESS_KEY ?? '',
    secretKey: process.env.STORAGE_SECRET_KEY ?? '',
    bucket: process.env.STORAGE_BUCKET ?? 'matrix-uploads',
    region: process.env.STORAGE_REGION ?? 'auto',
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL ?? '',
    useLocal: !(process.env.STORAGE_ENDPOINT ?? ''),
  },
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 5 * 1024 * 1024),
} as const;
