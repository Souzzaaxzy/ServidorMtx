// ──────────────────────────────────────────────────────────────
// Public sequential account ids (`#00000001`).
//
// Every account gets a short, human-friendly number that can be used to FIND
// or LOG INTO it. The number is:
//   • sequential and formatted with 8 digits, zero-padded on the left;
//   • NEVER reused — deleting an account retires its number for good, so a
//     given `#id` always refers to the same person (or to nobody).
//
// Why an explicit allocator instead of SQLite's AUTOINCREMENT: Prisma only
// allows `autoincrement()` on the `@id` field, and this model's `@id` is a
// cuid. A dedicated `user_ids` row (single row, `next` = last allocated
// number) gives the same monotonic guarantee while keeping cuids as the
// internal identity used by every relation.
// ──────────────────────────────────────────────────────────────
import { prisma } from '../config/prisma.js';

/** Number of digits in the public id (`#00000001`). */
export const PUBLIC_ID_DIGITS = 8;

/** Formats a numeric id as the public `#00000001` form. */
export function formatPublicId(publicId: number): string {
  return `#${String(publicId).padStart(PUBLIC_ID_DIGITS, '0')}`;
}

/**
 * Parses a public id in any accepted shape → the number, or null.
 *
 * Accepts `#12345678`, `12345678` and `#1234` (fewer digits are fine when
 * typed by a human; the leading zeros are cosmetic). Returns null when the
 * input is not a plain positive integer, so callers can fall back to
 * nickname lookup.
 */
export function parsePublicId(raw: string): number | null {
  const trimmed = raw.trim();
  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^\d{1,9}$/.test(digits)) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Reserves and returns the next public id.
 *
 * Must be called INSIDE the same transaction that creates the user, so a
 * failed registration never burns a number into a gap. The increment happens
 * before reading, so the first account is 1 (`#00000001`).
 *
 * `tx` is the Prisma transaction client; the type is kept structural so this
 * helper stays independent of the generated client's exact shape.
 */
export async function allocatePublicId(tx: {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T>;
}): Promise<number> {
  await tx.$executeRawUnsafe('UPDATE "user_ids" SET "next" = "next" + 1');
  const rows = await tx.$queryRawUnsafe<{ next: number }[]>(
    'SELECT "next" FROM "user_ids"',
  );
  const next = rows[0]?.next;
  if (typeof next !== 'number') {
    throw new Error(
      'Falha ao alocar o id público: a tabela "user_ids" está vazia ou inacessível.',
    );
  }
  return next;
}

/**
 * Allocates a public id on its own (non-transactional) connection.
 * Used by the seed and by any caller that is not already in a transaction.
 */
export async function allocatePublicIdStandalone(): Promise<number> {
  return allocatePublicId(prisma);
}
