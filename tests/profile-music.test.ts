import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { prisma } from '../src/config/prisma.js';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import {
  cleanMusicTitle,
  splitMusicTitle,
  toSearchResult,
  MAX_PROFILE_MUSIC_MS,
} from '../src/modules/music/profile-music.ytdlp.js';

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

// ── Title cleaning (the "só música, sem vídeo" requirement) ───
// These run the REAL implementation — no mocks. They encode exactly what the
// user asked for: "(Official Video)", "[HD]", "Lyrics" etc. must disappear
// and the result must read as "song + artist".
describe('music title cleaning', () => {
  it('strips "(Official Video)" and similar noise', () => {
    expect(cleanMusicTitle('Queen – Bohemian Rhapsody (Official Video Remastered)')).toBe(
      'Queen – Bohemian Rhapsody',
    );
    expect(cleanMusicTitle('Song Title [Official Music Video]')).toBe('Song Title');
    expect(cleanMusicTitle('Another One (Lyrics)')).toBe('Another One');
    expect(cleanMusicTitle('Track Name (Audio)')).toBe('Track Name');
    expect(cleanMusicTitle('Clip Name (Official Audio) [HD]')).toBe('Clip Name');
  });

  it('never returns an empty title when the whole title was noise', () => {
    // Degenerate input: cleaning would erase everything, so the original
    // comes back — a bad title beats no title.
    expect(cleanMusicTitle('(Official Video)')).toBe('(Official Video)');
    expect(cleanMusicTitle('   ')).toBe('');
  });

  it('splits the YouTube Music "Artist – Song" order (uploader disambiguates)', () => {
    // Real shape from YouTube Music: the ARTIST comes first.
    expect(splitMusicTitle('Bohemian Rhapsody – Queen', 'Queen Official')).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
    });
    // En-dash and em-dash variants (YouTube uses them freely).
    expect(splitMusicTitle('Song – Artist', 'Artist')).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
    expect(splitMusicTitle('Song — Artist', 'Artist')).toEqual({
      title: 'Song',
      artist: 'Artist',
    });
  });

  it('splits the plain YouTube "Song - Artist" order when the uploader matches the tail', () => {
    expect(splitMusicTitle('Bohemian Rhapsody - Queen Official', 'Queen Official')).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen Official',
    });
  });

  it('prefers the YouTube Music order when the uploader gives no hint', () => {
    expect(splitMusicTitle('Song - Artist', 'SomeUnrelatedChannel')).toEqual({
      title: 'Artist',
      artist: 'Song',
    });
  });

  it('falls back to the uploader when the title has no artist part', () => {
    expect(splitMusicTitle('Bohemian Rhapsody', 'Queen Official')).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen Official',
    });
    // No uploader either → empty artist, never an invented one.
    expect(splitMusicTitle('Bohemian Rhapsody', null)).toEqual({
      title: 'Bohemian Rhapsody',
      artist: '',
    });
  });

  it('builds a search result from a real yt-dlp item shape', () => {
    // Shape observed from `yt-dlp --dump-json` on YouTube Music: artist/track
    // come back null, so the title + uploader are the only sources.
    const result = toSearchResult({
      id: 'fJ9rUzIMcZQ',
      title: 'Queen – Bohemian Rhapsody (Official Video Remastered)',
      artist: null,
      uploader: 'Queen Official',
      duration: 359,
      thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg',
    });
    expect(result).not.toBeNull();
    expect(result!.sourceId).toBe('fJ9rUzIMcZQ');
    // "Queen – Bohemian Rhapsody" → artist first (YouTube Music order), and
    // the uploader ("Queen Official") confirms "Queen" is the artist.
    expect(result!.title).toBe('Bohemian Rhapsody');
    expect(result!.artist).toBe('Queen');
    expect(result!.durationMs).toBe(359000);
  });

  it('rejects items without id or title', () => {
    expect(toSearchResult({ title: 'No id' })).toBeNull();
    expect(toSearchResult({ id: 'abc' })).toBeNull();
    expect(toSearchResult({})).toBeNull();
  });
});

// ── HTTP: search ──────────────────────────────────────────────
// The external binary is exercised for real when available; the important
// contract here is auth, validation and "never crash the server".
describe('GET /api/music/profile/search', () => {
  it('requires authentication', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/music/profile/search?q=queen',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty query', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_empty' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/music/profile/search?q=',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an absurdly long query', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_long' });
    const res = await server.inject({
      method: 'GET',
      url: `/api/music/profile/search?q=${'a'.repeat(200)}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns an empty list (never a crash) when the source finds nothing', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_none' });
    // A query with no matches must be an empty list, never an unhandled 500.
    const res = await server.inject({
      method: 'GET',
      url: '/api/music/profile/search?q=zzqqxxwwvvbbnnaassdd',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.payload).results)).toBe(true);
  });
});

// ── HTTP: set / get / clear ───────────────────────────────────
describe('profile music set/get/clear', () => {
  it('starts with no music (explicit null)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_none_yet' });
    const res = await server.inject({
      method: 'GET',
      url: '/api/users/music_none_yet',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.music).toBeNull();
  });

  it('rejects a set without a sourceId', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_nosrc' });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { title: 'X', durationMs: 30000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a set without a title', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_notitle' });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { sourceId: 'abcdef12345', durationMs: 30000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a set without a duration', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_nodur' });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { sourceId: 'abcdef12345', title: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an excerpt longer than 1 minute BEFORE downloading', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_toolong' });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        sourceId: 'abcdef12345',
        title: 'X',
        artist: 'Y',
        durationMs: MAX_PROFILE_MUSIC_MS + 1,
      },
    });
    expect(res.statusCode).toBe(400);
    // Nothing was persisted.
    const row = await prisma.profileMusic.findUnique({ where: { userId: user.id } });
    expect(row).toBeNull();
  });

  it('rejects an excerpt shorter than 5 seconds', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_tooshort' });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { sourceId: 'abcdef12345', title: 'X', durationMs: 1000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a negative start offset', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_negstart' });
    const res = await server.inject({
      method: 'PUT',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { sourceId: 'abcdef12345', title: 'X', durationMs: 30000, startMs: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('clear is idempotent and needs auth', async () => {
    const anon = await server.inject({ method: 'DELETE', url: '/api/music/profile' });
    expect(anon.statusCode).toBe(401);

    const user = await createAndLoginUser(server, { nickname: 'music_clear' });
    const first = await server.inject({
      method: 'DELETE',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(first.statusCode).toBe(204);
    const second = await server.inject({
      method: 'DELETE',
      url: '/api/music/profile',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(second.statusCode).toBe(204);
  });

  it('one row per user: a second set REPLACES the first (never duplicates)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_one_row' });
    // Seed a row directly (the download path is exercised elsewhere) and
    // confirm the table cannot hold two songs for one user.
    await prisma.profileMusic.create({
      data: {
        userId: user.id,
        title: 'First',
        artist: 'A',
        audioUrl: '/static/music/first.m4a',
        durationMs: 30000,
        startMs: 0,
        sourceId: 'first000001',
        sourceUrl: 'https://www.youtube.com/watch?v=first000001',
      },
    });
    await prisma.profileMusic.upsert({
      where: { userId: user.id },
      update: { title: 'Second' },
      create: {
        userId: user.id,
        title: 'Second',
        artist: 'B',
        audioUrl: '/static/music/second.m4a',
        durationMs: 30000,
        startMs: 0,
        sourceId: 'second00001',
        sourceUrl: 'https://www.youtube.com/watch?v=second00001',
      },
    });
    const all = await prisma.profileMusic.findMany({ where: { userId: user.id } });
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Second');
  });

  it('the profile payload exposes the pinned music (title, artist, audio)', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_payload' });
    await prisma.profileMusic.create({
      data: {
        userId: user.id,
        title: 'Minha Música',
        artist: 'Meu Artista',
        coverUrl: 'https://i.ytimg.com/vi/abc/hq.jpg',
        audioUrl: '/static/music/excerpt.m4a',
        durationMs: 45000,
        startMs: 12000,
        sourceId: 'abc1234567',
        sourceUrl: 'https://www.youtube.com/watch?v=abc1234567',
      },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/api/users/music_payload',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const music = JSON.parse(res.payload).user.music;
    expect(music).toEqual({
      title: 'Minha Música',
      artist: 'Meu Artista',
      coverUrl: 'https://i.ytimg.com/vi/abc/hq.jpg',
      audioUrl: '/static/music/excerpt.m4a',
      durationMs: 45000,
      startMs: 12000,
      sourceUrl: 'https://www.youtube.com/watch?v=abc1234567',
      sourceId: 'abc1234567',
    });
  });

  it('another user sees the pinned music too (it is public profile data)', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'music_owner' });
    const viewer = await createAndLoginUser(server, { nickname: 'music_viewer' });
    await prisma.profileMusic.create({
      data: {
        userId: owner.id,
        title: 'Pública',
        artist: 'Artista',
        audioUrl: '/static/music/pub.m4a',
        durationMs: 30000,
        startMs: 0,
        sourceId: 'pub0000001',
        sourceUrl: 'https://www.youtube.com/watch?v=pub0000001',
      },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/api/users/music_owner',
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.music.title).toBe('Pública');
  });

  it('deleting the user cascades the profile music row', async () => {
    const user = await createAndLoginUser(server, { nickname: 'music_cascade' });
    await prisma.profileMusic.create({
      data: {
        userId: user.id,
        title: 'Some',
        artist: 'A',
        audioUrl: '/static/music/some.m4a',
        durationMs: 30000,
        startMs: 0,
        sourceId: 'some000001',
        sourceUrl: 'https://www.youtube.com/watch?v=some000001',
      },
    });
    await prisma.user.delete({ where: { id: user.id } });
    const row = await prisma.profileMusic.findUnique({ where: { userId: user.id } });
    expect(row).toBeNull();
  });
});

// ── Filesystem behaviour of the excerpt download ──────────────
// A fake yt-dlp is placed on PATH (a real executable writing a real m4a), so
// the REAL spawn + real file handling + real byte validation run.
describe('excerpt download (fake yt-dlp binary)', () => {
  const binDir = path.resolve(process.cwd(), 'tests/fixtures/music-bin');
  const binPath = path.join(binDir, 'fake-ytdlp.sh');
  const original = process.env.YT_DLP_PATH;

  beforeAll(async () => {
    await fs.mkdir(binDir, { recursive: true });
    // Writes a valid MP4/ISOBMFF header to the -o target (the last arg).
    await fs.writeFile(
      binPath,
      `#!/usr/bin/env bash
set -e
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '\\x00\\x00\\x00\\x20ftypM4A \\x00\\x00\\x00\\x00M4A mp42isom' > "$out"
head -c 2048 /dev/zero >> "$out"
`,
      { mode: 0o755 },
    );
  });
  afterAll(async () => {
    process.env.YT_DLP_PATH = original;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it('downloads an excerpt, stores it under uploads/music and returns its URL', async () => {
    process.env.YT_DLP_PATH = binPath;
    // Re-import so the module picks up the stub path.
    vi.resetModules();
    const { downloadMusicExcerpt } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    const result = await downloadMusicExcerpt('abcdef12345', 30000, 60000);
    expect(result.url).toMatch(/\/static\/music\/[0-9a-f]{32}\.m4a$/);
    expect(result.bytes).toBeGreaterThan(0);

    // The file really exists and really is an m4a container.
    const name = result.url.split('/static/music/')[1];
    const full = path.resolve(process.cwd(), 'uploads', 'music', name);
    const head = Buffer.alloc(12);
    const handle = await fs.open(full, 'r');
    await handle.read(head, 0, 12, 0);
    await handle.close();
    expect(head.subarray(4, 8).toString('latin1')).toBe('ftyp');

    await fs.rm(full, { force: true });
  });

  it('refuses to store a file that is not real audio', async () => {
    process.env.YT_DLP_PATH = binPath;
    const badDir = path.resolve(process.cwd(), 'tests/fixtures/music-bin-bad');
    await fs.mkdir(badDir, { recursive: true });
    const badBin = path.join(badDir, 'fake-ytdlp-bad.sh');
    await fs.writeFile(
      badBin,
      `#!/usr/bin/env bash
set -e
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '<html>Sign in to confirm you are not a bot</html>' > "$out"
`,
      { mode: 0o755 },
    );
    process.env.YT_DLP_PATH = badBin;
    vi.resetModules();
    const { downloadMusicExcerpt } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(downloadMusicExcerpt('abcdef12345', 0, 30000)).rejects.toThrow();
    await fs.rm(badDir, { recursive: true, force: true });
  });
});
