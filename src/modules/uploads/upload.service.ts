import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

/** Strips any path components from a filename to prevent traversal. */
function sanitizeFilename(name: string): string {
  const base = path.basename(name).toLowerCase();
  const ext = path.extname(base);
  if (!ALLOWED_EXT.has(ext)) {
    throw ApiError.validation('Tipo de arquivo não permitido.');
  }
  const stem = base.slice(0, base.length - ext.length).replace(/[^a-z0-9_-]+/g, '_');
  return `${stem || 'file'}-${randomBytes(6).toString('hex')}${ext}`;
}

export interface StoredFile {
  filename: string;
  mimetype: string;
  size: number;
  url: string;
}

export async function saveLocalFile(
  filename: string,
  mimetype: string,
  stream: Readable,
): Promise<StoredFile> {
  if (!ALLOWED_MIME.has(mimetype)) {
    throw ApiError.validation('Tipo de arquivo não permitido.');
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const safe = sanitizeFilename(filename);
  const dest = path.join(UPLOAD_DIR, safe);

  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', async () => {
      try {
        await fs.writeFile(dest, Buffer.concat(chunks));
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    stream.on('error', reject);
  });

  const stat = await fs.stat(dest);
  const url = `${env.storage.publicBaseUrl || ''}/static/${safe}`;
  return { filename: safe, mimetype, size: stat.size, url };
}

/**
 * Stores an uploaded file. Uses local filesystem when no S3-compatible
 * endpoint is configured (env.storage.useLocal). The S3 path is a stub for
 * a future implementation — the local path is the default.
 */
export async function storeUpload(
  filename: string,
  mimetype: string,
  stream: Readable,
): Promise<StoredFile> {
  if (!env.storage.useLocal) {
    // S3/R2 integration is intentionally not implemented yet.
    // Fall back to local storage so uploads keep working out of the box.
    return saveLocalFile(filename, mimetype, stream);
  }
  return saveLocalFile(filename, mimetype, stream);
}
