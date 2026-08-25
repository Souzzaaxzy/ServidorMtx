import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';
import { validateImageBuffer } from '../../utils/storage.js';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

// Only formats whose magic bytes we actually verify are accepted — the
// client-supplied MIME/extension is NEVER trusted on its own.
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Strips any path components from a filename to prevent traversal. */
function sanitizeFilename(name: string): string {
  const base = path.basename(name).toLowerCase();
  const ext = path.extname(base);
  if (!ALLOWED_EXT.has(ext)) {
    throw ApiError.validation('Tipo de arquivo não permitido. Use PNG, JPG ou WebP.');
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

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// Public base for uploaded-file URLs. Prefer the explicit storage URL;
// fall back to the API's own public URL so the APK receives an ABSOLUTE
// http(s) URL it can load directly. When neither is configured the path
// stays relative (/static/...) and the app resolves it against the API
// base URL — never a localhost/internal path.
function publicBase(): string {
  return (env.storage.publicBaseUrl || env.publicApiUrl || '').replace(/\/$/, '');
}

export async function saveLocalFile(
  filename: string,
  mimetype: string,
  stream: Readable,
): Promise<StoredFile> {
  if (!ALLOWED_MIME.has(mimetype)) {
    throw ApiError.validation('Tipo de arquivo não permitido. Use PNG, JPG ou WebP.');
  }
  const safe = sanitizeFilename(filename);

  const buffer = await readStream(stream);
  // Validate the real bytes (magic numbers), not the declared type, and
  // enforce the size limit. Throws 415/413/400 on invalid content.
  validateImageBuffer(buffer);

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const dest = path.join(UPLOAD_DIR, safe);
  await fs.writeFile(dest, buffer);

  const url = `${publicBase()}/static/${safe}`;
  return { filename: safe, mimetype, size: buffer.length, url };
}

/**
 * Best-effort deletion of a locally stored upload referenced by a
 * `/static/<file>` URL (relative or absolute). Only the basename is used and
 * the resolved path is verified to stay inside the upload directory, so a
 * crafted URL can never reach outside it. URLs that don't point to a local
 * /static file are ignored.
 */
export async function deleteLocalFileByUrl(url: string): Promise<void> {
  const marker = '/static/';
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const name = path.basename(url.slice(idx + marker.length));
  if (!name) return;
  const fullPath = path.join(UPLOAD_DIR, name);
  if (path.dirname(fullPath) !== UPLOAD_DIR) return;
  try {
    await fs.unlink(fullPath);
  } catch {
    // File may already be gone — deletion is best-effort.
  }
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
