// T017: database-level RLS of `clients` (principle I, FR-022, FR-023; data-model.md).
// Connects as motorsync_app (DATABASE_URL) with raw pg, exactly as the API role would, pinning
// the tenant with set_config('app.tenant_id', ..., true) inside each transaction.
// T040 will extend this file with `vehicles`.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  closeFixtures,
  createTenant,
  truncateBusinessTables,
  type TenantFixture,
} from '../setup/db-fixtures.js';

interface PgError {
  code?: string;
  message: string;
}

const ACTOR = randomUUID();

let appPool: pg.Pool;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
const clientIdsA: string[] = [];
const clientIdsB: string[] = [];

/** Runs fn in a transaction as motorsync_app, with the tenant pinned (or not), and rolls back or commits. */
async function asApp<T>(
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
  finish: 'commit' | 'rollback' = 'rollback',
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query(finish === 'commit' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expectPgError(promise: Promise<unknown>): Promise<PgError> {
  const error = (await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )) as PgError | undefined;
  expect(error, 'the statement should have failed').toBeDefined();
  return error as PgError;
}

let documentSeq = 1_000_000;
function nextDocument(): string {
  documentSeq += 1;
  return `P${documentSeq}`;
}

/** INSERT of a natural client with a passport; tenantId undefined lets the column DEFAULT apply. */
function insertClient(
  client: pg.PoolClient,
  tenantId?: string,
  documentNumber = nextDocument(),
): Promise<pg.QueryResult<{ id: string; tenant_id: string }>> {
  const columns = [
    'client_type',
    'document_type',
    'document_number',
    'first_names',
    'last_names',
    'phone',
    'created_by',
    'updated_by',
    'updated_by_name',
  ];
  const values: unknown[] = [
    'natural',
    'passport',
    documentNumber,
    'Ana',
    'Pérez',
    '0991234567',
    ACTOR,
    ACTOR,
    'Ana Pérez',
  ];
  if (tenantId !== undefined) {
    columns.push('tenant_id');
    values.push(tenantId);
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  return client.query(
    `INSERT INTO clients (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id, tenant_id`,
    values,
  );
}

describe('RLS de clients en la BD (T017, principio I, FR-022, FR-023)', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set in the e2e environment');
    appPool = new pg.Pool({ connectionString: url, max: 3 });

    await truncateBusinessTables();
    tenantA = await createTenant('Taller A (rls)');
    tenantB = await createTenant('Taller B (rls)');

    // Each tenant inserts its own rows through the app role, as the API does.
    for (const [tenant, ids] of [
      [tenantA, clientIdsA],
      [tenantB, clientIdsB],
    ] as const) {
      await asApp(
        tenant.id,
        async (client) => {
          for (let i = 0; i < 2; i++) {
            const { rows } = await insertClient(client);
            ids.push(rows[0].id);
          }
        },
        'commit',
      );
    }
  });

  afterAll(async () => {
    await truncateBusinessTables();
    await appPool?.end();
    await closeFixtures();
  });

  it('[T017][Principio I] la conexión de estas pruebas es motorsync_app', async () => {
    const { rows } = await appPool.query<{ user: string }>('SELECT current_user AS "user"');
    expect(rows[0].user).toBe('motorsync_app');
  });

  it('[T017][FR-023] sin set_config, SELECT count(*) FROM clients = 0 aunque haya filas de A y B', async () => {
    const count = await asApp(null, async (client) => {
      const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM clients');
      return Number(rows[0].count);
    });
    expect(count).toBe(0);

    // Also outside of any explicit transaction.
    const { rows } = await appPool.query<{ count: string }>('SELECT count(*) FROM clients');
    expect(Number(rows[0].count)).toBe(0);
  });

  it('[T017][FR-023] con el tenant A solo se ven las filas de A, nunca las de B', async () => {
    const rows = await asApp(tenantA.id, async (client) => {
      const result = await client.query<{ id: string; tenant_id: string }>(
        'SELECT id, tenant_id FROM clients',
      );
      return result.rows;
    });
    expect(rows.map((row) => row.id).sort()).toEqual([...clientIdsA].sort());
    expect(rows.every((row) => row.tenant_id === tenantA.id)).toBe(true);

    const byId = await asApp(tenantA.id, async (client) => {
      const result = await client.query('SELECT id FROM clients WHERE id = ANY($1::uuid[])', [
        clientIdsB,
      ]);
      return result.rowCount;
    });
    expect(byId).toBe(0);
  });

  it('[T017][FR-023] y con el tenant B solo las de B', async () => {
    const ids = await asApp(tenantB.id, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM clients');
      return result.rows.map((row) => row.id);
    });
    expect(ids.sort()).toEqual([...clientIdsB].sort());
  });

  it('[T017][FR-022] sin tenant_id explícito, el INSERT toma el tenant de la transacción (DEFAULT app_current_tenant())', async () => {
    const tenantId = await asApp(tenantA.id, async (client) => {
      const { rows } = await insertClient(client);
      return rows[0].tenant_id;
    });
    expect(tenantId).toBe(tenantA.id);
  });

  it('[T017][Principio I][FR-022] INSERT con tenant_id de B bajo el tenant A falla por WITH CHECK', async () => {
    const error = await expectPgError(
      asApp(tenantA.id, (client) => insertClient(client, tenantB.id)),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/i);
  });

  it('[T017][Principio I] INSERT sin set_config falla (no hay tenant al que pertenecer)', async () => {
    await expectPgError(asApp(null, (client) => insertClient(client)));
    await expectPgError(asApp(null, (client) => insertClient(client, tenantA.id)));
  });

  it('[T017][FR-023] UPDATE de una fila de B bajo el tenant A no afecta ninguna fila', async () => {
    const rowCount = await asApp(tenantA.id, async (client) => {
      const result = await client.query(
        `UPDATE clients SET phone = '0999999999' WHERE id = ANY($1::uuid[])`,
        [clientIdsB],
      );
      return result.rowCount;
    });
    expect(rowCount).toBe(0);
  });

  it('[T017][Principio I] UPDATE que mueve una fila de A al tenant B falla por WITH CHECK', async () => {
    const error = await expectPgError(
      asApp(tenantA.id, (client) =>
        client.query('UPDATE clients SET tenant_id = $1 WHERE id = $2', [tenantB.id, clientIdsA[0]]),
      ),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/i);
  });

  it('[T017][FR-021][Principio IV] DELETE FROM clients → permission denied', async () => {
    const error = await expectPgError(
      asApp(tenantA.id, (client) => client.query('DELETE FROM clients')),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/permission denied/i);
  });

  it('[T017][FR-021][Principio IV] TRUNCATE clients → permission denied', async () => {
    const error = await expectPgError(
      asApp(tenantA.id, (client) => client.query('TRUNCATE clients')),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/permission denied/i);
  });

  it('[T017] motorsync_app tiene exactamente SELECT, INSERT y UPDATE sobre clients', async () => {
    const { rows } = await appPool.query<Record<string, boolean>>(
      `SELECT has_table_privilege('motorsync_app', 'public.clients', 'SELECT')     AS "select",
              has_table_privilege('motorsync_app', 'public.clients', 'INSERT')     AS "insert",
              has_table_privilege('motorsync_app', 'public.clients', 'UPDATE')     AS "update",
              has_table_privilege('motorsync_app', 'public.clients', 'DELETE')     AS "delete",
              has_table_privilege('motorsync_app', 'public.clients', 'TRUNCATE')   AS "truncate",
              has_table_privilege('motorsync_app', 'public.clients', 'REFERENCES') AS "references",
              has_table_privilege('motorsync_app', 'public.clients', 'TRIGGER')    AS "trigger"`,
    );
    expect(rows[0]).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
      truncate: false,
      references: false,
      trigger: false,
    });
  });

  it('[T017][Principio I] motorsync_app no es dueño de clients', async () => {
    const { rows } = await appPool.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.clients'::regclass`,
    );
    expect(rows[0].owner).not.toBe('motorsync_app');
    expect(rows[0].owner).toBe('motorsync_migrator');
  });

  it('[T017][Principio I] clients tiene RLS habilitada y forzada (relrowsecurity y relforcerowsecurity)', async () => {
    const { rows } = await appPool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.clients'::regclass`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('[T017][Principio I] la política clients_tenant_isolation existe y filtra por app_current_tenant()', async () => {
    const { rows } = await appPool.query<{ policyname: string; qual: string; with_check: string }>(
      `SELECT policyname, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'clients'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].policyname).toBe('clients_tenant_isolation');
    expect(rows[0].qual).toMatch(/app_current_tenant\(\)/);
    expect(rows[0].with_check).toMatch(/app_current_tenant\(\)/);
  });
});
