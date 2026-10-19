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

  it('returns an empty list when the source genuinely finds nothing', async () => {
    // Deterministic: a yt-dlp that SUCCEEDS (exit 0) but prints no results.
    // This is the only case that may legitimately be an empty list — a
    // FAILURE must raise instead (covered in the regression test below).
    const user = await createAndLoginUser(server, { nickname: 'music_none' });
    const binDir = path.resolve(process.cwd(), 'tests/fixtures/music-bin-empty');
    await fs.mkdir(binDir, { recursive: true });
    const bin = path.join(binDir, 'ytdlp-empty.sh');
    await fs.writeFile(
      bin,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --js-runtimes RUNTIME[:PATH]"; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );
    process.env.YT_DLP_PATH = bin;
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/api/music/profile/search?q=zzqqxxwwvvbbnnaassdd',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).results).toEqual([]);
    } finally {
      delete process.env.YT_DLP_PATH;
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it('surfaces the REAL reason instead of a misleading "not found"', async () => {
    // Regression: a yt-dlp FAILURE used to return an empty list, so the app
    // said "nenhuma música encontrada" and the user had no clue what to fix.
    const user = await createAndLoginUser(server, { nickname: 'music_realerr' });
    const binDir = path.resolve(process.cwd(), 'tests/fixtures/music-bin-err');
    await fs.mkdir(binDir, { recursive: true });
    const bin = path.join(binDir, 'ytdlp-err.sh');
    await fs.writeFile(
      bin,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
echo "ERROR: Sign in to confirm you're not a bot." >&2
exit 1
`,
      { mode: 0o755 },
    );
    process.env.YT_DLP_PATH = bin;
    try {
      // Through the real route: the user must see the actual reason.
      const res = await server.inject({
        method: 'GET',
        url: '/api/music/profile/search?q=queen',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error.message).toMatch(/bloqueou|anti-bot/i);
    } finally {
      delete process.env.YT_DLP_PATH;
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});

// ── Cookie support (anti-bot) ─────────────────────────────────
// The server can authenticate to YouTube with a browser cookie jar, which is
// what lifts the "confirm you're not a bot" block on datacenter IPs.
describe('YouTube cookies', () => {
  const binDir = path.resolve(process.cwd(), 'tests/fixtures/music-bin-spy');
  const bin = path.join(binDir, 'spy-ytdlp.sh');
  const argsLog = path.resolve(process.cwd(), 'tests/fixtures/music-bin-spy/args.log');

  beforeAll(async () => {
    await fs.mkdir(binDir, { recursive: true });
    // Records the args (and the cookie file it was given) then fails, so the
    // test can assert BOTH that cookies were passed and how the failure reads.
    await fs.writeFile(
      bin,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
echo "ARGS: $*" >> "${argsLog}"
prev=""
for a in "$@"; do
  if [ "$prev" = "--cookies" ]; then
    echo "COOKIEFILE: $a" >> "${argsLog}"
    cat "$a" >> "${argsLog}" 2>&1
  fi
  prev="$a"
done
echo "ERROR: Sign in to confirm you're not a bot." >&2
exit 1
`,
      { mode: 0o755 },
    );
  });
  afterAll(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.YT_DLP_PATH;
    delete process.env.YT_COOKIES;
    delete process.env.YT_COOKIES_FILE;
    vi.resetModules();
  });

  it('passes a base64 cookie jar to yt-dlp as --cookies', async () => {
    const jar = [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t9999999999\tSID\tabc123',
    ].join('\n');
    process.env.YT_DLP_PATH = bin;
    process.env.YT_COOKIES = Buffer.from(jar, 'utf8').toString('base64');
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    // The flag was passed…
    expect(log).toContain('--cookies');
    // …and the jar reached the file DECODED (base64 was unwrapped).
    expect(log).toContain('SID\tabc123');
  });

  it('accepts a raw (non-base64) cookie jar too', async () => {
    const jar = [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t9999999999\tHSID\traw789',
    ].join('\n');
    process.env.YT_DLP_PATH = bin;
    process.env.YT_COOKIES = jar;
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    expect(log).toContain('HSID\traw789');
  });

  it('uses YT_COOKIES_FILE when no inline cookies are set', async () => {
    const jarPath = path.resolve(process.cwd(), 'tests/fixtures/jar-file.txt');
    await fs.writeFile(
      jarPath,
      '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t9999999999\tLOGIN_INFO\tfile999\n',
    );
    process.env.YT_DLP_PATH = bin;
    process.env.YT_COOKIES_FILE = jarPath;
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    expect(log).toContain('--cookies');
    expect(log).toContain('file999');
    await fs.rm(jarPath, { force: true });
  });

  it('runs WITHOUT --cookies when no cookie is configured', async () => {
    process.env.YT_DLP_PATH = bin;
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    // No cookie config → no --cookies flag (the feature still works without
    // it when the IP is not blocked).
    expect(log).not.toContain('--cookies');
  });

  it('never leaves the temporary cookie jar on disk', async () => {
    process.env.YT_DLP_PATH = bin;
    process.env.YT_COOKIES = Buffer.from('# Netscape HTTP Cookie File\n', 'utf8').toString('base64');
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    // A cookie jar is a credential: the per-run temp file must be gone.
    const leftovers = (await fs.readdir(path.resolve(process.cwd(), 'data'))).filter(
      (f) => f.startsWith('.yt-cookies-'),
    );
    expect(leftovers).toEqual([]);
  });
});

// ── JavaScript runtime (the YouTube requirement) ──────────────
// yt-dlp enables ONLY deno by default, but the YouTube now requires a JS
// runtime. On a Node server (Termux!) deno is often absent while Node is
// right there — so the code must fall back to the running Node binary.
describe('yt-dlp JavaScript runtime', () => {
  const binDir = path.resolve(process.cwd(), 'tests/fixtures/music-bin-js');
  const argsLog = path.join(binDir, 'args.log');

  /** A spy yt-dlp whose `--help` may or may not advertise --js-runtimes. */
  async function writeSpy(name: string, supportsJsRuntimes: boolean) {
    await fs.mkdir(binDir, { recursive: true });
    const file = path.join(binDir, name);
    await fs.writeFile(
      file,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
if [ "$1" = "--help" ]; then
  ${supportsJsRuntimes ? 'echo "  --js-runtimes RUNTIME[:PATH]  enable a runtime";' : 'echo "some help without that flag";'}
  exit 0
fi
echo "ARGS: $*" >> "${argsLog}"
echo "ERROR: Sign in to confirm you're not a bot." >&2
exit 1
`,
      { mode: 0o755 },
    );
    return file;
  }

  afterAll(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.YT_DLP_PATH;
    delete process.env.YT_JS_RUNTIME;
    delete process.env.YT_REMOTE_COMPONENTS;
    vi.resetModules();
  });

  it('honours YT_JS_RUNTIME when set', async () => {
    const spy = await writeSpy('spy-explicit.sh', true);
    process.env.YT_DLP_PATH = spy;
    process.env.YT_JS_RUNTIME = 'node:/custom/node';
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    expect(log).toContain('--js-runtimes node:/custom/node');
  });

  it('falls back to deno or the RUNNING node binary — never nothing', async () => {
    const spy = await writeSpy('spy-fallback.sh', true);
    process.env.YT_DLP_PATH = spy;
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    const match = /--js-runtimes (\S+)/.exec(log);
    expect(match).not.toBeNull();
    const runtime = match![1];
    // deno is preferred when present; otherwise the Node that runs THIS
    // server (guaranteed to exist). An empty/absent runtime would leave the
    // YouTube broken on hosts without deno — the Termux case.
    expect(runtime === 'deno' || runtime === `node:${process.execPath}`).toBe(true);
  });

  it('does not pass the flag to a yt-dlp that does not support it', async () => {
    // An older yt-dlp would abort with "unrecognized arguments", which would
    // break the feature entirely instead of just missing the runtime.
    const spy = await writeSpy('spy-old.sh', false);
    process.env.YT_DLP_PATH = spy;
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    expect(log).not.toContain('--js-runtimes');
  });

  it('never fetches remote components unless explicitly opted in', async () => {
    // Remote components mean downloading and EXECUTING third-party JS at
    // runtime. That is a security decision for the operator, never a default.
    const spy = await writeSpy('spy-norc.sh', true);
    process.env.YT_DLP_PATH = spy;
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    expect(log).not.toContain('--remote-components');
  });

  it('passes remote components when the operator opts in', async () => {
    const spy = await writeSpy('spy-rc.sh', true);
    process.env.YT_DLP_PATH = spy;
    process.env.YT_REMOTE_COMPONENTS = 'ejs:github';
    await fs.rm(argsLog, { force: true });

    vi.resetModules();
    const { searchProfileMusic } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    await expect(searchProfileMusic('queen')).rejects.toThrow();

    const log = await fs.readFile(argsLog, 'utf8');
    expect(log).toContain('--remote-components ejs:github');
    delete process.env.YT_REMOTE_COMPONENTS;
  });
});

// ── Instalação das ferramentas (start.sh) ─────────────────────
// O `start.sh` é o que roda de verdade no servidor. Antes, a instalação do
// yt-dlp só existia no instalador do Termux — quem fazia `git pull &&
// start.sh` nunca recebia as ferramentas, e foi assim que o recurso ficou
// indisponível. Além disso o comando estava ERRADO: no Termux o yt-dlp não é
// pacote do `pkg` (é `pip install -U yt-dlp`).
describe('start.sh media tools step', () => {
  const binDir = path.resolve(process.cwd(), 'tests/fixtures/media-tools-bin');
  const marker = path.join(binDir, 'installed.marker');
  const pipLog = path.join(binDir, 'pip-calls.log');

  /** Extracts the ensure_media_tools function body from start.sh. */
  async function loadFn(): Promise<string> {
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'start.sh'),
      'utf8',
    );
    const match = /^ensure_media_tools\(\) \{[\s\S]*?^\}/m.exec(src);
    if (!match) throw new Error('ensure_media_tools não encontrada em start.sh');
    return match[0];
  }

  beforeAll(async () => {
    await fs.mkdir(binDir, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it('the Termux installer uses pip for yt-dlp, never `pkg install yt-dlp`', async () => {
    // `pkg install yt-dlp` does not exist in Termux; using it was the bug.
    const script = await fs.readFile(
      path.resolve(process.cwd(), 'termux/termux-native.sh'),
      'utf8',
    );
    expect(script).not.toMatch(/pkg install[^\n]*\byt-dlp\b/);
    expect(script).toMatch(/pip install -U[^\n]*yt-dlp/);
  });

  it('start.sh installs yt-dlp when missing and re-checks the result', async () => {
    // A stub python3: `-m yt_dlp` fails until the "install" creates a marker.
    await fs.writeFile(
      path.join(binDir, 'python3'),
      `#!/usr/bin/env bash
if [ "$1" = "-m" ] && [ "$2" = "yt_dlp" ]; then
  if [ -f "${marker}" ]; then echo "2026.08.19"; exit 0; fi
  echo "No module named yt_dlp" >&2; exit 1
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  echo "PIP: $*" >> "${pipLog}"
  touch "${marker}"
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    await fs.rm(marker, { force: true });
    await fs.rm(pipLog, { force: true });

    const fn = await loadFn();
    // Run the function in a real bash, with the stub first on PATH and no
    // yt-dlp visible.
    const script = `
set -u
export PATH="${binDir}:$(echo "$PATH" | tr ':' '\\n' | grep -v '\\.local/bin' | paste -sd:)"
ok() { echo "OK:$*"; }
warn() { echo "WARN:$*"; }
log() { echo "LOG:$*"; }
die() { echo "DIE:$*"; exit 1; }
matrix_is_termux() { return 1; }
${fn}
ensure_media_tools
`;
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('bash', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    // The install was attempted through pip…
    const calls = await fs.readFile(pipLog, 'utf8');
    expect(calls).toMatch(/pip install -U --break-system-packages yt-dlp/);
    // …and the FINAL state is reported from a real re-check, not assumed.
    expect(out).toContain('OK:Música do perfil: yt-dlp disponível');
    expect(out).not.toContain('indisponível: yt-dlp ausente');
  });

  it('reports clearly when the install fails (never silent)', async () => {
    // python3 that always fails and a pip that does nothing: the step must
    // SAY the feature is unavailable instead of pretending it worked.
    await fs.writeFile(
      path.join(binDir, 'python3'),
      `#!/usr/bin/env bash
echo "No module named yt_dlp" >&2
exit 1
`,
      { mode: 0o755 },
    );
    const fn = await loadFn();
    const script = `
set -u
export PATH="${binDir}:$(echo "$PATH" | tr ':' '\\n' | grep -v '\\.local/bin' | paste -sd:)"
ok() { echo "OK:$*"; }
warn() { echo "WARN:$*"; }
log() { echo "LOG:$*"; }
die() { echo "DIE:$*"; exit 1; }
matrix_is_termux() { return 1; }
${fn}
ensure_media_tools
`;
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('bash', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out).toContain('yt-dlp ausente');
  });
});

// ── Diagnóstico: o erro real precisa aparecer ─────────────────
describe('yt-dlp failure diagnostics', () => {
  it('attaches the REAL yt-dlp output to the error', async () => {
    // The Termux report was an unclassified failure: the message was the
    // generic fallback and there was NO way to see why. Every failure must
    // now carry the actual output.
    const { ytdlpFailureToApiError } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    const err = ytdlpFailureToApiError(
      "WARNING: [youtube] Some warning\nERROR: bV9xJxYv: 'NoneType' object has no attribute 'get'\n",
    );
    expect(err.details).toEqual({
      ytdlp: "WARNING: [youtube] Some warning | ERROR: bV9xJxYv: 'NoneType' object has no attribute 'get'",
    });
  });

  it('names the missing JS runtime as the cause', async () => {
    const { ytdlpFailureToApiError } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    const err = ytdlpFailureToApiError(
      'WARNING: [youtube] No supported JavaScript runtime could be found',
    );
    expect(err.message).toMatch(/runtime de JavaScript|deno/i);
  });

  it('keeps the specific messages for block/missing/outdated', async () => {
    const { ytdlpFailureToApiError } = await import(
      '../src/modules/music/profile-music.ytdlp.js'
    );
    expect(ytdlpFailureToApiError('ERROR: Sign in to confirm you are not a bot').message)
      .toMatch(/anti-bot|cookies/i);
    expect(ytdlpFailureToApiError('yt-dlp: command not found').message)
      .toMatch(/não está instalado/i);
    expect(ytdlpFailureToApiError('ERROR: unable to extract nsig').message)
      .toMatch(/desatualizado/i);
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
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --js-runtimes RUNTIME[:PATH]"; exit 0; fi
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
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --js-runtimes RUNTIME[:PATH]"; exit 0; fi
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
