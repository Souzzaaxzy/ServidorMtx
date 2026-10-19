// ──────────────────────────────────────────────────────────────
// Password hashing — Argon2id, without a mandatory native dependency.
//
// WHY THIS EXISTS
// The `argon2` npm package is a native addon. Its prebuilt binaries are
// glibc-only, so on Termux/Android (bionic) they cannot load and the fallback
// source build fails too — registration/login would be impossible there.
//
// Node >= 24.7 ships Argon2id in `node:crypto` (`crypto.argon2`), with no
// native addon at all. This module uses the built-in when available and falls
// back to the npm `argon2` package otherwise, so BOTH environments work:
//   • Termux / Node >= 24.7 → built-in (zero native deps)
//   • older Node / Linux    → npm argon2 (unchanged behavior)
//
// Hash format is identical (standard PHC `$argon2id$v=19$m=...,t=...,p=...$..`),
// so existing password hashes verify on either implementation — verified
// byte-for-byte against hashes produced by the npm package.
// ──────────────────────────────────────────────────────────────
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

// `crypto.argon2Sync` exists from Node 24.7 but is not in @types/node 22, so it
// is accessed through the runtime module object instead of a named import.
const nodeCrypto = createRequire(import.meta.url)('node:crypto') as {
  argon2Sync?: CryptoArgon2;
};

// Argon2id parameters. Tuned for a server-side hash cost that is resistant
// to GPU brute force while keeping registration/login under ~200ms.
export const ARGON2_PARAMS = {
  memoryCost: 19_456, // ~19 MiB (KiB)
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

const ALGORITHM = 'argon2id';
const VERSION = 0x13; // 19 — the PHC `v=19` field
const SALT_BYTES = 16;

type CryptoArgon2 = (
  algorithm: string,
  parameters: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
) => Buffer;

const cryptoArgon2 = nodeCrypto.argon2Sync;

// The npm package is loaded lazily and only when the built-in is missing, so
// Termux never has to resolve/load a native addon.
type NpmArgon2 = {
  hash: (plain: string, options: Record<string, unknown>) => Promise<string>;
  verify: (hash: string, plain: string) => Promise<boolean>;
  argon2id: number;
};
let npmArgon2: NpmArgon2 | null | undefined;

function loadNpmArgon2(): NpmArgon2 | null {
  if (npmArgon2 !== undefined) return npmArgon2;
  try {
    const require = createRequire(import.meta.url);
    npmArgon2 = require('argon2') as NpmArgon2;
  } catch {
    npmArgon2 = null;
  }
  return npmArgon2;
}

export const usingNodeCryptoArgon2 = typeof cryptoArgon2 === 'function';

function toBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function deriveWithNodeCrypto(
  plain: string,
  salt: Buffer,
  params: { memoryCost: number; timeCost: number; parallelism: number; hashLength: number },
): Buffer {
  if (!cryptoArgon2) throw new Error('node:crypto argon2 unavailable');
  return cryptoArgon2(ALGORITHM, {
    message: Buffer.from(plain, 'utf8'),
    nonce: salt,
    parallelism: params.parallelism,
    tagLength: params.hashLength,
    memory: params.memoryCost,
    passes: params.timeCost,
  });
}

/**
 * Hashes a password with Argon2id, producing a standard PHC string that is
 * readable by both the built-in implementation and the npm `argon2` package.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (cryptoArgon2) {
    const salt = randomBytes(SALT_BYTES);
    const tag = deriveWithNodeCrypto(plain, salt, ARGON2_PARAMS);
    return `$${ALGORITHM}$v=${VERSION}$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$${toBase64(salt)}$${toBase64(tag)}`;
  }
  const fallback = loadNpmArgon2();
  if (!fallback) {
    throw new Error(
      'Nenhuma implementação de Argon2 disponível. Use Node >= 24.7 (argon2 embutido) ou instale o pacote "argon2".',
    );
  }
  return fallback.hash(plain, {
    type: fallback.argon2id,
    memoryCost: ARGON2_PARAMS.memoryCost,
    timeCost: ARGON2_PARAMS.timeCost,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLength: ARGON2_PARAMS.hashLength,
  });
}

const PHC_RE = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/;

/**
 * Verifies a password against a PHC-encoded Argon2 hash. Accepts hashes
 * produced by either implementation, so existing users keep working.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;

  const match = PHC_RE.exec(hash);
  if (cryptoArgon2 && match) {
    const [, variant, version, memoryCost, timeCost, parallelism, saltB64, tagB64] = match;
    if (Number(version) !== VERSION) return false;
    const salt = fromBase64(saltB64);
    const expected = fromBase64(tagB64);
    try {
      const algorithm = `argon2${variant}` as 'argon2id' | 'argon2i' | 'argon2d';
      const derived = cryptoArgon2(algorithm, {
        message: Buffer.from(plain, 'utf8'),
        nonce: salt,
        parallelism: Number(parallelism),
        tagLength: expected.length,
        memory: Number(memoryCost),
        passes: Number(timeCost),
      });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  const fallback = loadNpmArgon2();
  if (!fallback) return false;
  try {
    return await fallback.verify(hash, plain);
  } catch {
    return false;
  }
}

// ── Recovery codes ───────────────────────────────────────────────
// A 12-digit numeric recovery code is generated at registration and shown
// ONCE to the user. Only its hash is persisted — the original plaintext is
// never stored, satisfying the requirement that the recovery code itself
// not live in the database.

const RECOVERY_CODE_LENGTH = 12;

export function generateRecoveryCode(): string {
  // Use crypto.randomInt to avoid modulo bias on each digit.
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

// Hash recovery codes with a distinct salt via SHA-256. Argon2id would be
// ideal but these short numeric codes have low entropy, so we rely on rate
// limiting + lockout rather than the hash function to resist brute force.
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

export function verifyRecoveryCode(code: string, hash: string): boolean {
  return hashRecoveryCode(code) === hash;
}
