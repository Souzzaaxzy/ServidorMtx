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
import { prisma } from './config/prisma.js';
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
import { friendRoutes } from './modules/friends/friend.routes.js';
import { chatRoutes } from './modules/chat/chat.routes.js';
import { groupRoutes } from './modules/groups/group.routes.js';
import { notificationRoutes } from './modules/notifications/notification.routes.js';
import { pushRoutes } from './modules/push/push.routes.js';
import { stickerRoutes } from './modules/stickers/sticker.routes.js';
import { storyRoutes } from './modules/stories/story.routes.js';
import { profileMusicRoutes } from './modules/music/profile-music.routes.js';
import { purgeDeliveredMessages } from './modules/chat/retention.service.js';
import websocket from '@fastify/websocket';

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
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          // `details` carrega o diagnóstico (ex.: a saída real do yt-dlp).
          // Sem isto, um 500 só dizia "erro interno" e não havia como
          // descobrir a causa no log do servidor.
          details: apiErr.details,
        },
        'unhandled error',
      );
    }
    return reply.status(apiErr.statusCode).send({
      error: { code: apiErr.code, message: apiErr.message, ...(apiErr.details ? { details: apiErr.details } : {}) },
    });
  });
  // ── Routes ──────────────────────────────────────────────────
  // IMPORTANT: register /users/search BEFORE /users/:nickname so the
  // static "search" path isn't captured as a nickname param.
  //
  // Realtime push channel (WebSocket) must be registered BEFORE any route
  // that uses { websocket: true }.
  await app.register(websocket);

  // All app-facing routes are mounted under /api so the server can later
  // host the staff admin web panel on a separate prefix without collision.
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(gamificationRoutes, { prefix: '/api' });
  await app.register(customizationRoutes, { prefix: '/api' });
  await app.register(musicRoutes, { prefix: '/api' });
  // Profile music (YouTube search + excerpt download). Registered AFTER
  // musicRoutes so `/music/profile/*` is matched by its own handler.
  await app.register(profileMusicRoutes, { prefix: '/api' });
  await app.register(gameRoutes, { prefix: '/api' });
  await app.register(callRoutes, { prefix: '/api' });
  await app.register(akameRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(postRoutes, { prefix: '/api' });
  await app.register(likeRoutes, { prefix: '/api' });
  await app.register(commentRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(friendRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(groupRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api' });
  await app.register(pushRoutes, { prefix: '/api' });
  await app.register(stickerRoutes, { prefix: '/api' });
  await app.register(storyRoutes, { prefix: '/api' });
  await app.register(uploadRoutes, { prefix: '/api' });

  // Health check (unauthenticated, unrate-limited-friendly). Reports the
  // database status without exposing any sensitive information: 200 when
  // the API and the SQLite database are reachable, 503 otherwise.
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.status(200).send({ status: 'ok', service: 'MATRIX API', database: 'ok' });
    } catch {
      return reply
        .status(503)
        .send({ status: 'error', service: 'MATRIX API', database: 'unavailable' });
    }
  });

  return app;
}

// Boot when run directly (not when imported by tests).
import { fileURLToPath } from 'node:url';

async function start() {
  // Startup banner — plain console lines (not pino JSON) so the Pterodactyl/
  // Bronxys console shows a readable summary. Secrets are NEVER printed.
  console.log('[MATRIX] Iniciando API...');
  console.log(`[MATRIX] Ambiente: ${process.env.NODE_ENV ?? 'production (padrão)'}`);
  console.log('[MATRIX] Banco: SQLite');
  console.log(`[MATRIX] Banco: ${env.databaseUrl.replace(/^file:/, '')}`);
  console.log(`[MATRIX] Porta obtida do ambiente: ${env.port}`);
  console.log('[MATRIX] Host: 0.0.0.0');

  // Verify the SQLite database is reachable before accepting traffic.
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('[MATRIX] SQLite conectado.');
  } catch (err) {
    console.error('[MATRIX] ERRO: não foi possível conectar ao banco SQLite.');
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'database connection failed',
    );
    process.exit(1);
  }

  const app = await buildServer();
  try {
    // Bind 0.0.0.0 so the server is reachable inside the Pterodactyl
    // container; the port comes from the environment (PORT / SERVER_PORT).
    await app.listen({ port: env.port, host: '0.0.0.0' });
    console.log('[MATRIX] API iniciada com sucesso.');
    await logPublicUrl();
    // Chat history lives on the phones; the server copy is a delivery queue.
    // This drains it so the database and the uploads folder stop growing.
    startMessageRetention();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'server failed to start',
    );
    process.exit(1);
  }
}

// Chat history now lives on each phone; the server keeps only a delivery
// queue. This sweeps that queue on an interval so the database and the
// uploads directory stop growing without bound. It is registered here (in the
// boot path) and NOT in buildServer(), so importing the app in tests never
// starts a background job.
function startMessageRetention(): void {
  const everyMs = Number(process.env.MESSAGE_PURGE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  const run = () => {
    void purgeDeliveredMessages()
      .then((r) => {
        if (r.delivered || r.undelivered || r.filesDeleted) {
          console.log(
            `[MATRIX] Retenção: ${r.delivered} entregues + ${r.undelivered} não entregues removidas, ${r.filesDeleted} arquivo(s) apagado(s).`,
          );
        }
      })
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'message retention sweep failed',
        );
      });
  };
  // A first sweep shortly after boot (catches up after downtime), then on an
  // interval. `unref()` keeps the timer from holding the process open.
  const first = setTimeout(run, 30_000);
  const interval = setInterval(run, everyMs);
  first.unref?.();
  interval.unref?.();
}

// Best-effort public IP detection. The process inside the container does
// NOT know the node's public address — on most Pterodactyl nodes the egress
// IP matches the allocation IP shown on the panel, but nodes behind NAT can
// differ. That's why the detected URL is always printed with a "confirm on
// the panel" note, and PUBLIC_API_URL (panel variable) always wins.
async function detectPublicIp(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://api.ipify.org', {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Prints the `URL:` line the user copies into the MatrixApp configuration.
// Priority: PUBLIC_API_URL (panel) → auto-detected egress IP:port → panel
// instructions. Never invents a hostname.
async function logPublicUrl(): Promise<void> {
  if (env.publicApiUrl) {
    console.log(`[MATRIX] URL: ${env.publicApiUrl}`);
    console.log('[MATRIX] ↑ Use esta URL no MatrixApp (API_BASE_URL).');
    console.log(`[MATRIX] Health check: ${env.publicApiUrl}/health`);
    return;
  }
  const ip = await detectPublicIp();
  if (ip) {
    console.log(`[MATRIX] URL: http://${ip}:${env.port}`);
    console.log(
      '[MATRIX] ↑ URL detectada automaticamente (IP público + porta alocada).' +
        ' Confirme no painel (página do servidor → alocação) que este é o' +
        ' mesmo IP:PORTA antes de usar no MatrixApp (API_BASE_URL).',
    );
    console.log(`[MATRIX] Health check: http://${ip}:${env.port}/health`);
  } else {
    console.log('[MATRIX] URL: não foi possível detectar o IP público.');
    console.log(
      '[MATRIX] Copie o endereço IP:PORTA da alocação na página do servidor' +
        ' no painel — a URL da API é http://IP:PORTA (ex.: http://123.45.67.89:4316).',
    );
  }
}

const isMain =
  process.env.NODE_ENV !== 'test' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMain) {
  void start();
}
