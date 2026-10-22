// T002: Vitest globalSetup for e2e. Applies the pending migrations as motorsync_migrator
// before any suite runs. Idempotent: in CI `npm run db:migrate` has already run.
// Registered by T008 in vitest.config.e2e.ts: globalSetup: ['./test/setup/global-setup.ts'].
import { runMigrations } from '../../src/database/migrate.js';

const REQUIRED_ENV = ['DATABASE_URL', 'DATABASE_MIGRATOR_URL', 'JWT_SECRET'] as const;

export default async function setup(): Promise<void> {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `e2e: missing environment variables ${missing.join(', ')}. ` +
        'Locally they come from the repo .env (see .env.example); in CI from the job env.',
    );
  }
  await runMigrations(process.env.DATABASE_MIGRATOR_URL);
}
