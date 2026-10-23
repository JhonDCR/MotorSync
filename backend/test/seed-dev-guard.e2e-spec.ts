// Ajuste 3 del reviewer T031 (specs/002-autenticacion, tasks.md "# PR2"): `npm run db:seed:dev`
// aborta si NODE_ENV=production, sin insertar nada. Ejecuta el script COMPILADO, como lo hace
// `npm run db:seed:dev` (dist/scripts/seed-dev.js): en CI `npm run build` corre antes de las e2e y en
// local el arranque documentado también compila primero (CLAUDE.md). La unitaria de la regla está en
// scripts/seed-guard.spec.ts.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { closeFixtures, truncateBusinessTables } from './setup/db-fixtures.js';

const SEED_SCRIPT = join(process.cwd(), 'dist', 'scripts', 'seed-dev.js');

function runSeed(nodeEnv: string | undefined): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  return spawnSync(process.execPath, [SEED_SCRIPT], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('seed-dev en producción (e2e, ajuste 3 del reviewer T031)', () => {
  let migratorPool: pg.Pool;

  async function countTenants(): Promise<number> {
    const result = await migratorPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tenants',
    );
    return Number(result.rows[0].count);
  }

  beforeAll(() => {
    if (!existsSync(SEED_SCRIPT)) {
      throw new Error(`${SEED_SCRIPT} does not exist: run npm run build before the e2e`);
    }
    migratorPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 1 });
  });

  beforeEach(async () => {
    await truncateBusinessTables();
  });

  afterAll(async () => {
    await truncateBusinessTables();
    await migratorPool?.end();
    await closeFixtures();
  });

  it('[T031-3] con NODE_ENV=production el seed termina con error, nombra NODE_ENV y no inserta nada', async () => {
    const result = runSeed('production');

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain('NODE_ENV');
    // Nunca imprime la contraseña de desarrollo ni los talleres.
    expect(result.stdout).not.toMatch(/Contraseña de desarrollo/);
    expect(await countTenants()).toBe(0);
  });

  it('[T031-3] control: sin NODE_ENV=production el mismo comando sí siembra los talleres', async () => {
    const result = runSeed('development');

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(await countTenants()).toBeGreaterThan(0);
  });
});
