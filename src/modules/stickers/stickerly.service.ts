import { createHash } from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { getStorage, validateImageBuffer } from '../../utils/storage.js';
import type { ImportStickerResult } from './sticker.service.js';
import { getStickerPackage } from './sticker.service.js';

// ── Importação de pacotes do Sticker.ly ──────────────────────
//
// O Sticker.ly (com.snowcorp.stickerly / NAVER Z) compartilha pacotes por
// código (`https://sticker.ly/s/<CÓDIGO>`). O app oficial consulta o serviço
// em `api.sticker.ly` — NÃO há uma API pública documentada; este é o mesmo
// endpoint usado pelo app, então tratamos como fonte externa instável:
//  * a base é configurável (STICKERLY_API_BASE) para poder mudar sem
//    publicar um novo APK;
//  * toda chamada tem timeout curto e erros viram mensagens amigáveis;
//  * o conteúdo baixado é tratado SOMENTE como dados (magic bytes + limites
//    de tamanho/quantidade), nunca executado;
//  * nada de credenciais no APK — o download acontece AQUI, no servidor.

/** Base do serviço do Sticker.ly (configurável por ambiente). */
const STICKERLY_API_BASE = (
  process.env.STICKERLY_API_BASE ?? 'https://api.sticker.ly'
).replace(/\/+$/, '');

/**
 * User-Agent do app oficial. O serviço responde a este UA; sem ele alguns
 * recursos mudam de formato. É informação pública (aparece no APK oficial),
 * não uma credencial.
 */
const STICKERLY_USER_AGENT =
  'androidapp.stickerly/1.13.3 (Linux; U; Android 13; pt-BR; br;)';

/** Timeout de cada requisição à fonte externa. */
const FETCH_TIMEOUT_MS = 15_000;

/** Limites de segurança do pacote importado. */
export const STICKERLY_MAX_STICKERS = 60;
export const STICKERLY_MAX_FILE_BYTES = 5 * 1024 * 1024; // espelha MAX_UPLOAD_BYTES
export const STICKERLY_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
/** Downloads simultâneos — gentil com a fonte e com a memória do servidor. */
const DOWNLOAD_CONCURRENCY = 4;

export interface StickerlySticker {
  url: string;
  width: number | null;
  height: number | null;
}

export interface StickerlyPack {
  code: string;
  name: string;
  author: string;
  stickerCount: number;
  animated: boolean;
  /** Capa: o Sticker.ly não expõe ícone de bandeja separado → 1ª figurinha. */
  iconUrl: string;
  shareUrl: string;
  stickers: StickerlySticker[];
}

/**
 * Aceita um código puro (`QSXLKY`), um link de compartilhamento
 * (`https://sticker.ly/s/QSXLKY`) ou um link com parâmetros e devolve o
 * código normalizado. Lança 400 quando o formato não é reconhecido.
 */
export function parseStickerlyCode(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw ApiError.validation('Informe o código do pacote do Sticker.ly.');
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw ApiError.validation('Informe o código do pacote do Sticker.ly.');
  }

  // Link (sticker.ly/s/CODE) → extrai o código.
  const fromUrl = /sticker\.ly\/s\/([A-Za-z0-9]+)/i.exec(value);
  const candidate = (fromUrl?.[1] ?? value).toUpperCase();

  // Códigos do Sticker.ly são alfanuméricos (maiúsculas), 4–16 caracteres.
  if (!/^[A-Z0-9]{4,16}$/.test(candidate)) {
    throw ApiError.validation(
      'Código inválido. Use o código do pacote (ex.: QSXLKY) ou o link de compartilhamento.',
    );
  }
  return candidate;
}

/** GET com timeout curto na fonte externa. */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': STICKERLY_USER_AGENT,
        Accept: 'application/json, */*',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw ApiError.internal(
        'O Sticker.ly não respondeu a tempo. Tente novamente.',
      );
    }
    throw ApiError.internal(
      'Não foi possível falar com o Sticker.ly. Tente novamente.',
    );
  } finally {
    clearTimeout(timer);
  }
}

interface StickerlyRawSticker {
  fileName?: unknown;
}

interface StickerlyRawResult {
  name?: unknown;
  authorName?: unknown;
  owner?: unknown;
  packId?: unknown;
  shareUrl?: unknown;
  resourceUrlPrefix?: unknown;
  animated?: unknown;
  isAnimated?: unknown;
  isPaid?: unknown;
  stickers?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Busca um pacote na fonte externa e normaliza o resultado. Nunca devolve
 * dados não validados: exige prefixo de recursos http(s), nomes de arquivo
 * seguros e ao menos uma figurinha.
 */
export async function fetchStickerlyPack(code: string): Promise<StickerlyPack> {
  const res = await fetchWithTimeout(
    `${STICKERLY_API_BASE}/v3.1/stickerPack/${encodeURIComponent(code)}`,
  );

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw ApiError.internal('O Sticker.ly devolveu uma resposta inválida.');
  }

  const result = (payload as { result?: StickerlyRawResult })?.result;
  if (!res.ok || !result) {
    // A fonte responde 200 com {error:{...}} para pacotes inexistentes.
    throw ApiError.notFound(
      'Não foi possível encontrar esse pacote. Confira o código e tente novamente.',
    );
  }

  if (result.isPaid === true) {
    throw ApiError.forbidden(
      'Este pacote é pago e não pode ser importado.',
    );
  }

  const prefix = asString(result.resourceUrlPrefix);
  if (!/^https?:\/\//i.test(prefix)) {
    throw ApiError.internal('Pacote com endereço de recursos inválido.');
  }

  const rawStickers = Array.isArray(result.stickers) ? result.stickers : [];
  const stickers: StickerlySticker[] = [];
  for (const item of rawStickers) {
    const fileName = asString((item as StickerlyRawSticker)?.fileName);
    // Só nomes simples e sufixo de imagem conhecido — nada de caminho.
    if (!fileName || !isSafeFileSegment(fileName)) continue;
    if (!/\.(webp|png|jpe?g)$/i.test(fileName)) continue;
    stickers.push({ url: `${prefix}${fileName}`, width: null, height: null });
    if (stickers.length >= STICKERLY_MAX_STICKERS) break;
  }

  if (stickers.length === 0) {
    throw ApiError.notFound(
      'Este pacote não tem figurinhas compatíveis com o MATRIX.',
    );
  }

  const name = asString(result.name).trim().slice(0, 40);
  const author =
    asString(result.authorName).trim() ||
    asString(result.owner).trim() ||
    'Sticker.ly';

  return {
    code,
    name: name || `Pacote ${code}`,
    author: author.slice(0, 60),
    stickerCount: stickers.length,
    animated: result.animated === true || result.isAnimated === true,
    iconUrl: stickers[0].url,
    shareUrl: asString(result.shareUrl) || `https://sticker.ly/s/${code}`,
    stickers,
  };
}

/** Nome de arquivo simples (sem separadores, sem `..`). */
function isSafeFileSegment(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  return name.length > 0 && name.length <= 128;
}

/** Baixa um arquivo da fonte com timeout e teto de tamanho. */
async function downloadSticker(url: string): Promise<Buffer> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw ApiError.internal('Falha ao baixar uma figurinha do pacote.');
  }
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > STICKERLY_MAX_FILE_BYTES) {
    throw ApiError.payloadTooLarge('Uma figurinha do pacote é grande demais.');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > STICKERLY_MAX_FILE_BYTES) {
    throw ApiError.payloadTooLarge('Uma figurinha do pacote é grande demais.');
  }
  return bytes;
}

/**
 * Executa [worker] sobre [items] com concorrência limitada, preservando a
 * ordem. Mantém a memória sob controle em pacotes grandes.
 */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Pacote já importado por este usuário a partir da mesma fonte. */
export async function findExistingStickerlyPackage(
  userId: string,
  code: string,
): Promise<{ id: string; name: string; installed: boolean } | null> {
  const pkg = await prisma.stickerPackage.findFirst({
    where: { source: 'stickerly', sourceId: code, authorId: userId },
    orderBy: { createdAt: 'asc' },
  });
  if (!pkg) return null;
  const install = await prisma.userStickerPackage.findUnique({
    where: { userId_packageId: { userId, packageId: pkg.id } },
    select: { packageId: true },
  });
  return { id: pkg.id, name: pkg.name, installed: install !== null };
}

/**
 * Importa um pacote do Sticker.ly para a coleção do usuário.
 *
 * Fluxo: consulta a fonte → baixa os arquivos (concorrência limitada) →
 * valida os BYTES reais (nunca a extensão) → guarda no armazenamento padrão →
 * cria um pacote DO usuário com dedupe por SHA-256 → instala. Reimportar o
 * mesmo código não duplica nada.
 */
export async function importStickerlyPack(
  userId: string,
  code: string,
): Promise<ImportStickerResult & { alreadyInstalled: boolean }> {
  const existing = await findExistingStickerlyPackage(userId, code);
  if (existing) {
    return {
      package: await getStickerPackage(userId, existing.id),
      created: 0,
      skipped: 0,
      alreadyInstalled: true,
    };
  }

  const pack = await fetchStickerlyPack(code);

  const storage = getStorage();
  let totalBytes = 0;

  const downloaded = await mapLimited(
    pack.stickers,
    DOWNLOAD_CONCURRENCY,
    async (sticker) => {
      const bytes = await downloadSticker(sticker.url);
      totalBytes += bytes.length;
      if (totalBytes > STICKERLY_MAX_TOTAL_BYTES) {
        throw ApiError.payloadTooLarge('O pacote é grande demais para importar.');
      }
      // Valida os magic bytes reais (webp/png/jpeg) — nunca a extensão.
      const ext = validateImageBuffer(bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const url = await storage.save(bytes, ext);
      const size = readImageSize(bytes, ext);
      return {
        url,
        hash,
        width: size?.width ?? null,
        height: size?.height ?? null,
      };
    },
  );

  // Dedupe por hash no escopo do usuário (mesma regra do compartilhamento).
  const hashes = downloaded.map((d) => d.hash);
  const alreadyOwned = await prisma.sticker.findMany({
    where: { authorId: userId, hash: { in: hashes } },
    select: { hash: true },
  });
  const ownedHashes = new Set(
    alreadyOwned.map((r) => r.hash).filter((h): h is string => !!h),
  );

  const seen = new Set<string>();
  const toCreate = downloaded.filter((d) => {
    if (ownedHashes.has(d.hash) || seen.has(d.hash)) return false;
    seen.add(d.hash);
    return true;
  });
  const skipped = downloaded.length - toCreate.length;

  if (toCreate.length === 0) {
    return { package: null, created: 0, skipped, alreadyInstalled: false };
  }

  const pkg = await prisma.stickerPackage.create({
    data: {
      name: pack.name,
      slug: `${slugifyName(pack.name)}-${code.toLowerCase()}-${randomSuffix()}`,
      description: `Importado do Sticker.ly (${pack.author}).`,
      author: pack.author,
      iconUrl: toCreate[0].url,
      active: true,
      authorId: userId,
      source: 'stickerly',
      sourceId: code,
      stickers: {
        create: toCreate.map((item, index) => ({
          order: index,
          fileUrl: item.url,
          hash: item.hash,
          width: item.width,
          height: item.height,
          authorId: userId,
        })),
      },
    },
  });

  await prisma.userStickerPackage.upsert({
    where: { userId_packageId: { userId, packageId: pkg.id } },
    update: {},
    create: { userId, packageId: pkg.id },
  });

  return {
    package: await getStickerPackage(userId, pkg.id),
    created: toCreate.length,
    skipped,
    alreadyInstalled: false,
  };
}

function slugifyName(value: string): string {
  const clean = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return clean || 'stickerly';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ── Dimensões a partir dos bytes (sem decoder de imagem) ─────
// Usado só para informar a proporção no app; a imagem nunca é decodificada
// nem executada. Retorna null quando o cabeçalho não é reconhecido.

export function readImageSize(
  buffer: Buffer,
  ext: string,
): { width: number; height: number } | null {
  if (ext === 'png') return readPngSize(buffer);
  if (ext === 'webp') return readWebpSize(buffer);
  return null;
}

function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  // Assinatura (8) + tamanho do chunk IHDR (4) + tipo "IHDR" (4).
  if (buffer.length < 24) return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return validSize(width, height);
}

function readWebpSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  const chunk = buffer.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    // Canvas estendido: 24 bits little-endian, menos 1.
    const w = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const h = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return validSize(w, h);
  }
  if (chunk === 'VP8 ') {
    // Frame lossy: dimensões nos bytes 26..29 (14 bits cada).
    const w = buffer.readUInt16LE(26) & 0x3fff;
    const h = buffer.readUInt16LE(28) & 0x3fff;
    return validSize(w, h);
  }
  if (chunk === 'VP8L') {
    // Frame lossless: 14 bits cada, empacotados a partir do byte 21.
    const bits =
      buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return validSize(w, h);
  }
  return null;
}

function validSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096
  ) {
    return null;
  }
  return { width, height };
}

/** Configuração efetiva (útil para diagnóstico/testes). */
export const stickerlyConfig = {
  apiBase: STICKERLY_API_BASE,
  userAgent: STICKERLY_USER_AGENT,
  timeoutMs: FETCH_TIMEOUT_MS,
  maxBytesPerFile: STICKERLY_MAX_FILE_BYTES,
  maxTotalBytes: STICKERLY_MAX_TOTAL_BYTES,
  maxStickers: STICKERLY_MAX_STICKERS,
};
