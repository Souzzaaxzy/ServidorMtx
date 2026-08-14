import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { ApiError, toApiError } from './utils/errors.js';
import { authenticate, optionalAuth, requireRole } from './middleware/authenticate.js';

import { authRoutes } from './modules/auth/auth.routes.js';
import { postRoutes } from './modules/posts/post.routes.js';
import { likeRoutes } from './modules/likes/like.routes.js';
import { commentRoutes } from './modules/comments/comment.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { searchRoutes } from './modules/search/search.routes.js';
import { uploadRoutes } from './modules/uploads/upload.routes.js';
import { gamificationRoutes } from './modules/gamification/gamification.routes.js';
import { customizationRoutes } from './modules/customization/customization.routes.js';
import { musicRoutes } from './modules/music/music.routes.js';
import { gameRoutes } from './modules/games/game.routes.js';
import { callRoutes } from './modules/calls/call.routes.js';
import { akameRoutes } from './modules/akame/akame.routes.js';
import { configRoutes } from './modules/config/config.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger as never,
    bodyLimit: env.maxUploadBytes + 1024,
  });

  app.decorate('authenticate', authenticate);
  app.decorate('optionalAuth', optionalAuth);
  app.decorate('requireRole', requireRole);

  // ── Security & infra plugins ───────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: env.isProd
      ? undefined
      : {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'http:', 'https:'],
          },
        },
  });

  await app.register(cors, {
    origin: env.corsOrigin.includes('*') ? true : env.corsOrigin,
    credentials: true,
  });

  await app.register(rateLimit, {
    global: !env.isTest,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ApiError.rateLimited(),
  });

  await app.register(multipart, {
    limits: { fileSize: env.maxUploadBytes },
  });

  // Serve locally stored uploads (dev). Harmless in prod if S3 is used.
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'uploads'),
    prefix: '/static/',
    decorateReply: false,
  });

  // ── OpenAPI / Swagger ───────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'MATRIX API',
        description: 'MATRIX 💤 — backend da rede social cronológica.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });

  // ── Global error handler ────────────────────────────────────
  app.setErrorHandler((err, _request, reply) => {
    const apiErr = toApiError(err);
    if (apiErr.statusCode >= 500) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
        'unhandled error',
      );
    }
    return reply.status(apiErr.statusCode).send({
      error: { code: apiErr.code, message: apiErr.message, ...(apiErr.details ? { details: apiErr.details } : {}) },
    });
  });
  // ── Routes ──────────────────────────────────────────────────
  // IMPORTANT: register /users/search BEFORE /users/:username so the
  // static "search" path isn't captured as a username param.
  //
  // All app-facing routes are mounted under /api so the server can later
  // host the staff admin web panel on a separate prefix without collision.
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(gamificationRoutes, { prefix: '/api' });
  await app.register(customizationRoutes, { prefix: '/api' });
  await app.register(musicRoutes, { prefix: '/api' });
  await app.register(gameRoutes, { prefix: '/api' });
  await app.register(callRoutes, { prefix: '/api' });
  await app.register(akameRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(postRoutes, { prefix: '/api' });
  await app.register(likeRoutes, { prefix: '/api' });
  await app.register(commentRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(uploadRoutes, { prefix: '/api' });

  // Health check (unauthenticated, unrate-limited-friendly).
  app.get('/health', async (_request, reply) => reply.status(200).send({ status: 'ok' }));

  return app;
}

// Boot when run directly (not when imported by tests).
import { fileURLToPath } from 'node:url';

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'server failed to start',
    );
    process.exit(1);
  }
}

const isMain =
  process.env.NODE_ENV !== 'test' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMain) {
  void start();
}
