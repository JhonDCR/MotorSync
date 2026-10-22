// T002: data fixtures for e2e tests. They connect as motorsync_migrator (DATABASE_MIGRATOR_URL),
// never as the app role: the API under test always uses motorsync_app (research R2).
import pg from 'pg';

const BUSINESS_TABLES = ['clients', 'vehicles', 'audit_log', 'tenants'] as const;

let pool: pg.Pool | undefined;

function migratorPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_MIGRATOR_URL;
    if (!connectionString) {
      throw new Error('DATABASE_MIGRATOR_URL is not set in the e2e environment');
    }
    pool = new pg.Pool({ connectionString, max: 2 });
  }
  return pool;
}

export interface TenantFixture {
  id: string;
  name: string;
}

export async function createTenant(name: string): Promise<TenantFixture> {
  const result = await migratorPool().query<TenantFixture>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
    [name],
  );
  return result.rows[0];
}

/**
 * TRUNCATE clients, vehicles, audit_log, tenants CASCADE, skipping the tables that do not
 * exist yet (each migration adds its own, so earlier PRs only have some of them).
 */
export async function truncateBusinessTables(): Promise<void> {
  const db = migratorPool();
  const existing = await db.query<{ name: string }>(
    `SELECT t.name
       FROM unnest($1::text[]) AS t(name)
      WHERE to_regclass('public.' || t.name) IS NOT NULL`,
    [[...BUSINESS_TABLES]],
  );
  if (existing.rows.length === 0) return;
  const tables = existing.rows.map((row: { name: string }) => `public."${row.name}"`).join(', ');
  await db.query(`TRUNCATE ${tables} CASCADE`);
}

/** Closes the fixtures pool; call it in afterAll of each suite that uses the fixtures. */
export async function closeFixtures(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
