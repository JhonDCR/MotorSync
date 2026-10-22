import { pathToFileURL } from 'node:url';
import { requireEnv } from '../config/env.js';
import { loadRootEnvFile } from '../config/env-file.js';
import { createMigratorDataSource } from './data-source.js';

/**
 * Applies the pending migrations as motorsync_migrator. Idempotent: already applied
 * migrations are skipped. Always closes its DataSource.
 */
export async function runMigrations(url?: string): Promise<void> {
  const dataSource = createMigratorDataSource(url ?? requireEnv('DATABASE_MIGRATOR_URL'));
  await dataSource.initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    if (applied.length > 0) {
      console.log(`Applied migrations: ${applied.map((m) => m.name).join(', ')}`);
    } else {
      console.log('No pending migrations.');
    }
  } finally {
    await dataSource.destroy();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  loadRootEnvFile();
  try {
    await runMigrations();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
