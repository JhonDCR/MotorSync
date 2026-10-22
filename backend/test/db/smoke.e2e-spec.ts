// T001: smoke e2e for connection, transaction and tenant pinning (plan risk 1, principle I).
// Uses the real PostgreSQL as motorsync_app (DATABASE_URL). Requires the migration
// CreateTenantsAndHelpers (app_current_tenant()), applied by test/setup/global-setup.ts.
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

type Row = Record<string, unknown>;

async function one<T extends Row>(
  runner: QueryRunner | DataSource,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = (await runner.query(sql, params)) as T[];
  return rows[0];
}

const pinTenant = (runner: QueryRunner, tenantId: string) =>
  runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

const currentSetting = async (runner: QueryRunner | DataSource) =>
  (await one<{ value: string | null }>(runner, `SELECT current_setting('app.tenant_id', true) AS value`))
    .value;

const appCurrentTenant = async (runner: QueryRunner | DataSource) =>
  (await one<{ tenant: string | null }>(runner, 'SELECT app_current_tenant() AS tenant')).tenant;

describe('DB smoke: TypeORM + ESM + set_config local (T001)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set in the e2e environment');
    dataSource = new DataSource({ type: 'postgres', url, synchronize: false, entities: [] });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('[T001-a] TypeORM loads in ESM and connects with DATABASE_URL as motorsync_app', async () => {
    expect(dataSource.isInitialized).toBe(true);
    const row = await one<{ user: string }>(dataSource, 'SELECT current_user AS "user"');
    expect(row.user).toBe('motorsync_app');
  });

  it('[T001-b][Principio I] the app role has neither BYPASSRLS nor SUPERUSER', async () => {
    const row = await one<{ rolbypassrls: boolean; rolsuper: boolean }>(
      dataSource,
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(row.rolbypassrls).toBe(false);
    expect(row.rolsuper).toBe(false);
  });

  it('[T001-c] set_config(..., true) lives only inside the transaction of the QueryRunner', async () => {
    const tenantId = randomUUID();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await pinTenant(runner, tenantId);
      expect(await currentSetting(runner)).toBe(tenantId);
      expect(await appCurrentTenant(runner)).toBe(tenantId);
      await runner.commitTransaction();

      // Same physical connection after COMMIT: the local setting must be gone.
      expect([null, '']).toContain(await currentSetting(runner));
      expect(await appCurrentTenant(runner)).toBeNull();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('[T001-c] ROLLBACK also discards the pinned tenant on the same connection', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await pinTenant(runner, randomUUID());
      await runner.rollbackTransaction();
      expect([null, '']).toContain(await currentSetting(runner));
    } finally {
      await runner.release();
    }
  });

  it('[T001-d][Principio I] two concurrent transactions with different tenants each see their own', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const runnerA = dataSource.createQueryRunner();
    const runnerB = dataSource.createQueryRunner();
    await Promise.all([runnerA.connect(), runnerB.connect()]);
    try {
      await Promise.all([runnerA.startTransaction(), runnerB.startTransaction()]);
      // Interleaved: both transactions are open at the same time on different connections.
      await pinTenant(runnerA, tenantA);
      await pinTenant(runnerB, tenantB);

      const [seenA, seenB, fnA, fnB] = await Promise.all([
        currentSetting(runnerA),
        currentSetting(runnerB),
        appCurrentTenant(runnerA),
        appCurrentTenant(runnerB),
      ]);
      expect(seenA).toBe(tenantA);
      expect(seenB).toBe(tenantB);
      expect(fnA).toBe(tenantA);
      expect(fnB).toBe(tenantB);

      await Promise.all([runnerA.commitTransaction(), runnerB.commitTransaction()]);
    } finally {
      for (const runner of [runnerA, runnerB]) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    }
  });

  it('[T001-e] app_current_tenant() returns NULL without set_config', async () => {
    expect(await appCurrentTenant(dataSource)).toBeNull();

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      expect(await appCurrentTenant(runner)).toBeNull();
      await runner.commitTransaction();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
