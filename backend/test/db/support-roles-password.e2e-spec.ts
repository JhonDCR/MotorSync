// T044 (specs/003-soporte-plataforma): database design of support password reset functions and audit actor (research R9, R11; data-model.md).
// Principle I of constitution 1.3.0: support reset operations run under strictly bounded SECURITY DEFINER
// functions owned by motorsync_support (NOLOGIN, NOBYPASSRLS, NOINHERIT), requiring a live support session.
// Migration 1761000001300-AllowSupportAuditActor adjusts audit_log_actor_role_check to allow 'platform_support'.
// Migration 1761000001400-CreateSupportPasswordFunctions defines support_lock_open_ticket and support_resolve_ticket.
// This is the RED test of T044: migrations 1761000001300 and 1761000001400 (T045) do not exist yet,
// so the suite must fail on missing constraint values and missing functions.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  closeFixtures,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  readTicketEvents,
  readTickets,
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

interface LockOpenTicketRow {
  tenant_id: string;
  user_id: string;
  number: string;
  status: string;
}

const PASSWORD_FUNCTIONS = [
  'support_lock_open_ticket(uuid,uuid)',
  'support_resolve_ticket(uuid,uuid,text,text)',
] as const;

const PASSWORD = 'Soporte-Password-1234';

let appPool: pg.Pool;
let migratorPool: pg.Pool;

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

/** Inserts a live support session as the migrator (table has RLS ENABLE without FORCE). */
async function createSupportSession(accountId: string): Promise<string> {
  const result = await migratorPool.query<{ id: string }>(
    'INSERT INTO support_sessions (support_account_id) VALUES ($1) RETURNING id',
    [accountId],
  );
  return result.rows[0].id;
}

interface AuditInput {
  actorRole?: string;
  actorUserId?: string;
  actorName?: string;
  action?: string;
  reason?: string | null;
  tenantId?: string;
}

function insertAudit(
  client: pg.PoolClient,
  input: AuditInput = {},
): Promise<
  pg.QueryResult<{
    id: string;
    tenant_id: string;
    actor_role: string;
    channel: string;
    occurred_at: Date;
  }>
> {
  const columns = [
    'actor_user_id',
    'actor_name',
    'actor_role',
    'action',
    'entity_type',
    'entity_id',
    'before',
    'after',
    'reason',
  ];
  const reason =
    input.reason !== undefined
      ? input.reason
      : input.actorRole === 'asesor'
        ? 'Motivo de asesor con longitud valida'
        : null;

  const values: unknown[] = [
    input.actorUserId ?? randomUUID(),
    input.actorName ?? 'Ana Admin',
    input.actorRole ?? 'admin',
    input.action ?? 'user.password_reset_by_support',
    'user',
    randomUUID(),
    JSON.stringify({ mustChangePassword: false }),
    JSON.stringify({ mustChangePassword: true }),
    reason,
  ];
  if (input.tenantId !== undefined) {
    columns.push('tenant_id');
    values.push(input.tenantId);
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  return client.query(
    `INSERT INTO audit_log (${columns.join(', ')}) VALUES (${placeholders})
     RETURNING id, tenant_id, actor_role, channel, occurred_at`,
    values,
  );
}

/** Seeds two workshops with accounts and an active support agent with a live session. */
async function seedWorkshops(): Promise<void> {
  await truncateBusinessTables();
  tenantA = await createTenant('Taller A (support password)', randomRuc());
  tenantB = await createTenant('Taller B (support password)', randomRuc());
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

describe('Contraseña temporal por soporte y actor de auditoría en la BD (T044, PR2, US3, R9, R11)', () => {
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
  });

  afterAll(async () => {
    await truncateBusinessTables();
    await appPool?.end();
    await migratorPool?.end();
    await closeFixtures();
  });

  describe('(a) Migración 1761000001300: CHECK audit_log_actor_role_check (R11, FR-020)', () => {
    beforeEach(seedWorkshops);

    it('[T044][US3-AC6][R11] audit_log_actor_role_check acepta platform_support', async () => {
      const rowCount = await asApp(
        tenantA.id,
        async (client) => {
          const result = await insertAudit(client, {
            actorRole: 'platform_support',
            actorUserId: agent.id,
            actorName: 'Soporte MotorSync (Agente Soporte)',
            action: 'user.password_reset_by_support',
          });
          return result.rowCount;
        },
        'commit',
      );
      expect(rowCount).toBe(1);

      const rows = await asApp(tenantA.id, async (client) => {
        const result = await client.query<{
          actor_role: string;
          actor_name: string;
        }>(
          'SELECT actor_role, actor_name FROM audit_log WHERE actor_role = $1',
          ['platform_support'],
        );
        return result.rows;
      });
      expect(rows).toEqual([
        {
          actor_role: 'platform_support',
          actor_name: 'Soporte MotorSync (Agente Soporte)',
        },
      ]);
    });

    it('[T044][US3-AC6][R11] audit_log_actor_role_check sigue aceptando admin y asesor', async () => {
      const counts = await asApp(
        tenantA.id,
        async (client) => [
          (await insertAudit(client, { actorRole: 'admin' })).rowCount,
          (
            await insertAudit(client, {
              actorRole: 'asesor',
              reason: 'Motivo obligatorio de asesor',
            })
          ).rowCount,
        ],
        'commit',
      );
      expect(counts).toEqual([1, 1]);
    });

    it('[T044][US3-AC6][R11] audit_log_actor_role_check rechaza valores no permitidos como other o mecanico', async () => {
      for (const invalidRole of ['other', 'mecanico', 'support', 'operador']) {
        const error = await expectSqlState(
          asApp(tenantA.id, (client) =>
            insertAudit(client, { actorRole: invalidRole }),
          ),
          '23514',
        );
        expect(error.constraint).toBe('audit_log_actor_role_check');
      }
    });

    it('[T044][FR-025][Principio I] aislamiento de audit_log con actor platform_support entre tenant A y tenant B', async () => {
      await asApp(
        tenantA.id,
        (client) =>
          insertAudit(client, {
            actorRole: 'platform_support',
            actorUserId: agent.id,
            actorName: 'Soporte MotorSync (Agente Soporte)',
          }),
        'commit',
      );

      const recordsInB = await asApp(tenantB.id, async (client) => {
        const result = await client.query<{ count: string }>(
          `SELECT count(*) FROM audit_log WHERE actor_role = 'platform_support'`,
        );
        return Number(result.rows[0].count);
      });
      expect(recordsInB).toBe(0);
    });
  });

  describe('(b) Migración 1761000001400: DDL y permisos de las funciones (R9, data-model.md)', () => {
    it('[T044][Principio I 1.3.0] son SECURITY DEFINER, de motorsync_support y fijan search_path', async () => {
      for (const signature of PASSWORD_FUNCTIONS) {
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

    it('[T044][Principio I 1.3.0] ninguna concede EXECUTE a PUBLIC y ambas conceden EXECUTE a motorsync_app', async () => {
      for (const signature of PASSWORD_FUNCTIONS) {
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
        expect(fn.has_acl, `${signature} has an explicit ACL`).toBe(true);
        expect(fn.public_execute, `${signature} EXECUTE for PUBLIC`).toBe(0);
        expect(
          fn.app_can_execute,
          `${signature} EXECUTE for motorsync_app`,
        ).toBe(true);
      }
    });
  });

  describe('(c) support_lock_open_ticket(p_session_id uuid, p_ticket_id uuid)', () => {
    beforeEach(seedWorkshops);

    it('[T044][US3-AC1][SC-006] con sesión válida y sin taller fijado devuelve tenant_id, user_id, number y status open', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const rows = await asApp(null, async (client) => {
        const result = await client.query<LockOpenTicketRow>(
          'SELECT tenant_id, user_id, number, status FROM support_lock_open_ticket($1, $2)',
          [agentSessionId, ticket.id],
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        tenant_id: tenantA.id,
        user_id: userA.id,
        number: ticket.number,
        status: 'open',
      });
    });

    it('[T044][US3-AC5][SC-010] funciona también para un ticket cerrado (discarded o resolved)', async () => {
      const discardedTicket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
        status: 'discarded',
      });
      const resolvedTicket = await createTicket({
        tenantId: tenantB.id,
        userId: userB.id,
        email: userB.email,
        status: 'resolved',
      });

      const discardedRows = await asApp(null, async (client) => {
        const result = await client.query<LockOpenTicketRow>(
          'SELECT tenant_id, user_id, number, status FROM support_lock_open_ticket($1, $2)',
          [agentSessionId, discardedTicket.id],
        );
        return result.rows;
      });
      expect(discardedRows).toHaveLength(1);
      expect(discardedRows[0]).toMatchObject({
        tenant_id: tenantA.id,
        user_id: userA.id,
        status: 'discarded',
      });

      const resolvedRows = await asApp(null, async (client) => {
        const result = await client.query<LockOpenTicketRow>(
          'SELECT tenant_id, user_id, number, status FROM support_lock_open_ticket($1, $2)',
          [agentSessionId, resolvedTicket.id],
        );
        return result.rows;
      });
      expect(resolvedRows).toHaveLength(1);
      expect(resolvedRows[0]).toMatchObject({
        tenant_id: tenantB.id,
        user_id: userB.id,
        status: 'resolved',
      });
    });

    it('[T044][US3-AC5] devuelve 0 filas con un id de ticket inexistente', async () => {
      const rows = await asApp(null, async (client) => {
        const result = await client.query<LockOpenTicketRow>(
          'SELECT tenant_id, user_id, number, status FROM support_lock_open_ticket($1, $2)',
          [agentSessionId, randomUUID()],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('[T044][Principio I 1.3.0][US3-AC10] con taller fijado lanza error SQLSTATE 28000 (compuerta de contexto)', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const error = await expectSqlState(
        asApp(tenantA.id, (client) =>
          client.query(
            'SELECT * FROM support_lock_open_ticket($1, $2)',
            [agentSessionId, ticket.id],
          ),
        ),
        '28000',
      );
      expect(error.message).toMatch(/support functions run without a tenant/i);
    });

    it('[T044][US2-AC9][US2-AC10] sin sesión de soporte válida lanza SQLSTATE 28000 (compuerta de sesión)', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      // (1) UUID inexistente
      await expectSqlState(
        asApp(null, (client) =>
          client.query('SELECT * FROM support_lock_open_ticket($1, $2)', [
            randomUUID(),
            ticket.id,
          ]),
        ),
        '28000',
      );

      // (2) Sesión revocada
      const revokedSessionId = await createSupportSession(agent.id);
      await migratorPool.query(
        `UPDATE support_sessions
            SET revoked_at = now(), revoke_reason = 'logout'
          WHERE id = $1`,
        [revokedSessionId],
      );
      await expectSqlState(
        asApp(null, (client) =>
          client.query('SELECT * FROM support_lock_open_ticket($1, $2)', [
            revokedSessionId,
            ticket.id,
          ]),
        ),
        '28000',
      );

      // (3) Sesión inactiva > 30 minutos
      await setSupportSessionLastActivity(agentSessionId, 31);
      await expectSqlState(
        asApp(null, (client) =>
          client.query('SELECT * FROM support_lock_open_ticket($1, $2)', [
            agentSessionId,
            ticket.id,
          ]),
        ),
        '28000',
      );
    });
  });

  describe('(d) support_resolve_ticket(p_session_id uuid, p_ticket_id uuid, p_note text, p_ip text)', () => {
    beforeEach(seedWorkshops);

    it('[T044][US3-AC1][US3-AC3][FR-019] con el taller del ticket fijado y nota válida: devuelve resolved_at, deja ticket resolved con nota recortada y resolved_by = agent.id, e inserta evento temporary_password_generated', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const noteWithSpaces = '   Identidad verificada por videollamada con Ana.   ';
      const ip = '203.0.113.42';

      const resolvedAt = await asApp(
        tenantA.id,
        async (client) => {
          const result = await client.query<{ resolved_at: Date }>(
            'SELECT support_resolve_ticket($1, $2, $3, $4) AS resolved_at',
            [agentSessionId, ticket.id, noteWithSpaces, ip],
          );
          return result.rows[0].resolved_at;
        },
        'commit',
      );

      expect(resolvedAt).toBeInstanceOf(Date);

      // Ticket is now resolved with trimmed note and agent id
      const tickets = await readTickets(userA.id);
      expect(tickets).toHaveLength(1);
      const updatedTicket = tickets[0];
      expect(updatedTicket.status).toBe('resolved');
      expect(updatedTicket.verificationNote).toBe(
        'Identidad verificada por videollamada con Ana.',
      );
      expect(updatedTicket.resolvedBy).toBe(agent.id);
      expect(updatedTicket.resolvedAt).toBeInstanceOf(Date);
      expect(
        Math.abs(
          new Date(updatedTicket.resolvedAt!).getTime() -
            new Date(resolvedAt).getTime(),
        ),
      ).toBeLessThan(1000);

      // Event is recorded in support_ticket_events
      const events = await readTicketEvents(ticket.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        ticketId: ticket.id,
        supportAccountId: agent.id,
        action: 'temporary_password_generated',
        fromStatus: 'open',
        toStatus: 'resolved',
        ip,
      });
      expect(events[0].occurredAt).toBeInstanceOf(Date);
    });

    it('[T044][US3-AC3][FR-023] con nota vacía o de solo espacios lanza SQLSTATE 22023 sin modificar el ticket ni insertar eventos', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      for (const blankNote of ['   ', '', '        ']) {
        const error = await expectSqlState(
          asApp(tenantA.id, (client) =>
            client.query('SELECT support_resolve_ticket($1, $2, $3, $4)', [
              agentSessionId,
              ticket.id,
              blankNote,
              '203.0.113.42',
            ]),
          ),
          '22023',
        );
        expect(error.message).toMatch(/verification note required/i);
      }

      const tickets = await readTickets(userA.id);
      expect(tickets[0].status).toBe('open');
      expect(tickets[0].verificationNote).toBeNull();
      expect(await readTicketEvents(ticket.id)).toHaveLength(0);
    });

    it('[T044][Principio I 1.3.0][US3-AC10] sin taller fijado lanza SQLSTATE 55000 sin modificar ticket ni insertar eventos', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const error = await expectSqlState(
        asApp(null, (client) =>
          client.query('SELECT support_resolve_ticket($1, $2, $3, $4)', [
            agentSessionId,
            ticket.id,
            'Nota valida de verificacion',
            '203.0.113.42',
          ]),
        ),
        '55000',
      );
      expect(error.message).toMatch(/ticket not open for this tenant/i);

      const tickets = await readTickets(userA.id);
      expect(tickets[0].status).toBe('open');
      expect(await readTicketEvents(ticket.id)).toHaveLength(0);
    });

    it('[T044][Principio I][US3-AC9][US3-AC10] con el taller B fijado para un ticket del taller A lanza SQLSTATE 55000 sin modificaciones', async () => {
      const ticketA = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      const error = await expectSqlState(
        asApp(tenantB.id, (client) =>
          client.query('SELECT support_resolve_ticket($1, $2, $3, $4)', [
            agentSessionId,
            ticketA.id,
            'Nota valida de verificacion',
            '203.0.113.42',
          ]),
        ),
        '55000',
      );
      expect(error.message).toMatch(/ticket not open for this tenant/i);

      const ticketsA = await readTickets(userA.id);
      expect(ticketsA[0].status).toBe('open');
      expect(await readTicketEvents(ticketA.id)).toHaveLength(0);
    });

    it('[T044][US2-AC13][US3-AC5][US3-AC12] sobre un ticket ya resolved lanza SQLSTATE 55000', async () => {
      const resolvedTicket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
        status: 'resolved',
      });

      const error = await expectSqlState(
        asApp(tenantA.id, (client) =>
          client.query('SELECT support_resolve_ticket($1, $2, $3, $4)', [
            agentSessionId,
            resolvedTicket.id,
            'Segunda nota de verificacion',
            '203.0.113.42',
          ]),
        ),
        '55000',
      );
      expect(error.message).toMatch(/ticket not open for this tenant/i);
    });

    it('[T044][US2-AC9][US2-AC10] sin sesión de soporte válida lanza SQLSTATE 28000', async () => {
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: userA.id,
        email: userA.email,
      });

      await expectSqlState(
        asApp(tenantA.id, (client) =>
          client.query('SELECT support_resolve_ticket($1, $2, $3, $4)', [
            randomUUID(),
            ticket.id,
            'Nota de verificacion valida',
            '203.0.113.42',
          ]),
        ),
        '28000',
      );

      const tickets = await readTickets(userA.id);
      expect(tickets[0].status).toBe('open');
      expect(await readTicketEvents(ticket.id)).toHaveLength(0);
    });
  });
});
