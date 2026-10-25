// T002 (specs/003-soporte-plataforma): database design of `motorsync_support` (research R1, R2,
// R5, R6, R7, R8; data-model.md). Principle I of the constitution 1.3.0: cross-workshop reads are
// only allowed inside bounded SECURITY DEFINER functions owned by a NOLOGIN, NOBYPASSRLS,
// NOINHERIT role, which require a live support session and return the minimum columns.
// The app connects as motorsync_app (DATABASE_URL), exactly as the API does, and the fixtures and
// the direct DDL checks use motorsync_migrator (DATABASE_MIGRATOR_URL).
// This is the RED test of T002: migrations 1761000001000/1100/1200 (T005/T006) do not exist yet,
// so the suite fails on missing relations, columns and functions. That is expected.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  closeFixtures,
  countRows,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  emailHash,
  hashPassword,
  originHash,
  readTicketEvents,
  readTickets,
  setHelpThrottle,
  setSupportSessionLastActivity,
  setSupportTemporaryPasswordExpiry,
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

/** The 9 functions of migration 1761000001200-CreateSupportFunctions (data-model.md). */
const SUPPORT_FUNCTIONS = [
  'support_session_agent(uuid)',
  'support_require_platform_context()',
  'support_request_help(text,text)',
  'support_list_open_tickets(uuid)',
  'support_get_ticket(uuid,uuid)',
  'support_discard_ticket(uuid,uuid,text,text)',
  'support_workshop_email_exists(text)',
  'users_email_not_support()',
  'support_accounts_email_not_workshop()',
] as const;

/** The only four functions the API role may execute (research R1, R5, R7). */
const APP_EXECUTABLE = new Set<string>([
  'support_request_help(text,text)',
  'support_list_open_tickets(uuid)',
  'support_get_ticket(uuid,uuid)',
  'support_discard_ticket(uuid,uuid,text,text)',
]);

const SUPPORT_TABLES = [
  'support_accounts',
  'support_sessions',
  'support_refresh_tokens',
  'support_tickets',
  'support_ticket_events',
  'help_request_throttle',
] as const;

const WORKSHOP_TABLES = [
  'users',
  'user_sessions',
  'audit_log',
  'clients',
  'vehicles',
] as const;

const LIST_OPEN_TICKET_COLUMNS = [
  'ticket_id',
  'number',
  'created_at',
  'last_requested_at',
  'request_count',
  'email',
  'account_name',
  'account_role',
  'account_status',
  'workshop_name',
  'workshop_ruc',
] as const;

const GET_TICKET_COLUMNS = [
  'ticket_id',
  'number',
  'status',
  'created_at',
  'last_requested_at',
  'request_count',
  'email',
  'account_name',
  'account_role',
  'account_status',
  'workshop_name',
  'workshop_ruc',
  'verification_note',
  'resolved_by_name',
  'resolved_at',
  'discard_reason',
  'discarded_by_name',
  'discarded_at',
] as const;

interface OpenTicketRow {
  ticket_id: string;
  number: string;
  created_at: Date;
  last_requested_at: Date;
  request_count: number;
  email: string;
  account_name: string;
  account_role: string;
  account_status: string;
  workshop_name: string;
  workshop_ruc: string | null;
}

interface TicketDetailRow extends OpenTicketRow {
  status: string;
  verification_note: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  discard_reason: string | null;
  discarded_by_name: string | null;
  discarded_at: Date | null;
}

interface ThrottleRow {
  requestCount: number;
  windowStartedAt: Date;
}

const PASSWORD = 'Soporte-1234';

let appPool: pg.Pool;
let migratorPool: pg.Pool;
let passwordHash: string;

let tenantA: TenantFixture;
let tenantB: TenantFixture;
let userA: UserFixture;
let userB: UserFixture;
let agent: SupportAccountFixture;
let agentSessionId: string;

/** Runs fn in a transaction on `db`, with the tenant pinned (or not), and rolls back or commits. */
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

/** Same as asApp, but as the migrator with the tenant pinned (the FORCE RLS tables need it). */
function asMigratorTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(migratorPool, tenantId, fn, 'commit');
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

function expectPermissionDenied(error: PgError): void {
  expect(error.code).toBe('42501');
  expect(error.message).toMatch(/permission denied/i);
}

function columnNames(result: pg.QueryResult): string[] {
  return result.fields.map((field) => field.name);
}

/** Valid RUC shape for the CHECK of tenants.ruc: 10 digits followed by 001. */
function randomRuc(): string {
  const digits = Array.from(randomBytes(10), (byte) => String(byte % 10)).join(
    '',
  );
  return `${digits}001`;
}

/** Inserts a live support session as the migrator (the table has RLS ENABLE without FORCE). */
async function createSupportSession(accountId: string): Promise<string> {
  const result = await migratorPool.query<{ id: string }>(
    'INSERT INTO support_sessions (support_account_id) VALUES ($1) RETURNING id',
    [accountId],
  );
  return result.rows[0].id;
}

/**
 * The three panel functions of T002 must reject with SQLSTATE 28000 (R1). With `tenantId` the
 * platform-context gate fires; without it, the session gate does.
 */
async function expectPanelGatesDenied(
  sessionId: string,
  tenantId: string | null = null,
): Promise<void> {
  const ticketId = randomUUID();
  await expectSqlState(
    asApp(tenantId, (client) =>
      client.query('SELECT * FROM support_list_open_tickets($1)', [sessionId]),
    ),
    '28000',
  );
  await expectSqlState(
    asApp(tenantId, (client) =>
      client.query('SELECT * FROM support_get_ticket($1, $2)', [
        sessionId,
        ticketId,
      ]),
    ),
    '28000',
  );
  await expectSqlState(
    asApp(tenantId, (client) =>
      client.query('SELECT support_discard_ticket($1, $2, $3, $4)', [
        sessionId,
        ticketId,
        'motivo',
        '127.0.0.1',
      ]),
    ),
    '28000',
  );
}

/** Calls the public help function as the app, as POST /auth/forgot-password does (R7). */
async function requestHelp(email: string, ip: string): Promise<string> {
  const result = await asApp(
    null,
    (client) =>
      client.query<{ outcome: string }>(
        'SELECT support_request_help($1, $2) AS outcome',
        [email, originHash(ip)],
      ),
    'commit',
  );
  return result.rows[0].outcome;
}

/** Calls support_discard_ticket with the fixture agent session and commits (US2-AC12). */
async function discardTicket(
  ticketId: string,
  reason: string,
): Promise<string> {
  const result = await asApp(
    null,
    (client) =>
      client.query<{ outcome: string }>(
        'SELECT support_discard_ticket($1, $2, $3, $4) AS outcome',
        [agentSessionId, ticketId, reason, '203.0.113.20'],
      ),
    'commit',
  );
  return result.rows[0].outcome;
}

async function readThrottle(hash: string): Promise<ThrottleRow | undefined> {
  const result = await migratorPool.query<ThrottleRow>(
    `SELECT request_count AS "requestCount", window_started_at AS "windowStartedAt"
       FROM help_request_throttle
      WHERE origin_hash = $1`,
    [hash],
  );
  return result.rows[0];
}

/**
 * Columns of a table on which `role` has some privilege (information_schema, research R1).
 * Queried as the migrator because information_schema.column_privileges only exposes
 * grants whose grantor or grantee is a role enabled in the session: motorsync_app
 * cannot see the motorsync_support grants (support is NOINHERIT).
 */
async function columnPrivileges(
  role: string,
  table: string,
): Promise<string[]> {
  const result = await migratorPool.query<{ column_name: string }>(
    `SELECT DISTINCT column_name
       FROM information_schema.column_privileges
      WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2
      ORDER BY column_name`,
    [role, table],
  );
  return result.rows.map((row) => row.column_name);
}

/** Table-level privileges of `role` on `table`: one boolean per privilege of `names`. */
async function tablePrivileges(
  role: string,
  table: string,
  names: readonly string[],
): Promise<boolean[]> {
  const result = await migratorPool.query<{ granted: boolean }>(
    `SELECT has_table_privilege($1, $2, p.privilege) AS granted
       FROM unnest($3::text[]) AS p(privilege)`,
    [role, `public.${table}`, [...names]],
  );
  return result.rows.map((row) => row.granted);
}

const ALL_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

/** Creates the two workshops, their accounts and the fixture support agent + session. */
async function seedWorkshops(): Promise<void> {
  await truncateBusinessTables();
  tenantA = await createTenant('Taller A (support roles)', randomRuc());
  tenantB = await createTenant('Taller B (support roles)', randomRuc());
  userA = await createUser({
    tenantId: tenantA.id,
    name: 'Ana Admin',
    email: 'ana@taller-a.ec',
    role: 'admin',
    password: PASSWORD,
  });
  userB = await createUser({
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
  agentSessionId = await createSupportSession(agent.id);
}

describe('motorsync_support y RLS de la plataforma en la BD (T002, principio I 1.3.0, FR-005, FR-007, FR-014, FR-015, FR-024, FR-025)', () => {
  beforeAll(async () => {
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
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await truncateBusinessTables();
    await appPool?.end();
    await migratorPool?.end();
    await closeFixtures();
  });

  describe('(a) el rol motorsync_support', () => {
    it('[principio I 1.3.0] motorsync_support es NOLOGIN, NOBYPASSRLS, NOINHERIT y NOSUPERUSER', async () => {
      const result = await migratorPool.query<{
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
      }>(
        `SELECT rolcanlogin, rolbypassrls, rolinherit, rolsuper
           FROM pg_roles WHERE rolname = 'motorsync_support'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        rolcanlogin: false,
        rolbypassrls: false,
        rolinherit: false,
        rolsuper: false,
      });
    });

    it('[principio I 1.3.0] motorsync_app no es miembro de motorsync_support y SET ROLE falla con permission denied', async () => {
      const member = await migratorPool.query<{ member: boolean }>(
        `SELECT pg_has_role('motorsync_app', 'motorsync_support', 'MEMBER') AS member`,
      );
      expect(member.rows[0].member).toBe(false);

      const error = await expectPgError(
        asApp(null, (client) => client.query('SET ROLE motorsync_support')),
      );
      expectPermissionDenied(error);
    });

    it('[principio I 1.3.0] ningún rol no superusuario tiene BYPASSRLS', async () => {
      const result = await migratorPool.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY rolname`,
      );
      expect(result.rows).toEqual([]);
    });
  });

  describe('(b) las 9 funciones de la migración 1200', () => {
    it('[principio I 1.3.0] son SECURITY DEFINER, de motorsync_support y fijan search_path', async () => {
      for (const signature of SUPPORT_FUNCTIONS) {
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

    it('[principio I 1.3.0] ninguna concede EXECUTE a PUBLIC; la app solo a las 4 del panel y support_workshop_email_exists al migrator', async () => {
      for (const signature of SUPPORT_FUNCTIONS) {
        const result = await migratorPool.query<{
          has_acl: boolean;
          public_execute: number;
          app_can_execute: boolean;
          migrator_can_execute: boolean;
        }>(
          `SELECT p.proacl IS NOT NULL AS has_acl,
                  (SELECT count(*)::int FROM aclexplode(p.proacl) acl
                    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute,
                  has_function_privilege('motorsync_app', p.oid, 'EXECUTE') AS app_can_execute,
                  has_function_privilege('motorsync_migrator', p.oid, 'EXECUTE') AS migrator_can_execute
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [`public.${signature}`],
        );
        expect(result.rows, `${signature} should exist`).toHaveLength(1);
        const fn = result.rows[0];
        // A NULL proacl means the default privileges, which include EXECUTE for PUBLIC.
        expect(fn.has_acl, `${signature} has an explicit ACL`).toBe(true);
        expect(fn.public_execute, `${signature} EXECUTE for PUBLIC`).toBe(0);
        expect(
          fn.app_can_execute,
          `${signature} EXECUTE for motorsync_app`,
        ).toBe(APP_EXECUTABLE.has(signature));
      }

      const workshopLookup = await migratorPool.query<{
        app_can_execute: boolean;
        migrator_can_execute: boolean;
      }>(
        `SELECT has_function_privilege('motorsync_app', p.oid, 'EXECUTE') AS app_can_execute,
                has_function_privilege('motorsync_migrator', p.oid, 'EXECUTE') AS migrator_can_execute
           FROM pg_proc p WHERE p.oid = to_regprocedure('public.support_workshop_email_exists(text)')`,
      );
      expect(workshopLookup.rows[0]).toEqual({
        app_can_execute: false,
        migrator_can_execute: true,
      });
    });
  });

  describe('(c) RLS y privilegios de la app', () => {
    beforeEach(seedWorkshops);

    it('[principio I] las tablas de soporte tienen RLS habilitada sin FORCE y help_request_throttle no tiene RLS', async () => {
      const result = await migratorPool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relname = ANY($1::text[])
          ORDER BY relname`,
        [[...SUPPORT_TABLES]],
      );
      expect(result.rows).toEqual([
        {
          relname: 'help_request_throttle',
          relrowsecurity: false,
          relforcerowsecurity: false,
        },
        {
          relname: 'support_accounts',
          relrowsecurity: true,
          relforcerowsecurity: false,
        },
        {
          relname: 'support_refresh_tokens',
          relrowsecurity: true,
          relforcerowsecurity: false,
        },
        {
          relname: 'support_sessions',
          relrowsecurity: true,
          relforcerowsecurity: false,
        },
        {
          relname: 'support_ticket_events',
          relrowsecurity: true,
          relforcerowsecurity: false,
        },
        {
          relname: 'support_tickets',
          relrowsecurity: true,
          relforcerowsecurity: false,
        },
      ]);
    });

    it('[principio I] la app no tiene ningún privilegio sobre support_tickets, support_ticket_events ni help_request_throttle', async () => {
      for (const table of [
        'support_tickets',
        'support_ticket_events',
        'help_request_throttle',
      ]) {
        const granted = await tablePrivileges(
          'motorsync_app',
          table,
          ALL_TABLE_PRIVILEGES,
        );
        expect(granted, `${table} must grant nothing`).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
          false,
        ]);
      }

      const statements = [
        'SELECT count(*) FROM support_tickets',
        `INSERT INTO support_tickets (tenant_id, user_id, email)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'x@y.ec')`,
        'UPDATE support_tickets SET status = status',
        'DELETE FROM support_tickets',
        'SELECT count(*) FROM support_ticket_events',
        `INSERT INTO support_ticket_events (ticket_id, support_account_id, action, from_status, to_status)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'discarded', 'open', 'discarded')`,
        'UPDATE support_ticket_events SET ip = ip',
        'DELETE FROM support_ticket_events',
        'SELECT count(*) FROM help_request_throttle',
        `INSERT INTO help_request_throttle (origin_hash, request_count)
           VALUES (repeat('a', 64), 1)`,
        'UPDATE help_request_throttle SET request_count = request_count',
        'DELETE FROM help_request_throttle',
      ];
      for (const sql of statements) {
        const error = await expectPgError(
          asApp(null, (client) => client.query(sql)),
        );
        expectPermissionDenied(error);
      }
    });

    it('[FR-007][US2-AC2][SC-009] la app no puede crear ni borrar cuentas de soporte ni cambiar name, email o status', async () => {
      const statements = [
        `INSERT INTO support_accounts (name, email, password_hash)
           VALUES ('Otra Agente', 'otra@motorsync.ec', 'scrypt$32768$8$1$x$y')`,
        'DELETE FROM support_accounts',
        `UPDATE support_accounts SET name = 'Nombre Cambiado'`,
        `UPDATE support_accounts SET email = 'cambiada@motorsync.ec'`,
        `UPDATE support_accounts SET status = 'inactive'`,
      ];
      for (const sql of statements) {
        const error = await expectPgError(
          asApp(null, (client) => client.query(sql)),
        );
        expectPermissionDenied(error);
      }

      // Nothing changed.
      const stored = await migratorPool.query<{
        name: string;
        email: string;
        status: string;
      }>('SELECT name, email, status FROM support_accounts WHERE id = $1', [
        agent.id,
      ]);
      expect(stored.rows).toEqual([
        {
          name: agent.name,
          email: agent.email,
          status: 'active',
        },
      ]);
    });

    it('[FR-007][US2-AC2][SC-009] la app sí puede cambiar password_hash sin taller fijado', async () => {
      const updated = await asApp(
        null,
        (client) =>
          client.query(
            'UPDATE support_accounts SET password_hash = $1 WHERE id = $2',
            [passwordHash, agent.id],
          ),
        'commit',
      );
      expect(updated.rowCount).toBe(1);

      const stored = await migratorPool.query<{ password_hash: string }>(
        'SELECT password_hash FROM support_accounts WHERE id = $1',
        [agent.id],
      );
      expect(stored.rows[0].password_hash).toBe(passwordHash);
    });

    it('[principio I] sin taller fijado la app ve las tablas de plataforma; con el taller A ve 0 filas y no puede insertar sesiones', async () => {
      const visible = await asApp(null, (client) =>
        client.query<{ accounts: number; sessions: number }>(
          `SELECT (SELECT count(*)::int FROM support_accounts) AS accounts,
                  (SELECT count(*)::int FROM support_sessions) AS sessions`,
        ),
      );
      expect(visible.rows[0].accounts).toBeGreaterThanOrEqual(1);
      expect(visible.rows[0].sessions).toBeGreaterThanOrEqual(1);

      const hidden = await asApp(tenantA.id, (client) =>
        client.query<{ accounts: number; sessions: number }>(
          `SELECT (SELECT count(*)::int FROM support_accounts) AS accounts,
                  (SELECT count(*)::int FROM support_sessions) AS sessions`,
        ),
      );
      expect(hidden.rows[0]).toEqual({ accounts: 0, sessions: 0 });

      const error = await expectPgError(
        asApp(tenantA.id, (client) =>
          client.query(
            'INSERT INTO support_sessions (support_account_id) VALUES ($1)',
            [agent.id],
          ),
        ),
      );
      expect(error.code).toBe('42501');
      expect(error.message).toMatch(/row-level security/i);
    });

    it('[FR-025] las tablas del taller conservan RLS habilitada y forzada', async () => {
      const result = await migratorPool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relname = ANY($1::text[])
          ORDER BY relname`,
        [[...WORKSHOP_TABLES]],
      );
      expect(result.rows).toEqual([
        {
          relname: 'audit_log',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          relname: 'clients',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          relname: 'user_sessions',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        { relname: 'users', relrowsecurity: true, relforcerowsecurity: true },
        {
          relname: 'vehicles',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ]);
    });
  });

  describe('(d) columnas de motorsync_support', () => {
    it('[principio I 1.3.0] en tenants, users y support_accounts solo tiene las columnas mínimas', async () => {
      expect(await columnPrivileges('motorsync_support', 'tenants')).toEqual([
        'created_at',
        'id',
        'name',
        'ruc',
      ]);
      expect(await columnPrivileges('motorsync_support', 'users')).toEqual([
        'email',
        'id',
        'name',
        'role',
        'status',
        'tenant_id',
      ]);
      expect(
        await columnPrivileges('motorsync_support', 'support_accounts'),
      ).toEqual(['email', 'id', 'must_change_password', 'name', 'status']);
    });

    it('[FR-025] no tiene privilegios sobre password_hash, sesiones de taller, intentos, clientes, vehículos ni auditoría', async () => {
      const passwordHashPrivilege = await migratorPool.query<{
        granted: boolean;
      }>(
        `SELECT has_column_privilege('motorsync_support', 'public.users', 'password_hash', 'SELECT') AS granted`,
      );
      expect(passwordHashPrivilege.rows[0].granted).toBe(false);

      for (const table of [
        'user_sessions',
        'refresh_tokens',
        'login_attempts',
        'clients',
        'vehicles',
        'audit_log',
      ]) {
        const granted = await tablePrivileges(
          'motorsync_support',
          table,
          ALL_TABLE_PRIVILEGES,
        );
        expect(granted, `${table} must grant nothing`).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
          false,
        ]);
      }
    });
  });

  describe('(e) compuertas de las funciones del panel (R1)', () => {
    beforeEach(seedWorkshops);

    it('[principio I 1.3.0] con un uuid de sesión al azar lanzan 28000', async () => {
      await expectPanelGatesDenied(randomUUID());
    });

    it('[principio I 1.3.0] una sesión revocada lanza 28000', async () => {
      await migratorPool.query(
        `UPDATE support_sessions
            SET revoked_at = now(), revoke_reason = 'logout'
          WHERE id = $1`,
        [agentSessionId],
      );
      await expectPanelGatesDenied(agentSessionId);
    });

    it('[principio I 1.3.0] una sesión con 31 minutos de inactividad lanza 28000', async () => {
      await setSupportSessionLastActivity(agentSessionId, 31);
      await expectPanelGatesDenied(agentSessionId);
    });

    it('[principio I 1.3.0] una cuenta inactive lanza 28000', async () => {
      await migratorPool.query(
        `UPDATE support_accounts SET status = 'inactive' WHERE id = $1`,
        [agent.id],
      );
      await expectPanelGatesDenied(agentSessionId);
    });

    it('[principio I 1.3.0] una cuenta con must_change_password lanza 28000', async () => {
      await setSupportTemporaryPasswordExpiry(agent.id, 72);
      await expectPanelGatesDenied(agentSessionId);
    });

    it('[principio I 1.3.0] una sesión válida con el taller A fijado lanza 28000 (compuerta de contexto)', async () => {
      await expectPanelGatesDenied(agentSessionId, tenantA.id);
    });
  });

  describe('(f) columnas devueltas por las funciones de lectura', () => {
    beforeEach(seedWorkshops);

    it('[principio I 1.3.0] support_list_open_tickets devuelve las 11 columnas, ordenadas por created_at y number, con tickets de A y B', async () => {
      const ticketA = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
        createdAt: new Date(Date.now() - 3 * 60_000),
      });
      const ticketB = await createTicket({
        tenantId: tenantB.id,
        userId: userB.id,
        email: userB.email,
        createdAt: new Date(Date.now() - 60_000),
      });

      const result = await asApp(null, (client) =>
        client.query<OpenTicketRow>(
          'SELECT * FROM support_list_open_tickets($1)',
          [agentSessionId],
        ),
      );
      expect(columnNames(result)).toEqual([...LIST_OPEN_TICKET_COLUMNS]);
      expect(result.rows.map((row) => row.ticket_id)).toEqual([
        ticketA.id,
        ticketB.id,
      ]);
      expect(result.rows[0]).toMatchObject({
        number: ticketA.number,
        email: userA.email,
        account_name: userA.name,
        account_role: 'admin',
        account_status: 'active',
        workshop_name: tenantA.name,
        workshop_ruc: tenantA.ruc,
        request_count: 1,
      });
      expect(result.rows[1]).toMatchObject({
        number: ticketB.number,
        email: userB.email,
        account_name: userB.name,
        account_role: 'asesor',
        account_status: 'active',
        workshop_name: tenantB.name,
        workshop_ruc: tenantB.ruc,
        request_count: 1,
      });
    });

    it('[principio I 1.3.0] support_get_ticket devuelve exactamente sus 18 columnas y 0 filas con un id inexistente', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const found = await asApp(null, (client) =>
        client.query<TicketDetailRow>(
          'SELECT * FROM support_get_ticket($1, $2)',
          [agentSessionId, ticket.id],
        ),
      );
      expect(columnNames(found)).toEqual([...GET_TICKET_COLUMNS]);
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]).toMatchObject({
        ticket_id: ticket.id,
        number: ticket.number,
        status: 'open',
        email: userA.email,
        account_name: userA.name,
        workshop_name: tenantA.name,
        verification_note: null,
        resolved_by_name: null,
        resolved_at: null,
        discard_reason: null,
        discarded_by_name: null,
        discarded_at: null,
      });

      const missing = await asApp(null, (client) =>
        client.query<TicketDetailRow>(
          'SELECT * FROM support_get_ticket($1, $2)',
          [agentSessionId, randomUUID()],
        ),
      );
      expect(columnNames(missing)).toEqual([...GET_TICKET_COLUMNS]);
      expect(missing.rows).toHaveLength(0);
    });
  });

  describe('(g) support_request_help (R7, R8)', () => {
    beforeEach(seedWorkshops);

    it('[US1-AC3] con el correo de una cuenta de taller devuelve accepted y crea un ticket open del taller', async () => {
      const outcome = await requestHelp(userA.email, '203.0.113.10');
      expect(outcome).toBe('accepted');

      const tickets = await readTickets(userA.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
        status: 'open',
        requestCount: 1,
      });
    });

    it('[US1-AC3] una segunda solicitud no crea otro ticket y sube request_count y last_requested_at', async () => {
      expect(await requestHelp(userA.email, '203.0.113.10')).toBe('accepted');
      const [first] = await readTickets(userA.id);

      expect(await requestHelp(userA.email, '203.0.113.10')).toBe('accepted');
      const after = await readTickets(userA.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(first.id);
      expect(after[0].requestCount).toBe(2);
      expect(after[0].lastRequestedAt.getTime()).toBeGreaterThan(
        first.lastRequestedAt.getTime(),
      );
    });

    it('[US1-AC3] un correo inexistente devuelve accepted y no crea tickets', async () => {
      const before = await countRows('support_tickets');
      expect(await requestHelp('nadie@ejemplo.ec', '203.0.113.11')).toBe(
        'accepted',
      );
      expect(await countRows('support_tickets')).toBe(before);
    });

    it('[US1-AC10] el correo de una cuenta de soporte devuelve accepted y no crea tickets', async () => {
      const before = await countRows('support_tickets');
      expect(await requestHelp(agent.email, '203.0.113.12')).toBe('accepted');
      expect(await countRows('support_tickets')).toBe(before);
    });

    it('[US1-AC3] la solicitud 21 del mismo origen en la ventana devuelve rate_limited sin tocar tickets', async () => {
      const ip = '203.0.113.13';
      const hash = originHash(ip);
      await setHelpThrottle(hash, 20, 0);
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      expect(await requestHelp(userA.email, ip)).toBe('rate_limited');

      const tickets = await readTickets(userA.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].requestCount).toBe(ticket.requestCount);
      expect(tickets[0].lastRequestedAt.getTime()).toBe(
        ticket.lastRequestedAt.getTime(),
      );
      const throttle = await readThrottle(hash);
      expect(throttle?.requestCount).toBe(21);
    });

    it('[US1-AC3] una ventana de más de una hora reinicia el contador en 1', async () => {
      const ip = '203.0.113.14';
      const hash = originHash(ip);
      await setHelpThrottle(hash, 20, 61);

      expect(await requestHelp(userA.email, ip)).toBe('accepted');

      const throttle = await readThrottle(hash);
      expect(throttle?.requestCount).toBe(1);
      expect(throttle?.windowStartedAt.getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
      const tickets = await readTickets(userA.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].requestCount).toBe(1);
    });

    it('[FR-005] support_request_help no modifica users, user_sessions, login_attempts ni audit_log', async () => {
      await asMigratorTenant(tenantA.id, (client) =>
        client.query('INSERT INTO user_sessions (user_id) VALUES ($1)', [
          userA.id,
        ]),
      );
      await migratorPool.query(
        `INSERT INTO login_attempts (email_hash, failed_count) VALUES ($1, 2)`,
        [emailHash(userA.email)],
      );

      const before = {
        users: await countRows('users'),
        sessions: await countRows('user_sessions'),
        attempts: await countRows('login_attempts'),
        audit: await countRows('audit_log'),
      };

      expect(await requestHelp(userA.email, '203.0.113.15')).toBe('accepted');
      expect(await requestHelp(userA.email, '203.0.113.15')).toBe('accepted');
      expect(await requestHelp('nadie@ejemplo.ec', '203.0.113.16')).toBe(
        'accepted',
      );
      expect(await requestHelp(agent.email, '203.0.113.17')).toBe('accepted');
      await setHelpThrottle(originHash('203.0.113.18'), 20, 0);
      expect(await requestHelp(userA.email, '203.0.113.18')).toBe(
        'rate_limited',
      );

      expect({
        users: await countRows('users'),
        sessions: await countRows('user_sessions'),
        attempts: await countRows('login_attempts'),
        audit: await countRows('audit_log'),
      }).toEqual(before);

      const stored = await asMigratorTenant(tenantA.id, (client) =>
        client.query<{
          must_change_password: boolean;
          status: string;
          temp_password_expires_at: Date | null;
        }>(
          `SELECT must_change_password, status, temp_password_expires_at
             FROM users WHERE id = $1`,
          [userA.id],
        ),
      );
      expect(stored.rows[0]).toEqual({
        must_change_password: false,
        status: 'active',
        temp_password_expires_at: null,
      });
    });
  });

  describe('(h) tickets (R6)', () => {
    beforeEach(seedWorkshops);

    it('[SC-008] el índice único parcial impide un segundo open para la misma cuenta', async () => {
      await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const error = await expectPgError(
        migratorPool.query(
          `INSERT INTO support_tickets (tenant_id, user_id, email)
           VALUES ($1, $2, $3)`,
          [tenantA.id, userA.id, userA.email],
        ),
      );
      expect(error.code).toBe('23505');
      expect(error.constraint).toBe('support_tickets_one_open_per_user');
      expect(await readTickets(userA.id)).toHaveLength(1);
    });

    it('[FR-014] un ticket resuelto o descartado no impide un ticket open nuevo', async () => {
      await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
        status: 'resolved',
      });
      const afterResolved = await migratorPool.query(
        `INSERT INTO support_tickets (tenant_id, user_id, email)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantA.id, userA.id, userA.email],
      );
      expect(afterResolved.rowCount).toBe(1);

      await createTicket({
        tenantId: tenantB.id,
        userId: userB.id,
        email: userB.email,
        status: 'discarded',
      });
      const afterDiscarded = await migratorPool.query(
        `INSERT INTO support_tickets (tenant_id, user_id, email)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantB.id, userB.id, userB.email],
      );
      expect(afterDiscarded.rowCount).toBe(1);
    });

    it('[FR-014][FR-015] un ticket cerrado es inmutable y ningún ticket se borra', async () => {
      const discarded = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
        status: 'discarded',
      });
      const updateError = await expectPgError(
        migratorPool.query(
          `UPDATE support_tickets SET discard_reason = 'otro motivo' WHERE id = $1`,
          [discarded.id],
        ),
      );
      expect(updateError.message).toMatch(
        /closed support tickets are immutable/,
      );

      const open = await createTicket({
        tenantId: tenantB.id,
        userId: userB.id,
        email: userB.email,
      });
      const deleteError = await expectPgError(
        migratorPool.query('DELETE FROM support_tickets WHERE id = $1', [
          open.id,
        ]),
      );
      expect(deleteError.message).toMatch(
        /support_tickets rows are never deleted/,
      );
      expect(await readTickets(userB.id)).toHaveLength(1);
    });

    it('[FR-015] support_ticket_events es append-only', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });
      const inserted = await migratorPool.query<{ id: string }>(
        `INSERT INTO support_ticket_events
           (ticket_id, support_account_id, action, from_status, to_status)
         VALUES ($1, $2, 'discarded', 'open', 'discarded') RETURNING id`,
        [ticket.id, agent.id],
      );

      const updateError = await expectPgError(
        migratorPool.query(
          `UPDATE support_ticket_events SET ip = '127.0.0.1' WHERE id = $1`,
          [inserted.rows[0].id],
        ),
      );
      expect(updateError.message).toMatch(/audit_log is append-only/);

      const deleteError = await expectPgError(
        migratorPool.query('DELETE FROM support_ticket_events WHERE id = $1', [
          inserted.rows[0].id,
        ]),
      );
      expect(deleteError.message).toMatch(/audit_log is append-only/);
      expect(await readTicketEvents(ticket.id)).toHaveLength(1);
    });

    it('[FR-014] la FK compuesta y el CHECK de coherencia rechazan tickets incoherentes', async () => {
      const fkError = await expectPgError(
        migratorPool.query(
          `INSERT INTO support_tickets (tenant_id, user_id, email)
           VALUES ($1, $2, $3)`,
          [tenantA.id, userB.id, userB.email],
        ),
      );
      expect(fkError.code).toBe('23503');
      expect(fkError.constraint).toBe('support_tickets_user_fk');

      const checkError = await expectPgError(
        migratorPool.query(
          `INSERT INTO support_tickets
             (tenant_id, user_id, email, status, resolved_by, resolved_at)
           VALUES ($1, $2, $3, 'resolved', $4, now())`,
          [tenantA.id, userA.id, userA.email, agent.id],
        ),
      );
      expect(checkError.code).toBe('23514');
      expect(checkError.constraint).toBe('support_tickets_state_coherent');
    });
  });

  describe('(i) support_discard_ticket', () => {
    beforeEach(seedWorkshops);

    it('[FR-014] exige un motivo con contenido (22023) y deja el ticket open', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const error = await expectSqlState(
        asApp(null, (client) =>
          client.query('SELECT support_discard_ticket($1, $2, $3, $4)', [
            agentSessionId,
            ticket.id,
            '   ',
            '203.0.113.20',
          ]),
        ),
        '22023',
      );
      expect(error.message).toMatch(/discard reason required/);
      const [stored] = await readTickets(userA.id);
      expect(stored.status).toBe('open');
    });

    it('[FR-014] descarta, recorta el motivo y registra el agente de la sesión', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      expect(await discardTicket(ticket.id, '   duplicado   ')).toBe(
        'discarded',
      );

      const [stored] = await readTickets(userA.id);
      expect(stored).toMatchObject({
        status: 'discarded',
        discardReason: 'duplicado',
        discardedBy: agent.id,
      });
      expect(stored.discardedAt).toBeInstanceOf(Date);

      const events = await readTicketEvents(ticket.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        supportAccountId: agent.id,
        action: 'discarded',
        fromStatus: 'open',
        toStatus: 'discarded',
        ip: '203.0.113.20',
      });
    });

    it('[FR-014] una segunda llamada devuelve not_open y un id inexistente not_found', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      expect(await discardTicket(ticket.id, 'duplicado')).toBe('discarded');
      expect(await discardTicket(ticket.id, 'duplicado')).toBe('not_open');
      expect(await discardTicket(randomUUID(), 'duplicado')).toBe('not_found');
    });
  });

  describe('(j) FR-024 en ambos sentidos (R5)', () => {
    beforeEach(seedWorkshops);

    it('[FR-024] support_accounts rechaza el correo de una cuenta de taller', async () => {
      const error = await expectPgError(
        migratorPool.query(
          `INSERT INTO support_accounts (name, email, password_hash)
           VALUES ('Otra Agente', $1, $2)`,
          [userA.email, passwordHash],
        ),
      );
      expect(error.code).toBe('23505');
      expect(error.constraint).toBe('support_accounts_email_workshop');
    });

    it('[FR-024] users rechaza el correo de una cuenta de soporte sin mencionarla', async () => {
      const actor = randomUUID();
      const error = await expectPgError(
        asMigratorTenant(tenantA.id, (client) =>
          client.query(
            `INSERT INTO users
               (tenant_id, name, email, password_hash, role,
                created_by, updated_by, updated_by_name)
             VALUES ($1, 'Intrusa', $2, $3, 'asesor', $4, $4, 'Intrusa')`,
            [tenantA.id, agent.email, passwordHash, actor],
          ),
        ),
      );
      expect(error.code).toBe('23505');
      expect(error.constraint).toBe('users_email_key');
      expect(error.message.toLowerCase()).not.toContain('support');
    });

    it('[FR-024] support_workshop_email_exists responde como migrator y da permission denied a la app', async () => {
      const found = await migratorPool.query<{ exists: boolean }>(
        'SELECT support_workshop_email_exists($1) AS exists',
        [userA.email],
      );
      expect(found.rows[0].exists).toBe(true);

      const missing = await migratorPool.query<{ exists: boolean }>(
        'SELECT support_workshop_email_exists($1) AS exists',
        ['nadie@ejemplo.ec'],
      );
      expect(missing.rows[0].exists).toBe(false);

      const error = await expectPgError(
        asApp(null, (client) =>
          client.query('SELECT support_workshop_email_exists($1)', [
            userA.email,
          ]),
        ),
      );
      expectPermissionDenied(error);
    });
  });
});
