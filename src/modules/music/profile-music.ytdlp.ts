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

/** Interpreta um valor de env como booleano ligado (1/true/yes/on). */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(value.trim().toLowerCase());
}

/** Marca um comando como inválido para forçar nova sondagem. */
function invalidateResolvedCommand(): void {
  resolvedCommand = null;
  resolvedForCandidates = null;
  jsRuntimeArgs = null;
  ffmpegLocation = null;
}

/**
 * Localiza o binário do ffmpeg (cacheado).
 *
 * O yt-dlp precisa do ffmpeg para `--download-sections`, mas procura ele no
 * PATH — e no Termux o `pkg` instala em `$PREFIX/bin`, que pode faltar no PATH
 * do processo. Aqui descobrimos o caminho ABSOLUTO e passamos via
 * `--ffmpeg-location`, eliminando a dependência do PATH.
 *
 * Retorna o diretório que contém o ffmpeg, ou null quando não há nenhum.
 */
let ffmpegLocation: string | null | undefined;

export async function findFfmpegDir(): Promise<string | null> {
  if (ffmpegLocation !== undefined) return ffmpegLocation;

  // Válvula de escape: com ffmpeg quebrado/parcial (comum no Termux), o
  // operador pode forçar o caminho SEM ffmpeg em vez de tentar consertá-lo.
  // Sem isso, um ffmpeg que existe mas falha no meio do download deixaria o
  // recurso inutilizável sem saída.
  if (isTruthy(process.env.YT_NO_FFMPEG)) {
    ffmpegLocation = null;
    return null;
  }

  const explicit = (process.env.FFMPEG_PATH ?? '').trim();
  const candidates: string[] = [];
  if (explicit !== '') {
    // Aceita tanto o binário quanto o diretório.
    candidates.push(
      explicit.endsWith('ffmpeg') ? path.dirname(explicit) : explicit,
    );
  }
  candidates.push(
    process.env.PREFIX ? `${process.env.PREFIX}/bin` : '',
    '/data/data/com.termux/files/usr/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/ffmpeg/bin',
  );

  for (const dir of candidates) {
    if (dir === '') continue;
    const bin = path.join(dir, 'ffmpeg');
    try {
      await fs.access(bin);
      // Existe não basta: um ffmpeg parcialmente instalado (comum no Termux)
      // fica no PATH mas não executa.
      const probe = await runProcess([bin], ['-version'], 15_000).catch(() => null);
      if (probe && probe.code === 0) {
        ffmpegLocation = dir;
        return dir;
      }
    } catch {
      // Não existe nesse diretório — tenta o próximo.
    }
  }
  ffmpegLocation = null;
  return null;
}

/** `--ffmpeg-location <dir>` quando achamos um ffmpeg que executa. */
async function ffmpegArgs(): Promise<string[]> {
  const dir = await findFfmpegDir();
  return dir ? ['--ffmpeg-location', dir] : [];
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

/**
 * Timeout da busca. Generoso de propósito: medido em ~6s num host x86, mas no
 * Termux (celular, com cookies e runtime JS) passa de 45s com facilidade —
 * o timeout curto derrubava buscas que só estavam lentas.
 */
const SEARCH_TIMEOUT_MS = 120_000;

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

/**
 * PATH ampliado com os locais onde o ffmpeg/deno costumam ficar mas que nem
 * sempre estão no PATH herdado pelo processo do servidor.
 *
 * Por que isso importa: o yt-dlp procura o ffmpeg NO PATH. No Termux o
 * `pkg` instala em `$PREFIX/bin` (= /data/data/com.termux/files/usr/bin) e
 * esse diretório pode faltar no PATH quando o Node é iniciado por um serviço
 * ou por um wrapper — e aí o yt-dlp aborta com "ffmpeg is not installed"
 * mesmo com o ffmpeg instalado. Deduplicamos para não inflar o PATH.
 */
function augmentedPath(): string {
  const current = process.env.PATH ?? '';
  const extra = [
    process.env.PREFIX ? `${process.env.PREFIX}/bin` : '',
    '/data/data/com.termux/files/usr/bin', // Termux
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin', // macOS (Apple Silicon)
    '/usr/local/opt/ffmpeg/bin', // Homebrew (Intel)
  ].filter((p) => p !== '');
  const seen = new Set<string>();
  return [...current.split(':'), ...extra]
    .filter((p) => {
      if (p === '' || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join(':');
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
      child = spawn(command[0], [...command.slice(1), ...args], {
        shell: false,
        // PATH AMPLIADO: o yt-dlp procura o ffmpeg no PATH do processo. No
        // Termux o ffmpeg instalado pelo `pkg` fica em $PREFIX/bin, que pode
        // não estar no PATH herdado pelo Node (ex.: iniciado por um serviço).
        // Sem isso o yt-dlp aborta com "ffmpeg is not installed" mesmo com o
        // ffmpeg presente — foi exatamente o caso relatado.
        env: { ...process.env, PATH: augmentedPath() },
      });
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

  // ORDEM IMPORTA: estas checagens são por NOME DE FERRAMENTA e precisam vir
  // antes das genéricas. O texto real do yt-dlp quando falta o ffmpeg é
  // "...but ffmpeg is not installed", que casa com /not installed/ — se a
  // regra genérica viesse primeiro, a mensagem acusaria o yt-dlp (que está
  // instalado) e mandaria o usuário consertar a coisa errada.
  if (/\bffmpeg\b/.test(s)) {
    return ApiError.internal(
      'O servidor precisa do ffmpeg para cortar o trecho (o yt-dlp baixa o '
        + 'áudio, mas é o ffmpeg que recorta). No Termux: `pkg install ffmpeg`; '
        + 'em Debian/Ubuntu: `apt install ffmpeg`.',
      details,
    );
  }
  if (/\bdeno\b|javascript runtime/.test(s)) {
    return ApiError.internal(
      'O yt-dlp não achou um runtime de JavaScript (o YouTube exige um). '
        + 'Normalmente o servidor cai para o próprio Node automaticamente; se '
        + 'esta mensagem apareceu, defina YT_JS_RUNTIME (ex.: node:/caminho/node). '
        + 'No Termux, `pkg install deno` exige `pkg update && pkg upgrade` antes.',
      details,
    );
  }
  if (/no module named|module not found|cannot find module/.test(s)) {
    return ApiError.internal(
      'O yt-dlp não está instalado neste servidor (o Python não achou o módulo). '
        + 'No Termux: `pip install -U yt-dlp`; em Debian/Ubuntu: `pip install yt-dlp`.',
      details,
    );
  }
  if (/yt-dlp: (command )?not found|yt-dlp.*no such file|not installed|command not found|eacces|executable file not found/.test(s)) {
    return ApiError.internal(
      'Busca de música indisponível: o yt-dlp não está instalado neste servidor. '
        + 'No Termux: `pip install -U yt-dlp`; em Debian/Ubuntu: `pip install yt-dlp`.',
      details,
    );
  }
  if (/no supported javascript runtime|js runtime|ejs/.test(s)) {
    return ApiError.internal(
      'O yt-dlp não achou um runtime de JavaScript (o YouTube exige um). '
        + 'Defina YT_JS_RUNTIME (ex.: node:/caminho/node).',
      details,
    );
  }
  if (/sign in|confirm you.{0,3}re not a bot|cookies|bot\b|429|too many requests|403|forbidden/.test(s)) {
    // A mensagem diz QUAL é o estado do cookie: "configurei o secret e mesmo
    // assim bloqueou" é ambíguo entre (a) o servidor não recebeu o valor,
    // (b) recebeu malformado e (c) o YouTube rejeitou um cookie válido (aí o
    // cookie está expirado ou é de uma conta sem acesso). Sem isso o usuário
    // fica tentando as três às cegas.
    const cookie = cookieStatus();
    const hint = cookie === 'absent'
      ? 'Nenhum cookie chegou ao servidor — confira se YT_COOKIES está definido '
        + 'NAS VARIÁVEIS DO SERVIDOR (não só no repositório) e reinicie.'
      : cookie === 'malformed'
        ? 'O YT_COOKIES chegou mas está MALFORMADO (não decodifica como base64 '
          + 'de um cookie jar). Recopie o valor inteiro.'
        : 'O cookie FOI enviado ao YouTube, então ele foi rejeitado: exporte um '
          + 'cookies.txt NOVO, logado no youtube.com, e confirme que o arquivo '
          + 'tem linhas com TAB (formato Netscape).';
    return ApiError.internal(
      'O YouTube bloqueou o servidor (verificação anti-bot). ' + hint,
      { ...details, cookie },
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
 * Classifica o YT_COOKIES SEM revelar o valor (é credencial).
 *
 * Existe porque "configurei o secret e mesmo assim bloqueou" não dizia se o
 * servidor tinha recebido o valor, se ele estava truncado/malformado ou se o
 * YouTube rejeitou um cookie válido. Cada caso tem uma correção diferente.
 */
export type CookieStatus =
  | 'absent'
  | 'file'
  | 'raw-jar'
  | 'base64-jar'
  | 'malformed';

export function cookieStatus(): CookieStatus {
  const raw = (process.env.YT_COOKIES ?? '').trim();
  if (raw === '') {
    const file = (process.env.YT_COOKIES_FILE ?? '').trim();
    return file !== '' ? 'file' : 'absent';
  }
  if (/^#\s*(Netscape|HTTP Cookie File)/i.test(raw)) return 'raw-jar';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('\t')) {
      // Um jar de verdade tem a linha de cabeçalho OU várias linhas com TAB.
      return /^#\s*(Netscape|HTTP Cookie File)/i.test(decoded) ||
        decoded.split('\n').filter((l) => l.includes('\t')).length >= 1
        ? 'base64-jar'
        : 'malformed';
    }
  } catch {
    // Cai no malformed abaixo.
  }
  return 'malformed';
}

/** Descrição do cookie para o log — nunca o valor. */
export function cookieSummary(): string {
  const status = cookieStatus();
  switch (status) {
    case 'absent':
      return 'nenhum cookie configurado';
    case 'file':
      return 'YT_COOKIES_FILE configurado';
    case 'raw-jar':
      return 'YT_COOKIES recebido (formato Netscape, texto cru)';
    case 'base64-jar':
      return 'YT_COOKIES recebido (base64 decodificado com sucesso)';
    case 'malformed':
      return 'YT_COOKIES presente mas MALFORMADO (não é base64 de um cookie '
        + 'jar nem o formato Netscape) — verifique se o valor foi colado '
        + 'inteiro e sem truncamento';
  }
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
  // Aponta o ffmpeg EXPLICITAMENTE: no Termux ele pode estar instalado e
  // mesmo assim fora do PATH do processo (foi o caso relatado).
  const ffArgs = await ffmpegArgs();
  try {
    return await runProcess(
      command,
      [...cArgs, ...jsArgs, ...rcArgs, ...ffArgs, ...args],
      timeoutMs,
    );
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

/** Extrai os objetos JSON de uma saída do yt-dlp (uma linha por item). */
function parseYtdlpJsonLines(stdout: string): YtdlpJson[] {
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
  return items;
}

/** Argumentos comuns a toda consulta de metadados. */
function searchArgs(url: string): string[] {
  return [
    '--dump-json',
    '--ignore-errors',
    '--no-warnings',
    // A busca só quer METADADOS (título/artista/duração/capa). Alguns
    // resultados do YouTube Music não expõem formato baixável para o nosso
    // cliente, e sem esta flag o yt-dlp ABORTA o item com "Requested format
    // is not available" — o que derrubava a busca inteira mesmo com os
    // outros resultados disponíveis (bug relatado).
    '--ignore-no-formats-error',
    '--skip-download',
    '--playlist-end',
    String(PROFILE_MUSIC_RESULTS),
    url,
  ];
}

/** Converte os itens em resultados limpos, sem duplicatas. */
function toResults(items: YtdlpJson[]): MusicSearchResult[] {
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

/**
 * Busca músicas no YouTube Music, com FALLBACK em cadeia.
 *
 * O catálogo "songs" é o que remove vídeo aleatório (clipe, react, "top 10"),
 * então é sempre a PRIMEIRA tentativa. O problema é que ele devolve ZERO
 * resultados para algumas buscas perfeitamente válidas (ex.: "Queen") — de
 * forma reproduzível, não é rate-limit. Sem o fallback, uma busca legítima
 * virava "nenhuma música encontrada" (bug relatado).
 *
 * Ordem:
 *   1. catálogo de MÚSICAS do YouTube Music (melhor qualidade de resultado);
 *   2. YouTube Music sem o filtro (ainda prioriza faixas, menos curado);
 *   3. `ytsearch` (busca geral do YouTube) como último recurso.
 *
 * Só devolve lista vazia quando TODAS as tentativas voltarem vazias SEM erro
 * — assim uma falha real continua virando uma mensagem acionável.
 */
export async function searchProfileMusic(query: string): Promise<MusicSearchResult[]> {
  const q = query.trim();
  if (q.length === 0) throw ApiError.validation('Informe o nome da música.');
  if (q.length > 120) throw ApiError.validation('Busca muito longa.');

  const encoded = encodeURIComponent(q);
  const attempts = [
    `https://music.youtube.com/search?q=${encoded}&sp=${encodeURIComponent(YTM_SONGS_FILTER)}`,
    `https://music.youtube.com/search?q=${encoded}`,
    `ytsearch${PROFILE_MUSIC_RESULTS}:${q}`,
  ];

  let lastError: ApiError | null = null;
  for (const url of attempts) {
    const { code, stdout, stderr } = await runYtdlp(searchArgs(url), SEARCH_TIMEOUT_MS);
    const results = toResults(parseYtdlpJsonLines(stdout));
    if (results.length > 0) return results;
    if (code !== 0) {
      // Guarda o erro para o caso de TODAS falharem; uma tentativa que falha
      // não impede a próxima de dar certo.
      lastError = ytdlpFailureToApiError(stderr);
    }
  }

  // Nenhuma tentativa trouxe resultado. Se alguma deu erro, ele explica o
  // motivo; se todas responderam vazio, aí sim é "não achei".
  if (lastError) throw lastError;
  return [];
}

/**
 * Prévia de um trecho, para o usuário OUVIR antes de confirmar.
 *
 * Por que existe: o download definitivo só acontece na confirmação (para não
 * baixar enquanto o usuário ainda está arrastando as alças), então sem isto
 * ele escolheria a parte da música no escuro.
 *
 * O áudio é baixado UMA vez por faixa e reaproveitado: enquanto o usuário
 * ajusta a janela, só o recorte muda — baixar a faixa inteira a cada arrasto
 * seria desperdício e bateria no YouTube sem necessidade.
 *
 * Devolve o arquivo da FAIXA INTEIRA (o cliente toca a janela). É o mesmo
 * caminho do download sem ffmpeg, o que mantém uma única implementação de
 * "obter o áudio de um vídeo".
 */
export interface PreviewFile {
  path: string;
  /** Duração real do arquivo (ms), lida do container. */
  durationMs: number;
}

/**
 * Lê a duração de um m4a do cabeçalho `mvhd` (sem ffprobe).
 *
 * A prévia precisa da duração para o app limitar a janela: o servidor não
 * corta o arquivo (o recorte é no cliente), então a duração do ARQUIVO é o
 * limite superior de qualquer seleção. Best-effort: devolve 0 quando não
 * consegue ler, e o app cai para a duração informada na busca.
 */
export async function readM4aDurationMs(file: string): Promise<number> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      // Varre os boxes de topo até achar `moov` (onde vive o `mvhd`).
      let offset = 0;
      const header = Buffer.alloc(8);
      for (let i = 0; i < 64; i++) {
        const read = await handle.read(header, 0, 8, offset);
        if (read.bytesRead < 8) break;
        const size = header.readUInt32BE(0);
        const type = header.subarray(4, 8).toString('latin1');
        if (size < 8) break;
        if (type === 'moov') {
          // Dentro do moov, procura o mvhd.
          const moov = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
          await handle.read(moov, 0, moov.length, offset + 8);
          const idx = moov.indexOf('mvhd', 0, 'latin1');
          if (idx === -1) return 0;
          const version = moov[idx + 4];
          const timescale = version === 1
            ? moov.readUInt32BE(idx + 8 + 16)
            : moov.readUInt32BE(idx + 4 + 8);
          const duration = version === 1
            ? Number(moov.readBigUInt64BE(idx + 8 + 20))
            : moov.readUInt32BE(idx + 4 + 12);
          if (!timescale) return 0;
          return Math.round((duration / timescale) * 1000);
        }
        offset += size;
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort.
  }
  return 0;
}

/** Cache de faixas já baixadas para prévia (sourceId → arquivo). */
const previewCache = new Map<string, string>();

/** Limite de faixas em cache (cada uma pode ter alguns MB). */
const PREVIEW_CACHE_MAX = 5;

/**
 * Garante que a faixa esteja baixada para prévia e devolve o caminho do
 * arquivo. Baixa a faixa INTEIRA (uma vez) para o cliente recortar a janela
 * localmente enquanto o usuário arrasta.
 */
export async function ensurePreviewFile(sourceId: string): Promise<PreviewFile> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(sourceId)) {
    throw ApiError.validation('Música inválida.');
  }

  const cached = previewCache.get(sourceId);
  if (cached) {
    try {
      await fs.access(cached);
      return { path: cached, durationMs: await readM4aDurationMs(cached) };
    } catch {
      previewCache.delete(sourceId);
    }
  }

  const dir = path.resolve(process.cwd(), 'uploads', 'music', 'preview');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${sourceId}.m4a`);

  // Se o ffmpeg existir, usamos o caminho que baixa direto em m4a sem
  // conversão (formato 140); com ffmpeg também é válido, só não recortamos
  // aqui — a prévia é uma faixa por vez, o recorte fica no cliente.
  const args = [
    '--no-warnings',
    '--no-playlist',
    '-f',
    '140/ba[ext=m4a]/ba',
    '--max-filesize',
    String(MAX_PROFILE_MUSIC_BYTES),
    '-o',
    dest,
    `https://www.youtube.com/watch?v=${sourceId}`,
  ];

  const { code, stderr } = await runYtdlp(args, DOWNLOAD_TIMEOUT_MS);
  if (code !== 0) {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    throw ytdlpFailureToApiError(stderr);
  }

  const stat = await fs.stat(dest).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    throw ApiError.internal('Não foi possível carregar a prévia. Tente novamente.');
  }

  // Mesma validação do download definitivo: os bytes têm de ser um container
  // de áudio real, não um HTML de erro salvo como .m4a.
  const head = Buffer.alloc(12);
  const handle = await fs.open(dest, 'r');
  try {
    await handle.read(head, 0, 12, 0);
  } finally {
    await handle.close();
  }
  if (head.subarray(4, 8).toString('latin1') !== 'ftyp') {
    await fs.rm(dest, { force: true }).catch(() => void 0);
    throw ApiError.internal('A prévia baixada não é um áudio válido.');
  }

  previewCache.set(sourceId, dest);
  // Cache simples: descarta o mais antigo quando passa do limite.
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
    await fs.rm(path.join(dir, `${oldest}.m4a`), { force: true }).catch(() => void 0);
  }

  return { path: dest, durationMs: await readM4aDurationMs(dest) };
}

/** Remove os arquivos de prévia (chamado na limpeza de mídia). */
export async function purgePreviewFiles(): Promise<void> {
  previewCache.clear();
  const dir = path.resolve(process.cwd(), 'uploads', 'music', 'preview');
  await fs.rm(dir, { recursive: true, force: true }).catch(() => void 0);
}

export interface StoredProfileMusicFile {
  url: string;
  bytes: number;
  /**
   * True quando o arquivo é a FAIXA INTEIRA e o app deve tocar apenas a
   * janela [startMs, startMs+durationMs). Acontece no caminho SEM ffmpeg:
   * em vez de recortar no servidor, o player começa no offset e para no fim
   * do trecho. O usuário ouve exatamente o mesmo trecho.
   */
  playWindowOnly?: boolean;
}

/**
 * Baixa o áudio do vídeo e devolve a URL do arquivo.
 *
 * DOIS CAMINHOS, de propósito:
 *
 *  A) COM ffmpeg — baixa só o TRECHO (`--download-sections`) e recodifica em
 *     m4a. Menos banda e menos disco. É o caminho preferido.
 *
 *  B) SEM ffmpeg — baixa a faixa inteira em m4a (formato 140, que já é AAC
 *     num container MP4, sem precisar de conversão) e marca
 *     `playWindowOnly`. O ffmpeg é o item MAIS FRÁGIL do Termux (~50 pacotes,
 *     costuma falhar e deixar instalação parcial), então o recurso não pode
 *     depender dele para existir. Sem este caminho, "não tenho ffmpeg"
 *     significava "a música do perfil não funciona" — que era o seu caso.
 *
 * A validação de tamanho é mais rígida no caminho B (a faixa é maior), e os
 * bytes continuam sendo validados como container de áudio real.
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

  const hasFfmpeg = (await findFfmpegDir()) !== null;
  const args = hasFfmpeg
    ? [
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
      ]
    : [
        '--no-warnings',
        '--no-playlist',
        // Formato 140 = m4a/AAC servido pronto pelo YouTube: nenhuma
        // conversão, portanto nenhum ffmpeg. Se o vídeo não tiver 140, o
        // fallback `ba` ainda evita a etapa de merge (que exigiria ffmpeg).
        '-f',
        '140/ba[ext=m4a]/ba',
        '--max-filesize',
        String(MAX_PROFILE_MUSIC_BYTES),
        '-o',
        dest,
        `https://www.youtube.com/watch?v=${sourceId}`,
      ];

  const { code, stderr } = await runYtdlp(args, DOWNLOAD_TIMEOUT_MS);

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

  return {
    url: `${publicBase()}/static/music/${stem}.m4a`,
    bytes: stat.size,
    // Sem ffmpeg o arquivo é a faixa inteira: o app toca só a janela.
    ...(hasFfmpeg ? {} : { playWindowOnly: true }),
  };
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
