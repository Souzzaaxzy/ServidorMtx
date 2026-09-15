import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';
import {
  parseStickerlyCode,
  readImageSize,
  STICKERLY_MAX_STICKERS,
} from '../src/modules/stickers/stickerly.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal but valid PNG with a given size (distinct bytes per size). */
function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
  const ihdr = Buffer.from('IHDR', 'latin1');
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  const rest = Buffer.alloc(5);
  return Buffer.concat([sig, ihdrLen, ihdr, size, rest]);
}

/**
 * Stub global fetch to emulate the Sticker.ly service: pack JSON at any
 * `/v3.1/stickerPack/<CODE>` URL, and real PNG bytes for `resourceUrlPrefix`
 * files. Only the external source is faked — the import path (download →
 * magic-byte validation → storage → DB → dedupe) runs for real.
 */
function stubStickerly(prefix: string, files: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v3.1/stickerPack/')) {
        if (url.endsWith('/ZZZZZZ')) {
          return new Response(JSON.stringify({ error: { errorCode: '20001' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            result: {
              name: 'Pacote Teste',
              authorName: 'Autora Teste',
              packId: 'TESTPACK',
              shareUrl: 'https://sticker.ly/s/TESTPACK',
              resourceUrlPrefix: prefix,
              animated: false,
              stickers: files.map((fileName) => ({ fileName })),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith(prefix)) {
        // Cada arquivo tem bytes DISTINTOS (tamanho diferente) para que a
        // dedupe por hash não os una — igual ao conteúdo real da fonte.
        const name = url.slice(prefix.length);
        const n = files.indexOf(name);
        const bytes = png(1 + n, 1 + n);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.length),
          },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

describe('parseStickerlyCode', () => {
  it('accepts a plain code and normalizes case', () => {
    expect(parseStickerlyCode('qslxy')).toBe('QSLXY');
    expect(parseStickerlyCode('  QSXLKY  ')).toBe('QSXLKY');
  });

  it('extracts the code from a share link', () => {
    expect(parseStickerlyCode('https://sticker.ly/s/QSXLKY')).toBe('QSXLKY');
    expect(parseStickerlyCode('https://sticker.ly/s/QSXLKY?x=1')).toBe('QSXLKY');
  });

  it('rejects malformed input', () => {
    expect(() => parseStickerlyCode('')).toThrow();
    expect(() => parseStickerlyCode('ab')).toThrow();
    expect(() => parseStickerlyCode('has space')).toThrow();
    expect(() => parseStickerlyCode(42)).toThrow();
  });
});

describe('readImageSize', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(readImageSize(png(1, 1), 'png')).toEqual({ width: 1, height: 1 });
  });

  it('returns null for unknown formats/headers', () => {
    expect(readImageSize(Buffer.alloc(4), 'png')).toBeNull();
    expect(readImageSize(png(1, 1), 'jpeg')).toBeNull();
  });

  it('reads the VP8 lossless WEBP header', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0, 'latin1');
    buf.write('WEBP', 8, 'latin1');
    buf.write('VP8L', 12, 'latin1');
    buf.writeUInt32LE(0, 16);
    buf[20] = 0x2f;
    expect(readImageSize(buf, 'webp')).toEqual({ width: 1, height: 1 });
  });
});

describe('Sticker.ly endpoints', () => {
  it('rejects an invalid code before any outbound request', async () => {
    const user = await createAndLoginUser(server, { nickname: 'ly_badcode' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/preview',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: '!!' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid import payload', async () => {
    const user = await createAndLoginUser(server, { nickname: 'ly_badimp' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/preview',
      payload: { code: 'QSXLKY' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('maps a missing source pack to a friendly 404', async () => {
    stubStickerly('https://stickerly.pstatic.net/sticker_pack/x/ZZZZZZ/1/', []);
    const user = await createAndLoginUser(server, { nickname: 'ly_missing' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/preview',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: 'ZZZZZZ' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error.message.toLowerCase()).toContain(
      'encontrar esse pacote',
    );
  });

  it('previews a pack without importing anything', async () => {
    const prefix = 'https://stickerly.pstatic.net/sticker_pack/aaa/TESTPACK/1/';
    stubStickerly(prefix, ['a.png', 'b.png']);
    const user = await createAndLoginUser(server, { nickname: 'ly_preview' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/preview',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: 'TESTPACK' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.name).toBe('Pacote Teste');
    expect(body.author).toBe('Autora Teste');
    expect(body.stickerCount).toBe(2);
    expect(body.alreadyInstalled).toBe(false);
    // Nada foi criado no banco pela prévia.
    const count = await prisma.stickerPackage.count({
      where: { source: 'stickerly' },
    });
    expect(count).toBe(0);
  });

  it('imports a pack: downloads, validates bytes, stores and installs', async () => {
    const prefix = 'https://stickerly.pstatic.net/sticker_pack/bbb/IMPACK/1/';
    stubStickerly(prefix, ['a.png', 'b.png']);
    const user = await createAndLoginUser(server, { nickname: 'ly_import' });

    const res = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: 'IMPACK' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.created).toBe(2);
    expect(body.package).not.toBeNull();
    expect(body.package.installed).toBe(true);
    expect(body.package.stickerCount).toBe(2);
    // URLs finais são do armazenamento do MATRIX, não da fonte externa.
    expect(body.package.stickers[0].fileUrl).toContain('/static/');
    expect(body.package.stickers[0].fileUrl).not.toContain('pstatic.net');

    // O catálogo passa a listar o pacote para o dono.
    const catalog = await server.inject({
      method: 'GET',
      url: '/api/stickers/packages',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const packages = JSON.parse(catalog.payload).packages as Array<{
      id: string;
      installed: boolean;
    }>;
    expect(packages.some((p) => p.id === body.package.id && p.installed)).toBe(
      true,
    );
  });

  it('reimporting the same code does not duplicate the package', async () => {
    const prefix = 'https://stickerly.pstatic.net/sticker_pack/ccc/DUPACK/1/';
    stubStickerly(prefix, ['a.png', 'b.png']);
    const user = await createAndLoginUser(server, { nickname: 'ly_dup' });

    const first = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: 'DUPACK' },
    });
    expect(JSON.parse(first.payload).created).toBe(2);

    const second = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/import',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { code: 'DUPACK' },
    });
    expect(second.statusCode).toBe(200);
    const body = JSON.parse(second.payload);
    expect(body.alreadyInstalled).toBe(true);
    expect(body.created).toBe(0);

    const count = await prisma.stickerPackage.count({
      where: { source: 'stickerly', sourceId: 'DUPACK' },
    });
    expect(count).toBe(1);
  });

  it('keeps user-imported packages private to their owner', async () => {
    const prefix = 'https://stickerly.pstatic.net/sticker_pack/ddd/PRIVPACK/1/';
    stubStickerly(prefix, ['a.png']);
    const owner = await createAndLoginUser(server, { nickname: 'ly_owner' });
    const other = await createAndLoginUser(server, { nickname: 'ly_other' });

    const imp = await server.inject({
      method: 'POST',
      url: '/api/stickers/stickerly/import',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { code: 'PRIVPACK' },
    });
    const pkgId = JSON.parse(imp.payload).package.id as string;

    const mine = await server.inject({
      method: 'GET',
      url: '/api/stickers/packages',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const theirs = await server.inject({
      method: 'GET',
      url: '/api/stickers/packages',
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    const myIds = (JSON.parse(mine.payload).packages as Array<{ id: string }>).map((p) => p.id);
    const theirIds = (JSON.parse(theirs.payload).packages as Array<{ id: string }>).map((p) => p.id);
    expect(myIds).toContain(pkgId);
    expect(theirIds).not.toContain(pkgId);
  });

  it('caps the number of stickers per pack (constant sanity)', () => {
    expect(STICKERLY_MAX_STICKERS).toBeGreaterThan(0);
    expect(STICKERLY_MAX_STICKERS).toBeLessThanOrEqual(100);
  });
});
