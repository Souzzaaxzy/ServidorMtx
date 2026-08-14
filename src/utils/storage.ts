import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { env } from '../config/env.js';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ApiError } from './errors.js';

export interface StorageProvider {
  save(buffer: Buffer, ext: string): Promise<string>;
  delete(url: string): Promise<void>;
}

const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

export class LocalStorageProvider implements StorageProvider {
  async save(buffer: Buffer, ext: string): Promise<string> {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
    const name = `${randomBytes(16).toString('hex')}.${ext}`;
    const fullPath = path.join(UPLOAD_ROOT, name);
    await fs.writeFile(fullPath, buffer);

    const publicBase = env.storage.publicBaseUrl
      ? env.storage.publicBaseUrl.replace(/\/$/, '')
      : `http://localhost:${env.port}`;
    return `${publicBase}/static/${name}`;
  }

  async delete(url: string): Promise<void> {
    const fileName = url.split('/static/')[1];
    if (!fileName) return;
    const fullPath = path.join(UPLOAD_ROOT, fileName);
    try {
      await fs.unlink(fullPath);
    } catch {
      // File may not exist; ignore.
    }
  }
}

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private publicBaseUrl: string;

  constructor() {
    this.client = new S3Client({
      endpoint: env.storage.endpoint,
      region: env.storage.region,
      forcePathStyle: env.storage.forcePathStyle,
      credentials: {
        accessKeyId: env.storage.accessKey,
        secretAccessKey: env.storage.secretKey,
      },
    });
    this.bucket = env.storage.bucket;
    const base = env.storage.publicBaseUrl?.replace(/\/$/, '');
    if (!base) {
      throw new Error('STORAGE_PUBLIC_BASE_URL is required when using S3 storage');
    }
    this.publicBaseUrl = base;
  }

  async save(buffer: Buffer, ext: string): Promise<string> {
    const key = `${randomBytes(16).toString('hex')}.${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
      }),
    );
    return `${this.publicBaseUrl}/${key}`;
  }

  async delete(url: string): Promise<void> {
    const key = url.replace(`${this.publicBaseUrl}/`, '');
    if (!key || key === url) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // Best-effort deletion.
    }
  }
}

export function createStorageProvider(): StorageProvider {
  if (env.storage.useLocal) {
    return new LocalStorageProvider();
  }
  return new S3StorageProvider();
}

let _provider: StorageProvider | null = null;
export function getStorage(): StorageProvider {
  if (!_provider) _provider = createStorageProvider();
  return _provider;
}

// ── File validation ───────────────────────────────────────────
// Never trust the extension. Validate the actual bytes.

const MAGIC_BYTES: Record<string, RegExp> = {
  jpg: /^ffd8ff/,
  png: /^89504e470d0a1a0a/i,
  webp: /^52494646.{8}57454250/i, // RIFF....WEBP
};

export function detectImageExtension(buffer: Buffer): string {
  const hex = buffer.subarray(0, 16).toString('hex');
  for (const [ext, re] of Object.entries(MAGIC_BYTES)) {
    if (re.test(hex)) return ext;
  }
  throw ApiError.unsupportedMediaType();
}

export function validateImageBuffer(buffer: Buffer): string {
  if (buffer.length === 0) {
    throw ApiError.invalidRequest('Arquivo vazio.');
  }
  if (buffer.length > env.maxUploadBytes) {
    throw ApiError.payloadTooLarge();
  }
  return detectImageExtension(buffer);
}
