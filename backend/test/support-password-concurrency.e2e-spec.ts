// T049 (specs/003-soporte-plataforma, Phase 7, US3): e2e of concurrency and atomicity for
// temporary password generation by platform support (`POST /api/v1/support/tickets/{ticketId}/temporary-password`)
// over the full app wiring (AppModule + configureApp) and the real PostgreSQL (API as motorsync_app,
// fixtures/triggers as motorsync_migrator).
//
// Covered: US3-AC7, US3-AC11, US3-AC12, FR-021, SC-006, SC-008, SC-010.
//
// Explicit lock order assertion (research R9, extension of research R8 of feature 002):
//   sesión de soporte propia → ticket (FOR UPDATE) → advisory lock del taller → sesiones del objetivo → fila de users
//
// Why this lock order is deadlock-free (no 40P01):
// - Support temporary password (`POST /support/tickets/{id}/temporary-password`):
//   1. Own `support_sessions` row (`SupportSessionValidator` in `SupportTransactionInterceptor`).
//   2. `support_tickets` row (`FOR UPDATE` in `support_lock_open_ticket`).
//   3. Workshop advisory lock (`pg_advisory_xact_lock(hashtextextended('users-admins:' || tenant_id, 0))`).
//   4. Target `user_sessions` rows (`UPDATE user_sessions ... WHERE user_id = $1 AND revoked_at IS NULL`).
//   5. Target `users` row (`UPDATE users ... WHERE id = $1`).
// - Workshop admin password-reset (`POST /users/{id}/password-reset`):
//   workshop advisory lock → admin `user_sessions` → target `user_sessions` → target `users`.
// - Self password change (`POST /auth/password` of Luis):
//   workshop advisory lock → Luis `user_sessions` → Luis `users`.
// - Workshop login (`POST /auth/login` of Luis):
//   Luis `users` (`FOR SHARE`) before opening session; serialized with `UPDATE users` (`FOR UPDATE`).
// - Help request (`POST /auth/forgot-password`):
//   `help_request_throttle` → `support_tickets` (`ON CONFLICT (user_id) WHERE status = 'open' DO UPDATE`),
//   without taking the workshop advisory lock.
// No workshop path ever locks `support_sessions` or `support_tickets` after the workshop advisory
// lock, and no support path ever locks a ticket after taking the workshop advisory lock.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, loginAs } from './setup/auth.js';
import {
  closeFixtures,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  emailHash,
  hashPassword,
  readAuditLog,
  readTicketEvents,
  readTickets,
  readUserSessions,
  setLockedUntil,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  enableTrustProxyForTests,
  forgotPassword,
  loginAsSupport,
  type SupportLoginResult,
} from './setup/support.js';

/**
 * Explicit assertion of the research R9 lock acquisition chain.
 * Any change to the lock order must update R9 and this constant.
 */
export const R9_SUPPORT_PASSWORD_LOCK_ORDER = [
  'sesión de soporte propia',
  'ticket (FOR UPDATE)',
  'advisory lock del taller',
  'sesiones del objetivo',
  'fila de users',
] as const;

const PASSWORD = 'Clave-Segura-123';
const NEW_PASSWORD_LUIS = 'Nueva-Clave-Luis-456';
const ADMIN_TEMP_PASSWORD = 'Temporal-Admin-789';
const SUPPORT_TICKETS = '/api/v1/support/tickets';
const ROUNDS = 10;
const ROUND_TEST_TIMEOUT = 180_000;

interface Outcome {
  status: number;
  code: string | undefined;
}

interface WorkshopUserSnapshot {
  passwordHash: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
  updatedBy: string;
  updatedByName: string;
}

interface AttemptRow {
  failed_count: number;
  locked_until: Date | null;
}

function outcomeOf(res: Response): Outcome {
  return { status: res.status, code: (res.body as { code?: string })?.code };
}

function label(outcome: Outcome): string {
  return outcome.code
    ? `${outcome.status} ${outcome.code}`
    : `${outcome.status}`;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

describe('Support temporary password concurrency & atomicity (e2e, T049, US3, R9)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let ana: UserFixture;
  let luis: UserFixture;
  let luisPasswordHash: string;
  let pedro: SupportAccountFixture;
  let marta: SupportAccountFixture;
  let pedroSession: SupportLoginResult;
  let martaSession: SupportLoginResult;

  function server() {
    return request(app.getHttpServer());
  }

  function generateTemporaryPassword(
    token: string,
    ticketId: string,
    verificationNote = 'Identidad verificada por teléfono.',
  ): Promise<Response> {
    return server()
      .post(`${SUPPORT_TICKETS}/${ticketId}/temporary-password`)
      .set(authHeader(token))
      .send({ verificationNote });
  }

  function discardTicket(
    token: string,
    ticketId: string,
    reason = 'Atendido directamente por su administrador.',
  ): Promise<Response> {
    return server()
      .post(`${SUPPORT_TICKETS}/${ticketId}/discard`)
      .set(authHeader(token))
      .send({ reason });
  }

  async function asMigratorInA<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantA.id,
      ]);
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

  async function readLuis(): Promise<WorkshopUserSnapshot> {
    return asMigratorInA(async (client) => {
      const result = await client.query<WorkshopUserSnapshot>(
        `SELECT password_hash AS "passwordHash", role, status,
                must_change_password AS "mustChangePassword",
                temp_password_expires_at AS "tempPasswordExpiresAt",
                updated_by AS "updatedBy",
                updated_by_name AS "updatedByName"
           FROM users
          WHERE id = $1`,
        [luis.id],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    });
  }

  async function loginAttempt(email: string): Promise<AttemptRow | undefined> {
    const result = await migratorPool.query<AttemptRow>(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0];
  }

  async function loginStatus(
    email: string,
    password: string,
  ): Promise<Outcome> {
    return outcomeOf(
      await server().post('/api/v1/auth/login').send({ email, password }),
    );
  }

  /**
   * Resets Luis between rounds: active, original passwordHash, mustChangePassword = false,
   * revokes any open sessions, clears login_attempts, and removes any tickets/events/audit_log
   * rows of Luis so each round starts from a clean slate.
   */
  async function resetLuisState(): Promise<void> {
    await asMigratorInA(async (client) => {
      await client.query(
        `UPDATE user_sessions
            SET revoked_at = now(), revoke_reason = 'logout'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [luis.id],
      );
      await client.query(
        `UPDATE users
            SET status = 'active',
                role = 'asesor',
                password_hash = $2,
                must_change_password = false,
                temp_password_expires_at = NULL,
                updated_by = $1,
                updated_by_name = $3
          WHERE id = $1`,
        [luis.id, luisPasswordHash, luis.name],
      );
    });
    await migratorPool.query(
      'DELETE FROM login_attempts WHERE email_hash = $1',
      [emailHash(luis.email)],
    );
    // Clean tickets, ticket events, throttle and audit_log for clean per-round assertions.
    await migratorPool.query(
      'TRUNCATE public."support_ticket_events", public."support_tickets", public."help_request_throttle", public."audit_log" CASCADE',
    );
  }

  async function dropTemporaryFailureTriggers(): Promise<void> {
    await migratorPool.query(`
      DROP TRIGGER IF EXISTS test_fail_ticket_update ON support_tickets;
      DROP FUNCTION IF EXISTS test_fail_ticket_update_fn();
      DROP TRIGGER IF EXISTS test_fail_ticket_event_insert ON support_ticket_events;
      DROP FUNCTION IF EXISTS test_fail_ticket_event_insert_fn();
    `);
  }

  beforeAll(async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) {
      throw new Error(
        'DATABASE_MIGRATOR_URL is not set in the e2e environment',
      );
    }
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 4 });
    luisPasswordHash = await hashPassword(PASSWORD);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    enableTrustProxyForTests(app);
  });

  beforeEach(async () => {
    await dropTemporaryFailureTriggers();
    await truncateBusinessTables();
    tenantA = await createTenant(
      `Taller A support concurrency ${randomUUID()}`,
      '1790012345001',
    );
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: uniqueEmail('ana'),
      role: 'admin',
      password: PASSWORD,
    });
    luis = await createUser({
      tenantId: tenantA.id,
      name: 'Luis Mora',
      email: uniqueEmail('luis'),
      role: 'asesor',
      password: PASSWORD,
    });
    pedro = await createSupportAccount({
      name: 'Pedro Soporte',
      email: `pedro.${randomUUID().slice(0, 8)}@motorsync.ec`,
      password: PASSWORD,
      mustChangePassword: false,
    });
    marta = await createSupportAccount({
      name: 'Marta Soporte',
      email: `marta.${randomUUID().slice(0, 8)}@motorsync.ec`,
      password: PASSWORD,
      mustChangePassword: false,
    });
    pedroSession = await loginAsSupport(app, pedro.email, PASSWORD);
    martaSession = await loginAsSupport(app, marta.email, PASSWORD);
  });

  afterEach(async () => {
    await dropTemporaryFailureTriggers();
  });

  afterAll(async () => {
    await dropTemporaryFailureTriggers();
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  it('[R9] documenta y verifica la cadena de orden de locks de research R9', () => {
    expect(R9_SUPPORT_PASSWORD_LOCK_ORDER).toEqual([
      'sesión de soporte propia',
      'ticket (FOR UPDATE)',
      'advisory lock del taller',
      'sesiones del objetivo',
      'fila de users',
    ]);
  });

  // ---------------------------------------------------------------- US3-AC7 (atomicity)

  describe('[US3-AC7] atomicidad: si falla el cierre del ticket o el evento después de la auditoría, todo hace rollback', () => {
    it('[US3-AC7] trigger que rechaza el UPDATE de support_tickets → 500 y no cambian contraseña, sesiones, login_attempts, audit_log ni el ticket', async () => {
      const luisSession = await loginAs(app, luis.email, PASSWORD);
      await setLockedUntil(luis.email, 15);
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: luis.id,
        email: luis.email,
      });
      const beforeUser = await readLuis();
      const beforeAttempt = await loginAttempt(luis.email);
      expect(beforeAttempt?.failed_count).toBe(5);

      await migratorPool.query(`
        CREATE OR REPLACE FUNCTION test_fail_ticket_update_fn() RETURNS trigger
          LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'simulated failure on support_tickets UPDATE';
        END $$;
        CREATE TRIGGER test_fail_ticket_update
          BEFORE UPDATE ON support_tickets
          FOR EACH ROW EXECUTE FUNCTION test_fail_ticket_update_fn();
      `);

      const res = await generateTemporaryPassword(
        pedroSession.accessToken,
        ticket.id,
        'Nota que no debe persistir tras el fallo.',
      );
      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(res.body).not.toHaveProperty('temporaryPassword');

      // Nothing changed: password hash, mustChangePassword, sessions, login_attempts, audit_log, ticket.
      expect(await readLuis()).toEqual(beforeUser);
      expect(await loginAttempt(luis.email)).toEqual(beforeAttempt);
      expect(await readAuditLog(tenantA.id, luis.id)).toEqual([]);
      expect(await readTicketEvents(ticket.id)).toEqual([]);
      const [ticketAfter] = await readTickets(luis.id);
      expect(ticketAfter).toMatchObject({
        id: ticket.id,
        status: 'open',
        verificationNote: null,
        resolvedBy: null,
        resolvedAt: null,
      });
      // Luis's session is still alive.
      const me = await server()
        .get('/api/v1/auth/me')
        .set(authHeader(luisSession.accessToken));
      expect(me.status).toBe(200);
    });

    it('[US3-AC7] trigger que rechaza el INSERT en support_ticket_events (después de audit_log y del UPDATE del ticket) → 500 y todo hace rollback', async () => {
      const luisSession = await loginAs(app, luis.email, PASSWORD);
      await setLockedUntil(luis.email, 15);
      const ticket = await createTicket({
        tenantId: tenantA.id,
        userId: luis.id,
        email: luis.email,
      });
      const beforeUser = await readLuis();
      const beforeAttempt = await loginAttempt(luis.email);

      await migratorPool.query(`
        CREATE OR REPLACE FUNCTION test_fail_ticket_event_insert_fn() RETURNS trigger
          LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'simulated failure on support_ticket_events INSERT';
        END $$;
        CREATE TRIGGER test_fail_ticket_event_insert
          BEFORE INSERT ON support_ticket_events
          FOR EACH ROW EXECUTE FUNCTION test_fail_ticket_event_insert_fn();
      `);

      const res = await generateTemporaryPassword(
        pedroSession.accessToken,
        ticket.id,
        'Nota que tampoco debe persistir.',
      );
      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(res.body).not.toHaveProperty('temporaryPassword');

      expect(await readLuis()).toEqual(beforeUser);
      expect(await loginAttempt(luis.email)).toEqual(beforeAttempt);
      expect(await readAuditLog(tenantA.id, luis.id)).toEqual([]);
      expect(await readTicketEvents(ticket.id)).toEqual([]);
      const [ticketAfter] = await readTickets(luis.id);
      expect(ticketAfter.status).toBe('open');
      expect(ticketAfter.verificationNote).toBeNull();
      const me = await server()
        .get('/api/v1/auth/me')
        .set(authHeader(luisSession.accessToken));
      expect(me.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- US3-AC11 (vs workshop admin password-reset)

  it(
    `[US3-AC11][FR-021][SC-007] temporal de soporte y POST /users/{Luis}/password-reset del admin a la vez (${ROUNDS} rondas): ambas 200, sin 500 ni 40P01, 2 registros en audit_log, 0 sesiones vivas y solo sirve la temporal de la operación aplicada última`,
    async () => {
      const adminSession = await loginAs(app, ana.email, PASSWORD);
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuisState();
        await loginAs(app, luis.email, PASSWORD);
        const ticket = await createTicket({
          tenantId: tenantA.id,
          userId: luis.id,
          email: luis.email,
        });

        const [supportRes, adminRes] = await Promise.all([
          generateTemporaryPassword(
            pedroSession.accessToken,
            ticket.id,
            `Verificación soporte ronda ${round}.`,
          ),
          server()
            .post(`/api/v1/users/${luis.id}/password-reset`)
            .set(authHeader(adminSession.accessToken))
            .send({ temporaryPassword: ADMIN_TEMP_PASSWORD }),
        ]);

        const supportOut = outcomeOf(supportRes);
        const adminOut = outcomeOf(adminRes);
        if (supportOut.status >= 500 || adminOut.status >= 500) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        if (supportOut.status !== 200) {
          problems.push(`support=${label(supportOut)}`);
        }
        if (adminOut.status !== 200) {
          problems.push(`admin=${label(adminOut)}`);
        }

        const supportTemp = (
          supportRes.body as { temporaryPassword?: string }
        )?.temporaryPassword;
        if (!supportTemp) {
          problems.push('support response missing temporaryPassword');
        }

        // Luis must have 0 live sessions.
        const sessions = await readUserSessions(luis.id);
        const alive = sessions.filter((s) => s.revokedAt === null).length;
        if (alive !== 0) {
          problems.push(`${alive} sesiones de Luis siguen activas`);
        }

        // Exactly 2 audit_log entries in workshop A for Luis: one by support and one by admin.
        const audits = await readAuditLog(tenantA.id, luis.id);
        const actions = audits.map((a) => a.action).sort();
        if (
          audits.length !== 2 ||
          actions[0] !== 'user.password_reset' ||
          actions[1] !== 'user.password_reset_by_support'
        ) {
          problems.push(
            `audit_log esperaba [user.password_reset, user.password_reset_by_support], obtuvo [${actions.join(', ')}]`,
          );
        }

        // readAuditLog orders by (occurred_at, id) ascending, so audits[1] is the last applied.
        if (audits.length === 2 && supportTemp) {
          const lastAction = audits[1].action;
          const winnerPassword =
            lastAction === 'user.password_reset_by_support'
              ? supportTemp
              : ADMIN_TEMP_PASSWORD;
          const loserPassword =
            lastAction === 'user.password_reset_by_support'
              ? ADMIN_TEMP_PASSWORD
              : supportTemp;

          const loserLogin = await loginStatus(luis.email, loserPassword);
          if (label(loserLogin) !== '401 INVALID_CREDENTIALS') {
            problems.push(
              `la temporal primera (${lastAction === 'user.password_reset_by_support' ? 'admin' : 'soporte'}) debía dar 401 INVALID_CREDENTIALS y dio ${label(loserLogin)}`,
            );
          }

          const winnerLogin = await loginStatus(luis.email, winnerPassword);
          if (winnerLogin.status !== 200) {
            problems.push(
              `la temporal última (${lastAction}) debía dar 200 y dio ${label(winnerLogin)}`,
            );
          }
        }

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (support=${label(supportOut)}, admin=${label(adminOut)}): ${problems.join('; ')}`,
          );
        }
      }

      expect(
        violations,
        `${roundsWith500} de ${ROUNDS} rondas dieron 500:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
    ROUND_TEST_TIMEOUT,
  );

  // ---------------------------------------------------------------- US3-AC12 (two agents generating)

  it(
    `[US3-AC12][FR-021][SC-006][SC-010] dos agentes generan a la vez sobre el mismo ticket (${ROUNDS} rondas): exactamente un 200 y un 409 TICKET_NOT_OPEN, un registro de auditoría y un evento`,
    async () => {
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuisState();
        const ticket = await createTicket({
          tenantId: tenantA.id,
          userId: luis.id,
          email: luis.email,
        });

        const [pedroRes, martaRes] = await Promise.all([
          generateTemporaryPassword(
            pedroSession.accessToken,
            ticket.id,
            `Nota de Pedro ronda ${round}.`,
          ),
          generateTemporaryPassword(
            martaSession.accessToken,
            ticket.id,
            `Nota de Marta ronda ${round}.`,
          ),
        ]);

        const pedroOut = outcomeOf(pedroRes);
        const martaOut = outcomeOf(martaRes);
        if (pedroOut.status >= 500 || martaOut.status >= 500) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        const sortedLabels = [label(pedroOut), label(martaOut)].sort();
        if (
          sortedLabels[0] !== '200' ||
          sortedLabels[1] !== '409 TICKET_NOT_OPEN'
        ) {
          problems.push(
            `esperaba [200, 409 TICKET_NOT_OPEN], obtuvo [${sortedLabels.join(', ')}]`,
          );
        }

        const audits = await readAuditLog(tenantA.id, luis.id);
        if (audits.length !== 1) {
          problems.push(`audit_log=${audits.length} (esperaba 1)`);
        }

        const events = await readTicketEvents(ticket.id);
        if (
          events.length !== 1 ||
          events[0]?.action !== 'temporary_password_generated'
        ) {
          problems.push(`ticket_events=${events.length} (esperaba 1)`);
        }

        const [ticketRow] = await readTickets(luis.id);
        if (ticketRow?.status !== 'resolved') {
          problems.push(`ticket.status=${ticketRow?.status}`);
        }

        const winnerRes = pedroOut.status === 200 ? pedroRes : martaRes;
        const winnerTemp = (
          winnerRes.body as { temporaryPassword?: string }
        )?.temporaryPassword;
        if (winnerTemp) {
          const loginWin = await loginStatus(luis.email, winnerTemp);
          if (loginWin.status !== 200) {
            problems.push(`login con temporal ganadora=${label(loginWin)}`);
          }
        } else {
          problems.push('respuesta 200 sin temporaryPassword');
        }

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (Pedro=${label(pedroOut)}, Marta=${label(martaOut)}): ${problems.join('; ')}`,
          );
        }
      }

      expect(
        violations,
        `${roundsWith500} de ${ROUNDS} rondas dieron 500:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
    ROUND_TEST_TIMEOUT,
  );

  // ---------------------------------------------------------------- US3-AC12 (generate vs discard)

  it(
    `[US3-AC12][FR-021][SC-006][SC-010] un agente genera la temporal mientras otro descarta el mismo ticket (${ROUNDS} rondas): exactamente un 200 y un 409 TICKET_NOT_OPEN; si gana el descarte, la contraseña de Luis no cambia ni hay auditoría`,
    async () => {
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuisState();
        const ticket = await createTicket({
          tenantId: tenantA.id,
          userId: luis.id,
          email: luis.email,
        });

        const [genRes, discRes] = await Promise.all([
          generateTemporaryPassword(
            pedroSession.accessToken,
            ticket.id,
            `Nota de Pedro ronda ${round}.`,
          ),
          discardTicket(
            martaSession.accessToken,
            ticket.id,
            `Motivo de descarte de Marta ronda ${round}.`,
          ),
        ]);

        const genOut = outcomeOf(genRes);
        const discOut = outcomeOf(discRes);
        if (genOut.status >= 500 || discOut.status >= 500) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        const sortedLabels = [label(genOut), label(discOut)].sort();
        if (
          sortedLabels[0] !== '200' ||
          sortedLabels[1] !== '409 TICKET_NOT_OPEN'
        ) {
          problems.push(
            `esperaba [200, 409 TICKET_NOT_OPEN], obtuvo [gen=${label(genOut)}, discard=${label(discOut)}]`,
          );
        }

        const [ticketRow] = await readTickets(luis.id);
        const events = await readTicketEvents(ticket.id);
        const audits = await readAuditLog(tenantA.id, luis.id);
        const luisAfter = await readLuis();

        if (events.length !== 1) {
          problems.push(`ticket_events=${events.length} (esperaba 1)`);
        }

        if (genOut.status === 200) {
          // Generation won: ticket is resolved, 1 audit entry, Luis has temporary password.
          if (
            ticketRow?.status !== 'resolved' ||
            ticketRow.resolvedBy !== pedro.id ||
            ticketRow.discardedBy !== null
          ) {
            problems.push(
              `ticket incoherente tras ganar generación: ${JSON.stringify(ticketRow)}`,
            );
          }
          if (audits.length !== 1) {
            problems.push(`audit_log=${audits.length} (esperaba 1)`);
          }
          if (!luisAfter.mustChangePassword) {
            problems.push('Luis debía quedar con mustChangePassword=true');
          }
        } else if (discOut.status === 200) {
          // Discard won: ticket is discarded, 0 audit entries, Luis's password did not change.
          if (
            ticketRow?.status !== 'discarded' ||
            ticketRow.discardedBy !== marta.id ||
            ticketRow.resolvedBy !== null
          ) {
            problems.push(
              `ticket incoherente tras ganar descarte: ${JSON.stringify(ticketRow)}`,
            );
          }
          if (audits.length !== 0) {
            problems.push(`audit_log=${audits.length} (esperaba 0)`);
          }
          if (
            luisAfter.passwordHash !== luisPasswordHash ||
            luisAfter.mustChangePassword
          ) {
            problems.push('la contraseña de Luis cambió pese a ganar descarte');
          }
        }

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (gen=${label(genOut)}, discard=${label(discOut)}): ${problems.join('; ')}`,
          );
        }
      }

      expect(
        violations,
        `${roundsWith500} de ${ROUNDS} rondas dieron 500:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
    ROUND_TEST_TIMEOUT,
  );

  // ---------------------------------------------------------------- vs POST /auth/password of Luis

  it(
    `[R9][FR-021] POST /auth/password de Luis y generación de temporal por soporte a la vez (${ROUNDS} rondas): sin deadlock (40P01) ni 500; al terminar Luis tiene must_change_password = true, 0 sesiones vivas y 1 registro user.password_reset_by_support`,
    async () => {
      // Sequential orders allowed:
      // - Luis's password change first (200): his session survives the change, then support's
      //   reset revokes that session and replaces the password with the temporary one.
      // - Support's reset first (200): Luis's session is revoked before his change runs (401
      //   SESSION_REVOKED) or his old password no longer matches (400 CURRENT_PASSWORD_INCORRECT),
      //   so his password change does not apply.
      const allowedLuis = new Set([
        '200',
        '401 SESSION_REVOKED',
        '400 CURRENT_PASSWORD_INCORRECT',
      ]);
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuisState();
        const luisSession = await loginAs(app, luis.email, PASSWORD);
        const ticket = await createTicket({
          tenantId: tenantA.id,
          userId: luis.id,
          email: luis.email,
        });

        const [luisRes, supportRes] = await Promise.all([
          server()
            .post('/api/v1/auth/password')
            .set(authHeader(luisSession.accessToken))
            .send({
              currentPassword: PASSWORD,
              newPassword: NEW_PASSWORD_LUIS,
            }),
          generateTemporaryPassword(
            pedroSession.accessToken,
            ticket.id,
            `Nota frente a cambio de clave ronda ${round}.`,
          ),
        ]);

        const luisOut = outcomeOf(luisRes);
        const supportOut = outcomeOf(supportRes);
        if (luisOut.status >= 500 || supportOut.status >= 500) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        if (!allowedLuis.has(label(luisOut))) {
          problems.push(`Luis=${label(luisOut)}`);
        }
        if (supportOut.status !== 200) {
          problems.push(`support=${label(supportOut)}`);
        }

        // If Luis's change answered 200, the token returned by that change must now be revoked.
        if (luisOut.status === 200) {
          const changedToken =
            (luisRes.body as { accessToken?: string })?.accessToken ??
            luisSession.accessToken;
          const meAfter = outcomeOf(
            await server()
              .get('/api/v1/auth/me')
              .set(authHeader(changedToken)),
          );
          if (label(meAfter) !== '401 SESSION_REVOKED') {
            problems.push(
              `sesión conservada por Luis tras 200 sigue viva: GET /auth/me=${label(meAfter)}`,
            );
          }
        }

        const sessions = await readUserSessions(luis.id);
        const alive = sessions.filter((s) => s.revokedAt === null).length;
        if (alive !== 0) {
          problems.push(`${alive} sesiones de Luis siguen activas`);
        }

        const luisAfter = await readLuis();
        if (!luisAfter.mustChangePassword) {
          problems.push('mustChangePassword = false');
        }

        const audits = await readAuditLog(tenantA.id, luis.id);
        const supportAudits = audits.filter(
          (a) => a.action === 'user.password_reset_by_support',
        );
        if (supportAudits.length !== 1) {
          problems.push(
            `user.password_reset_by_support=${supportAudits.length} (esperaba 1)`,
          );
        }

        // Neither PASSWORD nor NEW_PASSWORD_LUIS works; only the support temporary password works.
        const withNew = await loginStatus(luis.email, NEW_PASSWORD_LUIS);
        if (label(withNew) !== '401 INVALID_CREDENTIALS') {
          problems.push(`login con NEW_PASSWORD_LUIS=${label(withNew)}`);
        }
        const supportTemp = (
          supportRes.body as { temporaryPassword?: string }
        )?.temporaryPassword;
        if (supportTemp) {
          const withTemp = await loginStatus(luis.email, supportTemp);
          if (withTemp.status !== 200) {
            problems.push(`login con temporal de soporte=${label(withTemp)}`);
          }
        } else {
          problems.push('support response sin temporaryPassword');
        }

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (Luis=${label(luisOut)}, support=${label(supportOut)}): ${problems.join('; ')}`,
          );
        }
      }

      expect(
        violations,
        `${roundsWith500} de ${ROUNDS} rondas dieron 500:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
    ROUND_TEST_TIMEOUT,
  );

  // ---------------------------------------------------------------- vs POST /auth/login of Luis

  it(
    `[R9][FR-021] POST /auth/login de Luis con su contraseña anterior y generación de temporal a la vez (${ROUNDS} rondas): nunca queda viva una sesión abierta con la contraseña anterior y nunca 500`,
    async () => {
      const LOGINS_PER_ROUND = 4;
      const STAGGER_MS = 30;
      const violations: string[] = [];
      let roundsWith500 = 0;

      const delayed = <T>(ms: number, fn: () => Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            fn().then(resolve, reject);
          }, ms);
        });

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuisState();
        const ticket = await createTicket({
          tenantId: tenantA.id,
          userId: luis.id,
          email: luis.email,
        });

        const [supportRes, ...loginResponses] = await Promise.all([
          generateTemporaryPassword(
            pedroSession.accessToken,
            ticket.id,
            `Nota frente a login de Luis ronda ${round}.`,
          ),
          ...Array.from({ length: LOGINS_PER_ROUND }, (_, i) =>
            delayed(i * STAGGER_MS, () =>
              server()
                .post('/api/v1/auth/login')
                .send({ email: luis.email, password: PASSWORD }),
            ),
          ),
        ]);

        const supportOut = outcomeOf(supportRes);
        const loginOutcomes = loginResponses.map(outcomeOf);
        if (
          supportOut.status >= 500 ||
          loginOutcomes.some((o) => o.status >= 500)
        ) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        if (supportOut.status !== 200) {
          problems.push(`support=${label(supportOut)}`);
        }

        for (const [i, res] of loginResponses.entries()) {
          const outcome = loginOutcomes[i];
          if (outcome.status === 200) {
            const accessToken =
              (res.body as { accessToken?: string }).accessToken ?? '';
            const me = outcomeOf(
              await server()
                .get('/api/v1/auth/me')
                .set(authHeader(accessToken)),
            );
            if (label(me) !== '401 SESSION_REVOKED') {
              problems.push(
                `login #${i + 1}=200 con la contraseña anterior y su sesión sigue viva (GET /auth/me=${label(me)})`,
              );
            }
          } else if (label(outcome) !== '401 INVALID_CREDENTIALS') {
            problems.push(`login #${i + 1}=${label(outcome)}`);
          }
        }

        const sessions = await readUserSessions(luis.id);
        const alive = sessions.filter((s) => s.revokedAt === null).length;
        if (alive !== 0) {
          problems.push(`${alive} sesiones de Luis siguen activas en la base`);
        }

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (support=${label(supportOut)}, logins=${loginOutcomes.map(label).join(', ')}): ${problems.join('; ')}`,
          );
        }
      }

      expect(
        violations,
        `${roundsWith500} de ${ROUNDS} rondas dieron 500:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
    ROUND_TEST_TIMEOUT,
  );

  // ---------------------------------------------------------------- vs POST /auth/forgot-password

  it(
    `[US1-AC5][SC-008][R9] generación de temporal y "¿Olvidaste tu contraseña?" de la misma cuenta a la vez (${ROUNDS} rondas): nunca hay dos tickets open y ninguna solicitud se pierde`,
    async () => {
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuisState();
        const ticket = await createTicket({
          tenantId: tenantA.id,
          userId: luis.id,
          email: luis.email,
          requestCount: 1,
        });

        const [supportRes, helpResult] = await Promise.all([
          generateTemporaryPassword(
            pedroSession.accessToken,
            ticket.id,
            `Nota frente a forgot-password ronda ${round}.`,
          ),
          forgotPassword(
            app,
            { email: luis.email },
            { ip: `198.51.100.${10 + round}` },
          ),
        ]);

        const supportOut = outcomeOf(supportRes);
        const helpOut = outcomeOf(helpResult.response);
        if (supportOut.status >= 500 || helpOut.status >= 500) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        if (supportOut.status !== 200) {
          problems.push(`support=${label(supportOut)}`);
        }
        if (helpOut.status !== 202) {
          problems.push(`forgot-password=${label(helpOut)}`);
        }

        const tickets = await readTickets(luis.id);
        const openTickets = tickets.filter((t) => t.status === 'open');
        if (openTickets.length > 1) {
          problems.push(`${openTickets.length} tickets open simultáneos`);
        }

        // Either:
        // (a) help request arrived before resolution: 1 resolved ticket with requestCount = 2; or
        // (b) help request arrived after resolution: 1 resolved ticket (requestCount = 1) + 1 new open ticket (requestCount = 1).
        const coherentBefore =
          tickets.length === 1 &&
          tickets[0].id === ticket.id &&
          tickets[0].status === 'resolved' &&
          tickets[0].requestCount === 2;
        const coherentAfter =
          tickets.length === 2 &&
          tickets[0].id === ticket.id &&
          tickets[0].status === 'resolved' &&
          tickets[0].requestCount === 1 &&
          tickets[1].status === 'open' &&
          tickets[1].requestCount === 1;

        if (!coherentBefore && !coherentAfter) {
          problems.push(
            `estado de tickets inesperado: ${JSON.stringify(
              tickets.map((t) => ({
                id: t.id,
                status: t.status,
                requestCount: t.requestCount,
              })),
            )}`,
          );
        }

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (support=${label(supportOut)}, help=${label(helpOut)}): ${problems.join('; ')}`,
          );
        }
      }

      expect(
        violations,
        `${roundsWith500} de ${ROUNDS} rondas dieron 500:\n${violations.join('\n')}`,
      ).toEqual([]);
    },
    ROUND_TEST_TIMEOUT,
  );
});
