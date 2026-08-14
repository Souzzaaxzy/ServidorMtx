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

// Pterodactyl exposes the allocated port as SERVER_PORT; prefer PORT when set
// (our own convention) but fall back to SERVER_PORT so the panel works out of
// the box without extra config.
const portFallback = process.env.PORT ?? process.env.SERVER_PORT ?? '3000';

export const env = {
  isProd,
  isDev: !isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: int('PORT', Number.parseInt(portFallback, 10) || 3000),
  corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()),
  databaseUrl: required('DATABASE_URL', 'postgresql://matrix:matrix@localhost:5432/matrix?schema=public'),
  jwt: {
    secret: required('JWT_SECRET', 'dev-insecure-secret-change-me'),
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
