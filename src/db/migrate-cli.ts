#!/usr/bin/env node
// CLI for the offline migration runner (see src/db/migrate.ts).
//
//   node dist/src/db/migrate-cli.js deploy   # aplica migrations pendentes
//   node dist/src/db/migrate-cli.js status   # só mostra o estado
//   node dist/src/db/migrate-cli.js deploy --dry-run
//
// Reads DATABASE_URL (same default as the app: <cwd>/data/matrix.db).
import { migrate, status, MigrationDriftError } from './migrate.js';

function databaseUrl(): string {
  return process.env.DATABASE_URL || `file:${process.cwd()}/data/matrix.db`;
}

const command = process.argv[2] ?? 'deploy';
const dryRun = process.argv.includes('--dry-run');

try {
  if (command === 'status') {
    const { applied, pending } = status({ databaseUrl: databaseUrl() });
    console.log(`Aplicadas: ${applied.length}`);
    console.log(`Pendentes: ${pending.length}${pending.length ? ` (${pending.join(', ')})` : ''}`);
  } else if (command === 'deploy') {
    const result = migrate({ databaseUrl: databaseUrl(), dryRun });
    if (result.applied.length === 0) {
      console.log('Nenhuma migration pendente.');
    } else {
      console.log(
        `${dryRun ? 'Seriam aplicadas' : 'Aplicadas'}: ${result.applied.length} migration(s).`,
      );
    }
  } else {
    console.error(`Comando desconhecido: ${command}. Use "deploy" ou "status".`);
    process.exit(2);
  }
} catch (error) {
  if (error instanceof MigrationDriftError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}
