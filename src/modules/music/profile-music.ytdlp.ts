import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { ApiError } from '../../utils/errors.js';
import { publicBase } from '../../utils/storage.js';

// ── Música do perfil (YouTube via yt-dlp) ────────────────────
//
// O usuário pesquisa uma música, o servidor consulta o YouTube Music pelo
// yt-dlp, devolve até 3 resultados e, ao escolher, baixa SOMENTE o trecho
// (<= 1 minuto) e guarda em uploads/music/.
//
// Decisões que importam:
//  * A BUSCA usa o catálogo do YouTube Music (filtro "songs"), não a busca
//    genérica de vídeos: isso remove clipes, react, "top 10" e afins, que
//    eram exatamente os títulos aleatórios que o usuário não quer ver.
//  * Os títulos ainda vêm poluídos ("(Official Video)", "[HD]", "Lyrics"),
//    então passam por uma LIMPEZA que extrai "Música - Artista" quando o
//    padrão aparece, senão remove os ruídos conhecidos.
//  * O DOWNLOAD é por SEÇÃO (`--download-sections`): baixamos só os
//    segundos do trecho, nunca a música inteira — menos banda, menos disco.
//  * O binário/args são passados por ARRAY ao spawn (nunca um shell): a
//    busca do usuário não vira comando.
//  * Tudo tem timeout e limite de saída; erro externo vira mensagem amigável.

/** Executável do yt-dlp. Configurável porque o nome/caminho varia por host. */
const YTDLP_BIN = process.env.YT_DLP_PATH ?? 'yt-dlp';

/**
 * Prefixo de comando resolvido do yt-dlp (cacheado).
 *
 * O binário pode não estar no PATH (Termux, containers enxutos): nesse caso
 * caímos para `python3 -m yt_dlp`, que é o mesmo programa instalado como
 * módulo. A sondagem acontece UMA vez e o resultado fica em cache.
 *
 * O cache é indexado pela LISTA DE CANDIDATOS: mudar YT_DLP_PATH muda a lista
 * e força nova sondagem. Sem isso, trocar a config em runtime (um teste, um
 * ajuste no painel) continuaria usando o caminho antigo — bug real pego por
 * teste.
 */
let resolvedCommand: string[] | null = null;
let resolvedForCandidates: string | null = null;

function ytdlpCandidates(): string[][] {
  const fromEnv = process.env.YT_DLP_PATH;
  const candidates: string[][] = [];
  if (fromEnv) candidates.push([fromEnv]);
  candidates.push([YTDLP_BIN]);
  candidates.push(['python3', '-m', 'yt_dlp']);
  // Sem duplicatas: quando YT_DLP_PATH está definido, ele apareceria duas
  // vezes (uma como env, outra como YTDLP_BIN).
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sonda qual forma do yt-dlp FUNCIONA neste host (uma vez por configuração).
 *
 * "Existe" não basta: `python3 -m yt_dlp` existe em qualquer host com Python
 * e falha com "No module named yt_dlp" quando o pacote não está instalado.
 * Aceitar esse candidato fazia a busca rodar um comando quebrado e cair no
 * erro genérico — foi exatamente o caso relatado no Termux. Por isso exigimos
 * `code === 0` e guardamos a falha real para diagnóstico.
 */
async function resolveYtdlpCommand(): Promise<string[]> {
  const candidates = ytdlpCandidates();
  const key = JSON.stringify(candidates);
  if (resolvedCommand && resolvedForCandidates === key) return resolvedCommand;

  let lastFailure = '(sem saída)';
  for (const candidate of candidates) {
    try {
      const result = await runProcess(candidate, ['--version'], 20_000);
      if (result.code === 0) {
        resolvedCommand = candidate;
        resolvedForCandidates = key;
        return candidate;
      }
      lastFailure = summarizeYtdlpOutput(result.stderr || result.stdout);
    } catch (err) {
      // Não existe / não executa — tenta a próxima forma.
      lastFailure = err instanceof Error ? err.message : String(err);
    }
  }
  throw ApiError.internal(
    'Busca de música indisponível: o yt-dlp não está instalado neste servidor. '
      + 'No Termux: `pip install -U yt-dlp`; em Debian/Ubuntu: `pip install yt-dlp`. '
      + 'Você também pode apontar o binário com YT_DLP_PATH.',
    { ytdlp: lastFailure },
  );
}

/** Marca um comando como inválido para forçar nova sondagem. */
function invalidateResolvedCommand(): void {
  resolvedCommand = null;
  resolvedForCandidates = null;
  jsRuntimeArgs = null;
}

/**
 * Argumentos `--js-runtimes` para o yt-dlp (cacheado).
 *
 * O YouTube passou a EXIGIR um runtime de JavaScript e o yt-dlp só habilita
 * `deno` por padrão. Num servidor Node isso é um tiro no pé: o `deno` pode
 * não existir (no Termux não é pacote padrão) enquanto o **Node está ali, já
 * que a API roda nele**. Então:
 *   1. `YT_JS_RUNTIME` (env) manda, se definido;
 *   2. senão, `deno` quando existir (é o runtime que o yt-dlp prefere);
 *   3. senão, o PRÓPRIO binário do Node que executa este servidor
 *      (`process.execPath`) — garantidamente presente e válido.
 *
 * A sondagem do `--help` evita passar uma flag que yt-dlp antigo não conhece
 * (isso abortaria com "unrecognized arguments").
 */
let jsRuntimeArgs: string[] | null = null;

async function resolveJsRuntimeArgs(): Promise<string[]> {
  if (jsRuntimeArgs) return jsRuntimeArgs;
  const command = await resolveYtdlpCommand();

  const help = await runProcess(command, ['--help'], 20_000).catch(() => null);
  if (!help || !help.stdout.includes('--js-runtimes')) {
    // Versão antiga: a flag não existe, então não passa nada.
    jsRuntimeArgs = [];
    return jsRuntimeArgs;
  }

  const explicit = (process.env.YT_JS_RUNTIME ?? '').trim();
  if (explicit !== '') {
    jsRuntimeArgs = ['--js-runtimes', explicit];
    return jsRuntimeArgs;
  }

  // `deno` é o runtime preferido pelo yt-dlp — usa quando existir.
  const deno = await runProcess(['deno'], ['--version'], 20_000).catch(() => null);
  if (deno && deno.code === 0) {
    jsRuntimeArgs = ['--js-runtimes', 'deno'];
    return jsRuntimeArgs;
  }

  // Fallback sempre disponível: o Node que está rodando este servidor.
  jsRuntimeArgs = ['--js-runtimes', `node:${process.execPath}`];
  return jsRuntimeArgs;
}

/**
 * Componentes remotos do yt-dlp (opt-in, DESLIGADO por padrão).
 *
 * Alguns desafios do YouTube só são resolvidos com o pacote `yt-dlp-ejs`. Se
 * ele NÃO estiver instalado, o yt-dlp pode baixar o componente do GitHub —
 * mas isso é executar JavaScript de terceiros, baixado em runtime, no seu
 * servidor. Isso é um risco de segurança, então NUNCA ligamos sozinhos:
 * quem quiser habilita explicitamente com
 * `YT_REMOTE_COMPONENTS=ejs:github` (ou instala o pacote
 * `pip install yt-dlp-ejs`, que é o caminho seguro e preferível).
 */
async function remoteComponentArgs(): Promise<string[]> {
  const value = (process.env.YT_REMOTE_COMPONENTS ?? '').trim();
  if (value === '') return [];
  return ['--remote-components', value];
}

/** Limite de duração do trecho no perfil (1 minuto). */
export const MAX_PROFILE_MUSIC_MS = 60_000;

/** Duração mínima aceita para um trecho (evita cortes degenerados). */
export const MIN_PROFILE_MUSIC_MS = 5_000;

/** Quantos resultados a busca devolve. */
export const PROFILE_MUSIC_RESULTS = 3;

/** Timeout da busca (a busca é rápida: ~6s medidos). */
const SEARCH_TIMEOUT_MS = 45_000;

/** Timeout do download — generoso, mas finito. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Teto de bytes do trecho baixado. */
export const MAX_PROFILE_MUSIC_BYTES = 12 * 1024 * 1024;

/** Filtro "songs" do YouTube Music (música, não vídeo). */
const YTM_SONGS_FILTER = 'EgWKAQIIAWoKEAoQAxAEEAkQBQ==';

export interface MusicSearchResult {
  /** Id do vídeo no YouTube (`sourceId`). */
  sourceId: string;
  /** Título limpo, já sem ruído de vídeo. */
  title: string;
  /** Autor/intérprete. */
  artist: string;
  coverUrl: string | null;
  /** Duração completa da faixa no YouTube (ms), para referência na UI. */
  durationMs: number;
}

interface YtdlpJson {
  id?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  artist?: unknown;
  creator?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
}

/**
 * Ruídos de vídeo que o YouTube Music ainda deixa passar no título. Removidos
 * ANTES de tentar separar "música - artista", porque "Official Video" costuma
 * vir dentro dos parênteses junto do resto.
 */
const NOISE_PATTERNS: RegExp[] = [
  /\((?:official\s*)?(?:music\s*)?(?:video|audio|lyric(?:s)?|visuali[sz]er|clip)(?:\s*remaster(?:ed)?)?(?:\s*hd|\s*4k)?\)/gi,
  /\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyric(?:s)?|visuali[sz]er|clip)(?:\s*remaster(?:ed)?)?(?:\s*hd|\s*4k)?\]/gi,
  /\((?:official|oficial)\)/gi,
  /\b(?:official|oficial)\s+(?:video|audio|music\s*video)\b/gi,
  /\b(?:lyric|lyrics)\s+video\b/gi,
  /\b(?:hd|hq|4k|8k|1080p|720p)\b/gi,
  /\bremaster(?:ed)?\b/gi,
  /\b(?:audio|áudio)\s*only\b/gi,
  /\bfull\s+(?:song|album|video)\b/gi,
  /\b(?:letra|traduç[ãa]o)\b/gi,
];

/**
 * Remove os ruídos conhecidos de título de vídeo e normaliza os espaços.
 * Nunca devolve string vazia: se a limpeza zerar tudo, o título original
 * volta (melhor um título imperfeito que nenhum).
 */
export function cleanMusicTitle(raw: string): string {
  let out = raw;
  for (const re of NOISE_PATTERNS) out = out.replace(re, ' ');
  // Remover o ruído pode deixar delimitadores VAZIOS ("Song [ ]", "Song ()") —
  // eles precisam sair também, senão o título fica sujo de outro jeito.
  out = out
    .replace(/[([{]\s*[)\]}]/g, ' ')
    .replace(/\s*[-–—]\s*[-–—]\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '')
    .replace(/^\s*[-–—]\s*/g, '')
    .trim();
  return out.length > 0 ? out : raw.trim();
}

/**
 * O lado do título "casa" com o uploader/canal? Usado para decidir quem é o
 * artista quando o título tem um separador.
 */
function looksLikeUploader(part: string, uploader: string): boolean {
  if (uploader === '' || part === '') return false;
  const a = part.toLowerCase();
  const b = uploader.toLowerCase();
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * Separa o título limpo em (música, artista).
 *
 * O YouTube Music NÃO entrega `artist`/`track` separados (verificado: vêm
 * nulos), então a separação vem do título. O problema é que a ordem é
 * AMBÍGUA entre as duas fontes:
 *   * YouTube Music → "Artista – Música" (ex.: "Queen – Bohemian Rhapsody");
 *   * YouTube comum  → "Música - Artista".
 *
 * O UPLOADER desempata: o lado que casa com o nome do canal é o artista.
 * Sem pista nenhuma, assumimos o padrão do YouTube Music (artista primeiro),
 * que é a fonte desta busca. Sem separador, o uploader vira o artista —
 * nunca inventamos um.
 */
export function splitMusicTitle(
  cleaned: string,
  uploader: string | null,
): { title: string; artist: string } {
  const fallbackArtist = (uploader ?? '').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/).filter((p) => p.trim().length > 0);

  if (parts.length >= 2) {
    const first = parts[0].trim();
    const last = parts[parts.length - 1].trim();
    const rest = parts.slice(1).join(' - ').trim();
    const head = parts.slice(0, -1).join(' - ').trim();

    // "Artista – Música": o começo é o canal.
    if (looksLikeUploader(first, fallbackArtist)) {
      return { title: rest, artist: first };
    }
    // "Música - Artista": o fim é o canal.
    if (looksLikeUploader(last, fallbackArtist)) {
      return { title: head, artist: last };
    }
    // Sem pista: padrão do YouTube Music (artista primeiro).
    return { title: rest, artist: first };
  }

  return { title: cleaned, artist: fallbackArtist };
}

/** Extrai a URL de capa de um item do yt-dlp (thumbnail explícita ou lista). */
function pickCoverUrl(item: YtdlpJson): string | null {
  if (typeof item.thumbnail === 'string' && item.thumbnail) return item.thumbnail;
  if (Array.isArray(item.thumbnails)) {
    const urls = item.thumbnails
      .map((t) => (t && typeof t === 'object' ? (t as { url?: unknown }).url : null))
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (urls.length > 0) return urls[urls.length - 1];
  }
  return null;
}

/** Converte um item JSON do yt-dlp no resultado da busca, ou null se inválido. */
export function toSearchResult(item: YtdlpJson): MusicSearchResult | null {
  const sourceId = typeof item.id === 'string' ? item.id : '';
  const rawTitle = typeof item.title === 'string' ? item.title : '';
  if (sourceId === '' || rawTitle.trim() === '') return null;

  const uploaderCandidates = [item.artist, item.creator, item.uploader, item.channel]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const uploader = uploaderCandidates[0] ?? null;

  const cleaned = cleanMusicTitle(rawTitle);
  const { title, artist } = splitMusicTitle(cleaned, uploader);
  const seconds = typeof item.duration === 'number' ? item.duration : 0;

  return {
    sourceId,
    title: title || rawTitle,
    artist,
    coverUrl: pickCoverUrl(item),
    durationMs: seconds > 0 ? Math.round(seconds * 1000) : 0,
  };
}

/** Executa um processo com timeout e teto de saída; nunca usa shell. */
function runProcess(
  command: string[],
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command[0], [...command.slice(1), ...args], { shell: false });
    } catch {
      reject(ApiError.internal('Busca de música indisponível neste servidor.'));
      return;
    }
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(ApiError.internal('A busca de música demorou demais. Tente novamente.'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(ApiError.internal('Busca de música indisponível neste servidor.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Reduz a saída do yt-dlp às últimas linhas úteis. É um log de diagnóstico:
 * serve para dizer QUAL foi o erro real, sem despejar o dump inteiro.
 */
export function summarizeYtdlpOutput(stderr: string, maxLines = 8): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return '(sem saída)';
  return lines.slice(-maxLines).join(' | ').slice(0, 1200);
}

/**
 * Traduz a falha do yt-dlp numa mensagem que diz o que FAZER. O ponto é que o
 * usuário (ou quem dá suporte) saiba a diferença entre "o YouTube bloqueou",
 * "o yt-dlp está velho" e "não tem yt-dlp" — antes tudo isso virava "nenhuma
 * música encontrada".
 *
 * Toda mensagem carrega `details` com a saída REAL do yt-dlp: sem isso, um
 * erro que não casa com nenhum padrão vira "tente novamente" e não há como
 * descobrir a causa (foi exatamente o que aconteceu no Termux).
 */
export function ytdlpFailureToApiError(stderr: string): ApiError {
  const s = stderr.toLowerCase();
  const details = { ytdlp: summarizeYtdlpOutput(stderr) };
  if (/no module named|module not found|cannot find module/.test(s)) {
    return ApiError.internal(
      'O yt-dlp não está instalado neste servidor (o Python não achou o módulo). '
        + 'No Termux: `pip install -U yt-dlp`; em Debian/Ubuntu: `pip install yt-dlp`.',
      details,
    );
  }
  if (/not installed|no such file|command not found|eacces|executable file not found/.test(s)) {
    return ApiError.internal(
      'Busca de música indisponível: o yt-dlp não está instalado neste servidor. '
        + 'No Termux: `pip install -U yt-dlp`; em Debian/Ubuntu: `pip install yt-dlp`.',
      details,
    );
  }
  if (/ffmpeg/.test(s)) {
    return ApiError.internal(
      'O servidor precisa do ffmpeg para baixar o trecho (instale com `apt install ffmpeg`).',
      details,
    );
  }
  if (/no supported javascript runtime|js runtime|ejs|deno/.test(s)) {
    return ApiError.internal(
      'O yt-dlp não achou um runtime de JavaScript (o YouTube exige um). '
        + 'Normalmente o servidor cai para o próprio Node automaticamente; se '
        + 'esta mensagem apareceu, defina YT_JS_RUNTIME (ex.: node:/caminho/node). '
        + 'No Termux, `pkg install deno` exige `pkg update && pkg upgrade` antes.',
      details,
    );
  }
  if (/sign in|confirm you.{0,3}re not a bot|cookies|bot\b|429|too many requests|403|forbidden/.test(s)) {
    return ApiError.internal(
      'O YouTube bloqueou o servidor (verificação anti-bot). Configure os cookies '
        + 'do YouTube para liberar (YT_COOKIES / YT_COOKIES_FILE) ou use uma rede '
        + 'residencial/VPN.',
      details,
    );
  }
  if (/nsig|signature|unable to extract|failed to extract|player response|precondition/.test(s)) {
    return ApiError.internal(
      'O yt-dlp não conseguiu falar com o YouTube — provavelmente está desatualizado. '
        + 'Atualize com `pip install -U yt-dlp`.',
      details,
    );
  }
  if (/timed out|timeout/.test(s)) {
    return ApiError.internal('A busca demorou demais. Tente novamente.', details);
  }
  // Fallback: ainda devolve a saída real, senão não há como diagnosticar.
  return ApiError.internal(
    'Não foi possível consultar o YouTube agora. Tente novamente em instantes.',
    details,
  );
}

/** Um cookie jar temporário criado a partir de YT_COOKIES (base64). */
async function writeTempCookieFile(): Promise<string | null> {
  const raw = process.env.YT_COOKIES;
  if (!raw || raw.trim() === '') return null;
  const dir = path.resolve(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `.yt-cookies-${randomBytes(8).toString('hex')}.txt`);
  let content = raw.trim();
  // Aceita base64 (recomendado: o painel lida bem com uma linha só) ou o
  // texto do cookie jar colado direto.
  if (!/^#\s*(Netscape|HTTP Cookie File)/i.test(content)) {
    try {
      const decoded = Buffer.from(content, 'base64').toString('utf8');
      if (decoded.includes('\t')) content = decoded;
    } catch {
      // Não era base64 — segue com o texto como veio.
    }
  }
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

/**
 * Os argumentos de cookie para o yt-dlp, ou [] quando não há cookie nenhum.
 *
 * YT_COOKIES (conteúdo, base64 ou texto) tem prioridade sobre
 * YT_COOKIES_FILE (caminho). É assim que se tira o bloqueio anti-bot do
 * YouTube num servidor: o jar do navegador prova que a sessão é humana.
 */
async function cookieArgs(): Promise<{ args: string[]; temp: string | null }> {
  const temp = await writeTempCookieFile();
  if (temp) return { args: ['--cookies', temp], temp };
  const file = process.env.YT_COOKIES_FILE;
  if (file && file.trim() !== '') {
    try {
      await fs.access(file);
      return { args: ['--cookies', file], temp: null };
    } catch {
      // Caminho configurado mas inexistente: melhor seguir sem cookies do que
      // falhar a busca inteira por causa disso.
    }
  }
  return { args: [], temp: null };
}

/** Executa o yt-dlp já resolvido (binário ou `python3 -m yt_dlp`). */
async function runYtdlp(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = await resolveYtdlpCommand();
  const { args: cArgs, temp } = await cookieArgs();
  // O runtime de JavaScript vem antes de tudo: sem ele o YouTube nem responde.
  const jsArgs = await resolveJsRuntimeArgs();
  const rcArgs = await remoteComponentArgs();
  try {
    return await runProcess(command, [...cArgs, ...jsArgs, ...rcArgs, ...args], timeoutMs);
  } catch (err) {
    // Se o comando sumiu entre a sondagem e agora, a próxima chamada resolve
    // de novo em vez de ficar preso num caminho inválido.
    invalidateResolvedCommand();
    throw err;
  } finally {
    // O jar temporário vive só enquanto o processo roda — nunca fica no disco.
    if (temp) await fs.rm(temp, { force: true }).catch(() => void 0);
  }
}

/**
 * Busca músicas no YouTube Music. Devolve no máximo [PROFILE_MUSIC_RESULTS]
 * resultados já limpos (título/artista) e SEM duplicatas de id.
 *
 * `--flat-playlist` na primeira tentativa é o caminho barato; como alguns
 * campos (duração/capa) só vêm com a extração completa, pedimos os metadados
 * completos de uma vez com `--dump-json` — medido em ~6s para 3 itens.
 */
export async function searchProfileMusic(query: string): Promise<MusicSearchResult[]> {
  const q = query.trim();
  if (q.length === 0) throw ApiError.validation('Informe o nome da música.');
  if (q.length > 120) throw ApiError.validation('Busca muito longa.');

  const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(q)}&sp=${encodeURIComponent(YTM_SONGS_FILTER)}`;
  const { code, stdout, stderr } = await runYtdlp(
    [
      '--dump-json',
      '--ignore-errors',
      '--no-warnings',
      '--skip-download',
      '--playlist-end',
      String(PROFILE_MUSIC_RESULTS),
      searchUrl,
    ],
    SEARCH_TIMEOUT_MS,
  );

  const items: YtdlpJson[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed[0] !== '{') continue;
    try {
      items.push(JSON.parse(trimmed) as YtdlpJson);
    } catch {
      // Linha não-JSON (aviso/ruído) — ignorada.
    }
  }

  if (items.length === 0) {
    // UM ERRO DO yt-dlp NÃO É "NENHUM RESULTADO". Sem esta distinção o app
    // dizia "nenhuma música encontrada" quando o problema real era o
    // yt-dlp bloqueado/desatualizado/ausente — o usuário não tinha pista
    // nenhuma do que consertar.
    if (code !== 0) {
      throw ytdlpFailureToApiError(stderr);
    }
    return [];
  }

  const seen = new Set<string>();
  const results: MusicSearchResult[] = [];
  for (const item of items) {
    const result = toSearchResult(item);
    if (!result || seen.has(result.sourceId)) continue;
    seen.add(result.sourceId);
    results.push(result);
    if (results.length >= PROFILE_MUSIC_RESULTS) break;
  }
  return results;
}

export interface StoredProfileMusicFile {
  url: string;
  bytes: number;
}

/**
 * Baixa SOMENTE o trecho [startMs, startMs + durationMs) do vídeo e devolve
 * a URL pública do arquivo. O trecho é re-codificado para m4a (AAC), o
 * container que o app já toca nativamente.
 *
 * A seção é validada ANTES: nunca aceitamos um trecho maior que o limite,
 * mesmo que o cliente peça.
 */
export async function downloadMusicExcerpt(
  sourceId: string,
  startMs: number,
  durationMs: number,
): Promise<StoredProfileMusicFile> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(sourceId)) {
    throw ApiError.validation('Música inválida.');
  }
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw ApiError.validation('Trecho inválido.');
  }
  if (!Number.isFinite(durationMs) || durationMs < MIN_PROFILE_MUSIC_MS) {
    throw ApiError.validation('O trecho deve ter pelo menos 5 segundos.');
  }
  if (durationMs > MAX_PROFILE_MUSIC_MS) {
    throw ApiError.validation('O trecho deve ter no máximo 1 minuto.');
  }

  const dir = path.resolve(process.cwd(), 'uploads', 'music');
  await fs.mkdir(dir, { recursive: true });
  const stem = randomBytes(16).toString('hex');
  const dest = path.join(dir, `${stem}.m4a`);
  const startSec = (startMs / 1000).toFixed(3);
  const endSec = ((startMs + durationMs) / 1000).toFixed(3);

  const { code, stderr } = await runYtdlp(
    [
      '--no-warnings',
      '--no-playlist',
      // Só o trecho: o yt-dlp busca os ranges e o ffmpeg corta/re-codifica.
      '--download-sections',
      `*${startSec}-${endSec}`,
      '--force-keyframes-at-cuts',
      '-f',
      'bestaudio',
      '-x',
      '--audio-format',
      'm4a',
      '--audio-quality',
      '5',
      '--max-filesize',
      String(MAX_PROFILE_MUSIC_BYTES),
      '-o',
      dest,
      `https://www.youtube.com/watch?v=${sourceId}`,
    ],
    DOWNLOAD_TIMEOUT_MS,
  );

  if (code !== 0) {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    // Mesma tradução da busca: o usuário precisa saber se foi bloqueio,
    // ffmpeg ausente ou yt-dlp velho — não um "tente novamente" genérico.
    throw ytdlpFailureToApiError(stderr);
  }

  let stat;
  try {
    stat = await fs.stat(dest);
  } catch {
    throw ApiError.internal('Não foi possível baixar a música. Tente novamente.');
  }
  if (stat.size === 0) {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    throw ApiError.internal('O trecho baixado ficou vazio. Tente outra música.');
  }
  if (stat.size > MAX_PROFILE_MUSIC_BYTES) {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    throw ApiError.payloadTooLarge('O trecho baixado excede o tamanho permitido.');
  }

  // Confere que o que chegou é REALMENTE um container de áudio MP4/ISOBMFF,
  // não um HTML de erro do YouTube salvo como .m4a (o yt-dlp falha de formas
  // criativas). Mesma filosofia do resto do projeto: validar os bytes.
  const head = Buffer.alloc(12);
  const handle = await fs.open(dest, 'r');
  try {
    await handle.read(head, 0, 12, 0);
  } finally {
    await handle.close();
  }
  if (head.subarray(4, 8).toString('latin1') !== 'ftyp') {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    throw ApiError.internal('O arquivo baixado não é um áudio válido. Tente outra música.');
  }

  return { url: `${publicBase()}/static/music/${stem}.m4a`, bytes: stat.size };
}

/** Remove um arquivo de música do perfil (best-effort). */
export async function deleteProfileMusicFile(url: string): Promise<void> {
  const marker = '/static/music/';
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const name = path.basename(url.slice(idx + marker.length));
  if (!name) return;
  const dir = path.resolve(process.cwd(), 'uploads', 'music');
  const full = path.join(dir, name);
  if (path.dirname(full) !== dir) return;
  await fs.rm(full, { force: true }).catch(() => void 0);
}
