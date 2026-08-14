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

export const env = {
  isProd,
  isDev: !isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: int('PORT', 3000),
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
