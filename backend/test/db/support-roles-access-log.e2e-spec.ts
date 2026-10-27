// T059 (specs/003-soporte-plataforma, PR3, US4): database design of the support access log
// (support_access_log) and of the read functions support_list_workshops,
// support_list_workshop_accounts and support_list_access_log (data-model.md, migration
// 1761000001500-CreateSupportAccessLog; research R10; FR-016 to FR-018, FR-027).
// This is the RED test of T059: migration 1761000001500 (T060) does not exist yet, so the
// suite must fail on the missing table and functions.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  closeFixtures,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  setSupportSessionLastActivity,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from '../setup/db-fixtures.js';

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

const ACCESS_LOG_FUNCTIONS = [
  'support_list_workshops(uuid,text,text,integer,integer)',
  'support_list_workshop_accounts(uuid,uuid,text)',
  'support_list_access_log(uuid,uuid,uuid,integer,integer)',
] as const;

const WORKSHOP_ACCOUNTS_COLUMNS = [
  'user_id',
  'name',
  'email',
  'role',
  'status',
  'has_open_ticket',
  'workshop_name',
  'workshop_ruc',
  'workshop_created_at',
];

const ACCESS_LOG_COLUMNS = [
  'entry_id',
  'occurred_at',
  'agent_id',
  'agent_name',
  'tenant_id',
  'workshop_name',
  'workshop_ruc',
  'ip',
  'channel',
  'total',
];

const PASSWORD = 'Soporte-Password-1234';
const IP = '203.0.113.7';

let appPool: pg.Pool;
let migratorPool: pg.Pool;

let tenantA: TenantFixture;
let tenantB: TenantFixture;
let userA1: UserFixture;
let userA2: UserFixture;
let agent: SupportAccountFixture;
let otherAgent: SupportAccountFixture;
let agentSessionId: string;

async function inTransaction<T>(
  db: pg.Pool,
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
  finish: 'commit' | 'rollback' = 'rollback',
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
    }
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

function asApp<T>(
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
  finish: 'commit' | 'rollback' = 'rollback',
): Promise<T> {
  return inTransaction(appPool, tenantId, fn, finish);
}

async function expectPgError(promise: Promise<unknown>): Promise<PgError> {
  const error = (await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )) as PgError | undefined;
  expect(error, 'the statement should have failed').toBeDefined();
  return error as PgError;
}

async function expectSqlState(
  promise: Promise<unknown>,
  code: string,
): Promise<PgError> {
  const error = await expectPgError(promise);
  expect(error.code, error.message).toBe(code);
  return error;
}

function randomRuc(): string {
  const digits = Array.from(randomBytes(10), (byte) => String(byte % 10)).join(
    '',
  );
  return `${digits}001`;
}

async function createSupportSession(accountId: string): Promise<string> {
  const result = await migratorPool.query<{ id: string }>(
    'INSERT INTO support_sessions (support_account_id) VALUES ($1) RETURNING id',
    [accountId],
  );
  return result.rows[0].id;
}

interface AccessLogRow {
  id: string;
  support_account_id: string;
  tenant_id: string;
  action: string;
  ip: string | null;
  channel: string;
  occurred_at: Date;
}

async function readAccessLog(): Promise<AccessLogRow[]> {
  const result = await migratorPool.query<AccessLogRow>(
    `SELECT id, support_account_id, tenant_id, action, ip, channel, occurred_at
       FROM support_access_log ORDER BY occurred_at, id`,
  );
  return result.rows;
}

/** Inserts an access log entry as the migrator, `minutesAgo` minutes in the past. */
async function insertAccessLog(
  agentId: string,
  tenantId: string,
  minutesAgo: number,
  ip: string | null = IP,
): Promise<string> {
  const result = await migratorPool.query<{ id: string }>(
    `INSERT INTO support_access_log (support_account_id, tenant_id, action, ip, occurred_at)
     VALUES ($1, $2, 'workshop.accounts_viewed', $3, now() - make_interval(mins => $4))
     RETURNING id`,
    [agentId, tenantId, ip, minutesAgo],
  );
  return result.rows[0].id;
}

/** Calls each of the three functions with the given session, as the app. */
function callFunction(
  client: pg.PoolClient,
  fn: (typeof ACCESS_LOG_FUNCTIONS)[number],
  sessionId: string,
): Promise<unknown> {
  if (fn.startsWith('support_list_workshops(')) {
    return client.query(
      'SELECT * FROM support_list_workshops($1, NULL, NULL, 50, 0)',
      [sessionId],
    );
  }
  if (fn.startsWith('support_list_workshop_accounts(')) {
    return client.query(
      'SELECT * FROM support_list_workshop_accounts($1, $2, $3)',
      [sessionId, tenantA.id, IP],
    );
  }
  return client.query(
    'SELECT * FROM support_list_access_log($1, NULL, NULL, 50, 0)',
    [sessionId],
  );
}

async function seed(): Promise<void> {
  await truncateBusinessTables();
  tenantA = await createTenant('Taller A (access log)', randomRuc());
  tenantB = await createTenant('Taller B (access log)', randomRuc());
  userA1 = await createUser({
    tenantId: tenantA.id,
    name: 'Ana Admin',
    email: 'ana@taller-a.ec',
    role: 'admin',
    password: PASSWORD,
  });
  userA2 = await createUser({
    tenantId: tenantA.id,
    name: 'Carlos Asesor',
    email: 'carlos@taller-a.ec',
    role: 'asesor',
    password: PASSWORD,
  });
  await createUser({
    tenantId: tenantB.id,
    name: 'Bruno Asesor',
    email: 'bruno@taller-b.ec',
    role: 'asesor',
    password: PASSWORD,
  });
  agent = await createSupportAccount({
    name: 'Agente Soporte',
    email: 'agente@motorsync.ec',
    password: PASSWORD,
  });
  otherAgent = await createSupportAccount({
    name: 'Otro Agente',
    email: 'otro@motorsync.ec',
    password: PASSWORD,
  });
  agentSessionId = await createSupportSession(agent.id);
}

describe('Bitácora de soporte y consultas de talleres en la BD (T059, PR3, US4, FR-016 a FR-018, FR-027)', () => {
  beforeAll(() => {
    const appUrl = process.env.DATABASE_URL;
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!appUrl) {
      throw new Error('DATABASE_URL is not set in the e2e environment');
    }
    if (!migratorUrl) {
      throw new Error(
        'DATABASE_MIGRATOR_URL is not set in the e2e environment',
      );
    }
    appPool = new pg.Pool({ connectionString: appUrl, max: 3 });
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 2 });
  });

  afterAll(async () => {
    await truncateBusinessTables();
    await appPool?.end();
    await migratorPool?.end();
    await closeFixtures();
  });

  describe('(a) Tabla support_access_log (FR-018)', () => {
    beforeEach(seed);

    it('[T059][FR-018] tiene RLS ENABLE sin FORCE', async () => {
      const result = await migratorPool.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid = to_regclass('public.support_access_log')`,
      );
      expect(result.rows).toEqual([
        { relrowsecurity: true, relforcerowsecurity: false },
      ]);
    });

    it('[T059][FR-018][Principio I] motorsync_app no tiene ningún privilegio y motorsync_support solo SELECT e INSERT', async () => {
      const privileges = [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ];
      const result = await migratorPool.query<{
        role: string;
        privilege: string;
        granted: boolean;
      }>(
        `SELECT r.role, p.privilege,
                has_table_privilege(r.role, 'public.support_access_log', p.privilege) AS granted
           FROM unnest($1::text[]) AS r(role), unnest($2::text[]) AS p(privilege)`,
        [['motorsync_app', 'motorsync_support'], privileges],
      );
      const granted = result.rows
        .filter((row) => row.granted)
        .map((row) => `${row.role}:${row.privilege}`)
        .sort();
      expect(granted).toEqual([
        'motorsync_support:INSERT',
        'motorsync_support:SELECT',
      ]);
    });

    it('[T059][FR-018] es append-only: como migrator UPDATE y DELETE lanzan la excepción del trigger', async () => {
      const id = await insertAccessLog(agent.id, tenantA.id, 0);

      const updateError = await expectPgError(
        migratorPool.query(
          `UPDATE support_access_log SET ip = '127.0.0.1' WHERE id = $1`,
          [id],
        ),
      );
      expect(updateError.message).toMatch(/audit_log is append-only/);

      const deleteError = await expectPgError(
        migratorPool.query('DELETE FROM support_access_log WHERE id = $1', [
          id,
        ]),
      );
      expect(deleteError.message).toMatch(/audit_log is append-only/);
      expect(await readAccessLog()).toHaveLength(1);
    });

    it('[T059][FR-018] channel vale support_panel por defecto y action solo admite workshop.accounts_viewed', async () => {
      await insertAccessLog(agent.id, tenantA.id, 0);
      expect((await readAccessLog())[0].channel).toBe('support_panel');

      const error = await expectSqlState(
        migratorPool.query(
          `INSERT INTO support_access_log (support_account_id, tenant_id, action)
           VALUES ($1, $2, 'workshop.updated')`,
          [agent.id, tenantA.id],
        ),
        '23514',
      );
      expect(error.message).toMatch(/support_access_log/);
    });
  });

  describe('(b) DDL y permisos de las tres funciones (Principio I 1.3.0)', () => {
    it('[T059][Principio I 1.3.0] son SECURITY DEFINER, de motorsync_support y fijan search_path', async () => {
      for (const signature of ACCESS_LOG_FUNCTIONS) {
        const result = await migratorPool.query<{
          prosecdef: boolean;
          owner: string;
          proconfig: string[] | null;
        }>(
          `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [`public.${signature}`],
        );
        expect(result.rows, `${signature} should exist`).toHaveLength(1);
        const fn = result.rows[0];
        expect(fn.prosecdef, `${signature} prosecdef`).toBe(true);
        expect(fn.owner, `${signature} owner`).toBe('motorsync_support');
        expect(fn.proconfig, `${signature} proconfig`).toContain(
          'search_path=pg_catalog, public, pg_temp',
        );
      }
    });

    it('[T059][Principio I 1.3.0] ninguna concede EXECUTE a PUBLIC y las tres conceden EXECUTE a motorsync_app', async () => {
      for (const signature of ACCESS_LOG_FUNCTIONS) {
        const result = await migratorPool.query<{
          has_acl: boolean;
          public_execute: number;
          app_can_execute: boolean;
        }>(
          `SELECT p.proacl IS NOT NULL AS has_acl,
                  (SELECT count(*)::int FROM aclexplode(p.proacl) acl
                    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute,
                  has_function_privilege('motorsync_app', p.oid, 'EXECUTE') AS app_can_execute
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [`public.${signature}`],
        );
        expect(result.rows, `${signature} should exist`).toHaveLength(1);
        const fn = result.rows[0];
        expect(fn.has_acl, `${signature} has an explicit ACL`).toBe(true);
        expect(fn.public_execute, `${signature} EXECUTE for PUBLIC`).toBe(0);
        expect(fn.app_can_execute, `${signature} EXECUTE for app`).toBe(true);
      }
    });

    it('[T059][R10][US4-AC8] support_list_access_log es STABLE (provolatile = s)', async () => {
      const result = await migratorPool.query<{ provolatile: string }>(
        `SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure($1)`,
        [`public.${ACCESS_LOG_FUNCTIONS[2]}`],
      );
      expect(result.rows).toEqual([{ provolatile: 's' }]);
    });
  });

  describe('(c) Compuertas de sesión y de contexto (28000)', () => {
    beforeEach(seed);

    it('[T059][US2-AC9][US2-AC10] sin sesión válida (inexistente, revocada o inactiva) las tres lanzan 28000', async () => {
      const revokedSessionId = await createSupportSession(agent.id);
      await migratorPool.query(
        `UPDATE support_sessions SET revoked_at = now(), revoke_reason = 'logout'
          WHERE id = $1`,
        [revokedSessionId],
      );
      const idleSessionId = await createSupportSession(agent.id);
      await setSupportSessionLastActivity(idleSessionId, 31);

      for (const fn of ACCESS_LOG_FUNCTIONS) {
        for (const sessionId of [
          randomUUID(),
          revokedSessionId,
          idleSessionId,
        ]) {
          await expectSqlState(
            asApp(null, (client) => callFunction(client, fn, sessionId)),
            '28000',
          );
        }
      }
      expect(await readAccessLog()).toHaveLength(0);
    });

    it('[T059][Principio I 1.3.0] con un taller fijado las tres lanzan 28000', async () => {
      for (const fn of ACCESS_LOG_FUNCTIONS) {
        const error = await expectSqlState(
          asApp(tenantA.id, (client) =>
            callFunction(client, fn, agentSessionId),
          ),
          '28000',
        );
        expect(error.message).toMatch(
          /support functions run without a tenant/i,
        );
      }
      expect(await readAccessLog()).toHaveLength(0);
    });
  });

  describe('(d) support_list_workshop_accounts(p_session_id, p_tenant_id, p_ip)', () => {
    beforeEach(seed);

    it('[T059][US4-AC3][US4-AC6][FR-017] inserta exactamente un registro (agente, taller, workshop.accounts_viewed, IP, support_panel)', async () => {
      await asApp(
        null,
        (client) =>
          client.query(
            'SELECT * FROM support_list_workshop_accounts($1, $2, $3)',
            [agentSessionId, tenantA.id, IP],
          ),
        'commit',
      );

      const log = await readAccessLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        support_account_id: agent.id,
        tenant_id: tenantA.id,
        action: 'workshop.accounts_viewed',
        ip: IP,
        channel: 'support_panel',
      });
      expect(log[0].occurred_at).toBeInstanceOf(Date);
    });

    it('[T059][US4-AC3][US4-AC7][FR-016] devuelve exactamente sus 9 columnas y solo las cuentas de ese taller', async () => {
      await createTicket({
        tenantId: tenantA.id,
        userId: userA2.id,
        email: userA2.email,
      });

      const result = await asApp(null, (client) =>
        client.query<Record<string, unknown>>(
          'SELECT * FROM support_list_workshop_accounts($1, $2, $3)',
          [agentSessionId, tenantA.id, IP],
        ),
      );

      expect(result.fields.map((field) => field.name)).toEqual(
        WORKSHOP_ACCOUNTS_COLUMNS,
      );
      const byUser = new Map(
        result.rows.map((row) => [row.user_id as string, row]),
      );
      expect([...byUser.keys()].sort()).toEqual([userA1.id, userA2.id].sort());
      expect(byUser.get(userA1.id)).toMatchObject({
        name: userA1.name,
        email: userA1.email,
        role: 'admin',
        status: 'active',
        has_open_ticket: false,
        workshop_name: tenantA.name,
      });
      expect(byUser.get(userA2.id)).toMatchObject({
        role: 'asesor',
        has_open_ticket: true,
        workshop_name: tenantA.name,
      });
      for (const row of result.rows) {
        expect(row.workshop_created_at).toBeInstanceOf(Date);
        expect(typeof row.workshop_ruc).toBe('string');
      }
    });

    it('[T059][US4-AC3] con un taller sin cuentas devuelve una fila con las columnas de cuenta en NULL', async () => {
      const empty = await createTenant('Taller sin cuentas', randomRuc());

      const rows = await asApp(null, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          'SELECT * FROM support_list_workshop_accounts($1, $2, $3)',
          [agentSessionId, empty.id, IP],
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: null,
        name: null,
        email: null,
        role: null,
        status: null,
        has_open_ticket: null,
        workshop_name: 'Taller sin cuentas',
      });
      expect(rows[0].workshop_created_at).toBeInstanceOf(Date);
    });

    it('[T059][US4-AC3][US4-AC6] con un taller inexistente lanza P0002 y no inserta nada', async () => {
      const error = await expectSqlState(
        asApp(
          null,
          (client) =>
            client.query(
              'SELECT * FROM support_list_workshop_accounts($1, $2, $3)',
              [agentSessionId, randomUUID(), IP],
            ),
          'commit',
        ),
        'P0002',
      );
      expect(error.message).toMatch(/workshop not found/i);
      expect(await readAccessLog()).toHaveLength(0);
    });
  });

  describe('(e) support_list_access_log(p_session_id, p_tenant_id, p_agent_id, p_limit, p_offset)', () => {
    beforeEach(seed);

    it('[T059][US4-AC8][R10] no inserta filas y devuelve exactamente sus 10 columnas, sin correo del agente', async () => {
      await insertAccessLog(agent.id, tenantA.id, 5);

      const result = await asApp(
        null,
        (client) =>
          client.query<Record<string, unknown>>(
            'SELECT * FROM support_list_access_log($1, NULL, NULL, 50, 0)',
            [agentSessionId],
          ),
        'commit',
      );

      expect(result.fields.map((field) => field.name)).toEqual(
        ACCESS_LOG_COLUMNS,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        agent_id: agent.id,
        agent_name: agent.name,
        tenant_id: tenantA.id,
        workshop_name: tenantA.name,
        ip: IP,
        channel: 'support_panel',
        total: '1',
      });
      expect(JSON.stringify(result.rows)).not.toContain(agent.email);
      expect(await readAccessLog()).toHaveLength(1);
    });

    it('[T059][US4-AC8] ordena por occurred_at DESC', async () => {
      const oldest = await insertAccessLog(agent.id, tenantA.id, 30);
      const newest = await insertAccessLog(otherAgent.id, tenantB.id, 1);
      const middle = await insertAccessLog(agent.id, tenantB.id, 10);

      const ids = await asApp(null, async (client) => {
        const result = await client.query<{ entry_id: string }>(
          'SELECT entry_id FROM support_list_access_log($1, NULL, NULL, 50, 0)',
          [agentSessionId],
        );
        return result.rows.map((row) => row.entry_id);
      });
      expect(ids).toEqual([newest, middle, oldest]);
    });

    it('[T059][US4-AC8] respeta LEAST(p_limit, 50) y p_offset, con total del conjunto', async () => {
      for (let i = 0; i < 55; i += 1) {
        await insertAccessLog(agent.id, tenantA.id, i + 1);
      }

      const page = await asApp(null, async (client) => {
        const result = await client.query<{ total: string }>(
          'SELECT * FROM support_list_access_log($1, NULL, NULL, 500, 0)',
          [agentSessionId],
        );
        return result.rows;
      });
      expect(page).toHaveLength(50);
      expect(page[0].total).toBe('55');

      const small = await asApp(null, async (client) => {
        const result = await client.query(
          'SELECT * FROM support_list_access_log($1, NULL, NULL, 10, 0)',
          [agentSessionId],
        );
        return result.rows;
      });
      expect(small).toHaveLength(10);

      const last = await asApp(null, async (client) => {
        const result = await client.query(
          'SELECT * FROM support_list_access_log($1, NULL, NULL, 50, 50)',
          [agentSessionId],
        );
        return result.rows;
      });
      expect(last).toHaveLength(5);
    });

    it('[T059][US4-AC9][FR-027] filtra por taller, por agente y por ambos', async () => {
      const aByAgent = await insertAccessLog(agent.id, tenantA.id, 3);
      const bByAgent = await insertAccessLog(agent.id, tenantB.id, 2);
      const aByOther = await insertAccessLog(otherAgent.id, tenantA.id, 1);

      const query = (tenantId: string | null, agentId: string | null) =>
        asApp(null, async (client) => {
          const result = await client.query<{ entry_id: string }>(
            'SELECT entry_id FROM support_list_access_log($1, $2, $3, 50, 0)',
            [agentSessionId, tenantId, agentId],
          );
          return result.rows.map((row) => row.entry_id);
        });

      expect(await query(tenantA.id, null)).toEqual([aByOther, aByAgent]);
      expect(await query(null, agent.id)).toEqual([bByAgent, aByAgent]);
      expect(await query(tenantA.id, otherAgent.id)).toEqual([aByOther]);
      expect(await query(tenantB.id, otherAgent.id)).toEqual([]);
    });
  });
});
