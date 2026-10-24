// T051: database-level trigger `users_last_admin` (FR-018, US4-AC9).
// Ensures the DB prevents demoting or deactivating the last active admin of a tenant.
// Connects as motorsync_app (DATABASE_URL) with raw pg, pinning the tenant with
// set_config('app.tenant_id', ..., true) inside each transaction.
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  closeFixtures,
  createTenant,
  createUser,
  truncateBusinessTables,
} from '../setup/db-fixtures.js';

interface PgDatabaseError extends Error {
  code?: string;
  constraint?: string;
}

describe('users_last_admin trigger (T051, FR-018, US4-AC9)', () => {
  let appPool: pg.Pool;

  beforeAll(() => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set in the e2e environment');
    }
    appPool = new pg.Pool({ connectionString, max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await closeFixtures();
  });

  beforeEach(() => truncateBusinessTables());

  async function withAppTenant<T>(
    tenantId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('US4-AC9 / FR-018: updating the only active admin to asesor throws 23514 on commit and rolls back', async () => {
    const tenant = await createTenant('Taller Test');
    const admin = await createUser({
      tenantId: tenant.id,
      name: 'Admin Unico',
      email: 'admin@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });

    let thrown: PgDatabaseError | null = null;
    try {
      await withAppTenant(tenant.id, async (client) => {
        await client.query(`UPDATE users SET role = 'asesor' WHERE id = $1`, [admin.id]);
      });
    } catch (err) {
      thrown = err as PgDatabaseError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe('23514');
    expect(thrown?.constraint).toBe('users_last_admin');

    // Verify row did not change
    await withAppTenant(tenant.id, async (client) => {
      const res = await client.query<{ role: string; status: string }>(
        'SELECT role, status FROM users WHERE id = $1',
        [admin.id],
      );
      expect(res.rows[0].role).toBe('admin');
      expect(res.rows[0].status).toBe('active');
    });
  });

  it('US4-AC9 / FR-018: updating the only active admin to inactive throws 23514 on commit and rolls back', async () => {
    const tenant = await createTenant('Taller Test Inactive');
    const admin = await createUser({
      tenantId: tenant.id,
      name: 'Admin Unico',
      email: 'admin.inactive@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });

    let thrown: PgDatabaseError | null = null;
    try {
      await withAppTenant(tenant.id, async (client) => {
        await client.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [admin.id]);
      });
    } catch (err) {
      thrown = err as PgDatabaseError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe('23514');
    expect(thrown?.constraint).toBe('users_last_admin');

    // Verify row did not change
    await withAppTenant(tenant.id, async (client) => {
      const res = await client.query<{ role: string; status: string }>(
        'SELECT role, status FROM users WHERE id = $1',
        [admin.id],
      );
      expect(res.rows[0].role).toBe('admin');
      expect(res.rows[0].status).toBe('active');
    });
  });

  it('US4-AC9 / FR-018: allows changing one admin when another active admin exists in the tenant', async () => {
    const tenant = await createTenant('Taller Multi Admin');
    const admin1 = await createUser({
      tenantId: tenant.id,
      name: 'Admin 1',
      email: 'admin1@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });
    await createUser({
      tenantId: tenant.id,
      name: 'Admin 2',
      email: 'admin2@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });

    await withAppTenant(tenant.id, async (client) => {
      await client.query(`UPDATE users SET role = 'asesor' WHERE id = $1`, [admin1.id]);
    });

    await withAppTenant(tenant.id, async (client) => {
      const res = await client.query<{ role: string }>(
        'SELECT role FROM users WHERE id = $1',
        [admin1.id],
      );
      expect(res.rows[0].role).toBe('asesor');
    });
  });

  it('US4-AC9 / FR-018: allows deactivating one admin when another active admin exists in the tenant', async () => {
    const tenant = await createTenant('Taller Multi Admin 2');
    const admin1 = await createUser({
      tenantId: tenant.id,
      name: 'Admin 1',
      email: 'admin1.multi@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });
    await createUser({
      tenantId: tenant.id,
      name: 'Admin 2',
      email: 'admin2.multi@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });

    await withAppTenant(tenant.id, async (client) => {
      await client.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [admin1.id]);
    });

    await withAppTenant(tenant.id, async (client) => {
      const res = await client.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [admin1.id],
      );
      expect(res.rows[0].status).toBe('inactive');
    });
  });

  it('US4-AC9 / FR-018: does not trigger when updating an asesor', async () => {
    const tenant = await createTenant('Taller Asesor');
    await createUser({
      tenantId: tenant.id,
      name: 'Admin 1',
      email: 'admin@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });
    const asesor = await createUser({
      tenantId: tenant.id,
      name: 'Asesor 1',
      email: 'asesor@taller.ec',
      role: 'asesor',
      password: 'Password123!',
      status: 'active',
    });

    await withAppTenant(tenant.id, async (client) => {
      await client.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [asesor.id]);
    });

    await withAppTenant(tenant.id, async (client) => {
      const res = await client.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [asesor.id],
      );
      expect(res.rows[0].status).toBe('inactive');
    });
  });

  it('US4-AC9 / FR-018: does not trigger when updating an already inactive admin', async () => {
    const tenant = await createTenant('Taller Inactive');
    await createUser({
      tenantId: tenant.id,
      name: 'Admin Activo',
      email: 'admin.act@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });
    const adminInactive = await createUser({
      tenantId: tenant.id,
      name: 'Admin Inactivo',
      email: 'admin.inact@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'inactive',
    });

    await withAppTenant(tenant.id, async (client) => {
      await client.query(`UPDATE users SET role = 'asesor' WHERE id = $1`, [adminInactive.id]);
    });

    await withAppTenant(tenant.id, async (client) => {
      const res = await client.query<{ role: string }>(
        'SELECT role FROM users WHERE id = $1',
        [adminInactive.id],
      );
      expect(res.rows[0].role).toBe('asesor');
    });
  });

  it('US4-AC9 / FR-018: multi-tenant isolation - admin in another tenant does not prevent trigger from firing', async () => {
    const tenantA = await createTenant('Taller A');
    const tenantB = await createTenant('Taller B');

    const adminA = await createUser({
      tenantId: tenantA.id,
      name: 'Admin A',
      email: 'admin.a@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });

    // Active admin in tenant B
    await createUser({
      tenantId: tenantB.id,
      name: 'Admin B',
      email: 'admin.b@taller.ec',
      role: 'admin',
      password: 'Password123!',
      status: 'active',
    });

    let thrown: PgDatabaseError | null = null;
    try {
      await withAppTenant(tenantA.id, async (client) => {
        await client.query(`UPDATE users SET role = 'asesor' WHERE id = $1`, [adminA.id]);
      });
    } catch (err) {
      thrown = err as PgDatabaseError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe('23514');
    expect(thrown?.constraint).toBe('users_last_admin');
  });
});
