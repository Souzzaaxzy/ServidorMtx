// ──────────────────────────────────────────────────────────────
// Offline migration runner for SQLite (no Prisma schema engine).
//
// WHY THIS EXISTS
// `prisma migrate deploy` cannot run on Android/Termux. The Prisma CLI
// downloads a NATIVE `schema-engine` binary and executes it, and Prisma ships
// no Android/bionic build — so the CLI fails with "Schema engine error" /
// `is for EM_X86_64 instead of EM_AARCH64`. Setting `engineType = "client"`
// only makes the *Client* Rust-free; the CLI still needs the engine.
//
// This runner applies the SAME `prisma/migrations/*/migration.sql` files using
// the built-in `node:sqlite` module, and writes the SAME `_prisma_migrations`
// bookkeeping table that Prisma uses (verified byte-for-byte against a DB
// migrated by `prisma migrate deploy`):
//   • checksum  = sha256 of migration.sql
//   • id        = random UUID
//   • timestamps = epoch-milliseconds INTEGER (Prisma's SQLite DateTime format)
//   • applied_steps_count = 1
// Because the bookkeeping is identical, the two runners are interchangeable:
// a database migrated here can later be migrated by the real Prisma CLI (e.g.
// on a Linux CI machine) and vice-versa, with no drift.
//
// Safety: never destructive. Existing data is preserved, migrations already
// applied are skipped, checksum drift is reported as an error (not silently
// ignored), and a failed migration is recorded honestly (never marked applied).
// ──────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface MigrateOptions {
  /** Project root (defaults to process.cwd()). */
  cwd?: string;
  /** Database file path or `file:` URL. */
  databaseUrl: string;
  /** Only report what would be applied. */
  dryRun?: boolean;
  /** Log sink (defaults to console.log). */
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  /** Migrations present on disk but absent from the database. */
  pendingBefore: string[];
}

export class MigrationDriftError extends Error {}

/** The exact table Prisma creates and reads. */
const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

function stripFileProtocol(url: string): string {
  return url.replace(/^file:/, '');
}

/** Migration directories, sorted lexicographically (Prisma's ordering). */
export function listMigrations(cwd: string): string[] {
  const dir = path.join(cwd, 'prisma', 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() && existsSync(path.join(full, 'migration.sql'));
    })
    .sort();
}

/** Prisma's checksum: sha256 of the raw migration.sql bytes. */
export function migrationChecksum(cwd: string, name: string): string {
  const file = path.join(cwd, 'prisma', 'migrations', name, 'migration.sql');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

interface AppliedRow {
  migration_name: string;
  checksum: string;
  finished_at: number | null;
  rolled_back_at: number | null;
}

function readApplied(db: DatabaseSync): Map<string, AppliedRow> {
  const rows = db
    .prepare(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
    )
    .all() as unknown as AppliedRow[];
  return new Map(rows.map((r) => [r.migration_name, r]));
}

/**
 * Applies every pending migration, in order, inside a transaction each.
 * Returns the names applied in this run.
 */
export function migrate(options: MigrateOptions): MigrateResult {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((m: string) => console.log(m));
  const dbPath = stripFileProtocol(options.databaseUrl);

  const db = new DatabaseSync(dbPath, {
    // CRITICAL: Prisma's schema engine runs SQLite with double-quoted string
    // literals ENABLED. Some historical migrations rely on it — e.g.
    // 20260827135123_deletion_system does
    //   INSERT INTO new_messages (..., "replyToMessageId", ...)
    //     SELECT ..., "replyToMessageId", ... FROM messages;
    // when the column does not exist yet, and the engine silently stores the
    // STRING "replyToMessageId" instead of failing. node:sqlite disables that
    // misfeature by default, so without this option the migration aborts with
    // 'no such column: "replyToMessageId"'. Enabling it makes this runner
    // behave exactly like `prisma migrate deploy` (verified against a database
    // migrated by the real CLI, including the resulting row values).
    enableDoubleQuotedStringLiterals: true,
  });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  let pendingBefore: string[] = [];

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(MIGRATIONS_TABLE_SQL);

    const onDisk = listMigrations(cwd);
    const appliedMap = readApplied(db);
    pendingBefore = onDisk.filter((name) => {
      const row = appliedMap.get(name);
      return !row || row.finished_at === null;
    });

    if (onDisk.length === 0) {
      log('Nenhuma migration encontrada em prisma/migrations.');
      return { applied, alreadyApplied, pendingBefore: [] };
    }

    for (const name of onDisk) {
      const row = appliedMap.get(name);
      const checksum = migrationChecksum(cwd, name);

      if (row && row.finished_at !== null && row.rolled_back_at === null) {
        // Already applied — verify the file was not modified after the fact.
        if (row.checksum !== checksum) {
          throw new MigrationDriftError(
            `A migration "${name}" já foi aplicada, mas o arquivo mudou desde então.\n` +
              `  checksum no banco : ${row.checksum}\n` +
              `  checksum do arquivo: ${checksum}\n` +
              `Restaure o arquivo original (ou crie uma NOVA migration para a mudança). ` +
              `Nada foi alterado.`,
          );
        }
        alreadyApplied.push(name);
        continue;
      }

      if (options.dryRun) {
        log(`[dry-run] aplicaria: ${name}`);
        applied.push(name);
        continue;
      }

      log(`Aplicando migration: ${name}`);
      const sql = readFileSync(
        path.join(cwd, 'prisma', 'migrations', name, 'migration.sql'),
        'utf8',
      );

      const startedAt = Date.now();
      const id = randomUUID();

      // `PRAGMA foreign_keys` is a no-op inside a transaction, so it is set on
      // the connection BEFORE BEGIN (matching what Prisma's engine achieves).
      // The migrations themselves also set `defer_foreign_keys`, which does
      // work inside a transaction and is what actually defers FK checks.
      db.exec('PRAGMA foreign_keys = OFF');
      let failed: unknown = null;
      try {
        db.exec('BEGIN');
        db.exec(sql);
        db.prepare(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, checksum, Date.now(), name, null, null, startedAt, 1);
        db.exec('COMMIT');
        applied.push(name);
      } catch (error) {
        failed = error;
        try {
          db.exec('ROLLBACK');
        } catch {
          // Rollback may fail if the statement already aborted the transaction;
          // the failed-migration row below still records the honest state.
        }
        // Record the failure the way Prisma does: finished_at NULL + logs.
        try {
          db.prepare(
            `INSERT INTO "_prisma_migrations"
               (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
             VALUES (?, ?, NULL, ?, ?, NULL, ?, 0)`,
          ).run(
            randomUUID(),
            checksum,
            name,
            error instanceof Error ? error.message : String(error),
            startedAt,
          );
        } catch {
          // Best effort — the original error is what matters.
        }
      } finally {
        try {
          db.exec('PRAGMA foreign_keys = ON');
        } catch {
          // Connection may already be unusable after a hard failure.
        }
      }

      if (failed) {
        throw new Error(
          `Falha ao aplicar a migration "${name}": ` +
            (failed instanceof Error ? failed.message : String(failed)) +
            `\nO banco NÃO ficou inconsistente: a migration foi revertida ` +
            `(ROLLBACK) e registrada como não aplicada.`,
        );
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // Already closed on the error path.
    }
  }

  return { applied, alreadyApplied, pendingBefore };
}

/** Status report (read-only): what is applied and what is pending. */
export function status(options: Omit<MigrateOptions, 'dryRun'>): {
  applied: string[];
  pending: string[];
} {
  const cwd = options.cwd ?? process.cwd();
  const db = new DatabaseSync(stripFileProtocol(options.databaseUrl));
  try {
    db.exec(MIGRATIONS_TABLE_SQL);
    const appliedMap = readApplied(db);
    const applied: string[] = [];
    const pending: string[] = [];
    for (const name of listMigrations(cwd)) {
      const row = appliedMap.get(name);
      if (row && row.finished_at !== null && row.rolled_back_at === null) applied.push(name);
      else pending.push(name);
    }
    return { applied, pending };
  } finally {
    db.close();
  }
}
