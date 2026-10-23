// npm run db:bootstrap: creates the database roles and extensions (research R2) running
// db/bootstrap.sql with DATABASE_ADMIN_URL. Role passwords come from DB_MIGRATOR_PASSWORD
// and DB_APP_PASSWORD and are passed as bound parameters, never interpolated in JS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requireEnv } from '../src/config/env.js';
import { backendRoot, loadRootEnvFile } from '../src/config/env-file.js';

async function main(): Promise<void> {
  loadRootEnvFile();
  const adminUrl = requireEnv('DATABASE_ADMIN_URL');
  const migratorPassword = requireEnv('DB_MIGRATOR_PASSWORD');
  const appPassword = requireEnv('DB_APP_PASSWORD');
  const sql = readFileSync(join(backendRoot(), 'db', 'bootstrap.sql'), 'utf8');

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `SELECT set_config('motorsync.migrator_password', $1, false),
              set_config('motorsync.app_password', $2, false)`,
      [migratorPassword, appPassword],
    );
    await client.query(sql);
    console.log('Database bootstrap completed (roles motorsync_migrator, motorsync_app, motorsync_auth).');
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
