import pino from 'pino';

// In tests, use a plain silent logger to avoid worker-thread transport
// overhead and to keep output clean. In development, pretty-print to stdout.
const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

export const logger = pino(
  isTest
    ? { level: 'silent' }
    : {
        level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
        transport: isProd
          ? undefined
          : {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.password',
            '*.passwordHash',
            '*.token',
            '*.refreshToken',
            '*.secret',
          ],
          censor: '[REDACTED]',
        },
      },
);

export type Logger = typeof logger;
