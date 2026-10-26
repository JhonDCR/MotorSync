// T048 (specs/003-soporte-plataforma, Phase 7, US3): e2e of temporary password generation over an
// open support ticket (`POST /api/v1/support/tickets/{ticketId}/temporary-password`) on the full
// app wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as
// motorsync_app and the fixtures as motorsync_migrator.
//
// Covered: US3-AC1 to US3-AC6, US3-AC8 to US3-AC10, US3-AC13, FR-019, FR-020, FR-023, FR-025,
// SC-007 and zone separation (workshop token / pending temporary support session).
//
// Contract (contracts/openapi.yaml):
// - POST /api/v1/support/tickets/{ticketId}/temporary-password (support Bearer) body
//   { verificationNote } -> 200 TemporaryPasswordResponse { temporaryPassword,
//   temporaryPasswordExpiresAt, sessionsClosed, ticket } with header `Cache-Control: no-store`.
// - temporaryPassword format: `^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$` (19 chars, hyphens and
//   uppercase are part of the password). Shown only once in this response; never stored in plain
//   text, never returned in subsequent responses, never written to logs.
// - Atomically updates the ticket's workshop account: invalidates old password, sets
//   must_change_password = true and temp_password_expires_at ~= now() + 72 h, revokes all active
//   sessions with revoke_reason = 'password_reset', clears login_attempts, sets updated_by =
//   agent.id and updated_by_name = 'Soporte MotorSync (<agent.name>)', writes one audit_log row in
//   the ticket's workshop (action = 'user.password_reset_by_support', actor_role =
//   'platform_support', channel = 'support_panel'), resolves the ticket with the trimmed note and
//   writes one 'temporary_password_generated' event.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, decodeJwtPayload, loginAs } from './setup/auth.js';
import {
  closeFixtures,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  emailHash,
  readAuditLog,
  readTicketEvents,
  readTickets,
  readUserSessions,
  setLockedUntil,
  setTemporaryPasswordExpiry,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  enableTrustProxyForTests,
  loginAsSupport,
  type SupportLoginResult,
} from './setup/support.js';

const PASSWORD = 'Clave-Segura-123';
const NEW_PERMANENT_PASSWORD = 'Nueva-Clave-Ana-2026';
const SUPPORT_TICKETS = '/api/v1/support/tickets';
const PEDRO_NAME = 'Pedro Soporte';
const PEDRO_EMAIL = 'pedro@motorsync.ec';
const RUC_A = '1790012345001';
const RUC_B = '1790012346001';
const TEMP_PASSWORD_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SEVENTY_TWO_HOURS_MS = 72 * 3600 * 1000;
const EXPIRY_TOLERANCE_MS = 5 * 60 * 1000;
const NOW_TOLERANCE_MS = 60_000;

type Json = Record<string, unknown>;

interface FieldErrorBody {
  field: string;
  code: string;
  message?: string;
}

interface WorkshopUserSnapshot {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
  updatedBy: string;
  updatedByName: string;
  updatedAt: Date;
}

interface AttemptRow {
  failed_count: number;
  locked_until: Date | null;
}

describe('Support temporary password generation (e2e, T048, US3)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Sole active admin of workshop A (US3-AC1, US3-AC13). */
  let ana: UserFixture;
  /** Asesor of workshop A. */
  let luis: UserFixture;
  /** Admin of workshop B (isolation checks, US3-AC9, US3-AC10). */
  let martaB: UserFixture;
  /** Active support agent. */
  let pedro: SupportAccountFixture;
  let pedroSession: SupportLoginResult;

  function server() {
    return request(app.getHttpServer());
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function fieldErrors(body: unknown): FieldErrorBody[] {
    const errors = (body as { errors?: unknown })?.errors;
    return Array.isArray(errors) ? (errors as FieldErrorBody[]) : [];
  }

  function expectFieldError(res: Response, field: string, code: string): void {
    expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(fieldErrors(res.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
  }

  function expectIsoZ(value: unknown): void {
    expect(typeof value).toBe('string');
    expect(value as string).toMatch(ISO_Z_RE);
    expect(Number.isNaN(Date.parse(value as string))).toBe(false);
  }

  function generateTemporaryPassword(
    token: string,
    ticketId: string,
    body: Json,
    ip = '198.51.100.42',
  ): Promise<Response> {
    return server()
      .post(`${SUPPORT_TICKETS}/${ticketId}/temporary-password`)
      .set(authHeader(token))
      .set('X-Forwarded-For', ip)
      .send(body);
  }

  async function inMigratorTenant<T>(
    tenantId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
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

  async function readWorkshopUser(
    user: UserFixture,
  ): Promise<WorkshopUserSnapshot> {
    return inMigratorTenant(user.tenantId, async (client) => {
      const result = await client.query<WorkshopUserSnapshot>(
        `SELECT id, name, email, password_hash AS "passwordHash", role, status,
                must_change_password AS "mustChangePassword",
                temp_password_expires_at AS "tempPasswordExpiresAt",
                updated_by AS "updatedBy",
                updated_by_name AS "updatedByName",
                updated_at AS "updatedAt"
           FROM users
          WHERE id = $1`,
        [user.id],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    });
  }

  async function readTenantAuditAll(tenantId: string): Promise<Json[]> {
    return inMigratorTenant(tenantId, async (client) => {
      const result = await client.query<Json>(
        `SELECT id, tenant_id AS "tenantId", actor_user_id AS "actorUserId",
                actor_name AS "actorName", actor_role AS "actorRole", action,
                entity_type AS "entityType", entity_id AS "entityId",
                before, after, reason, occurred_at AS "occurredAt", ip, channel
           FROM audit_log
          ORDER BY occurred_at, id`,
      );
      return result.rows;
    });
  }

  async function loginAttempt(email: string): Promise<AttemptRow | undefined> {
    const result = await migratorPool.query<AttemptRow>(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0];
  }

  /**
   * Captures all output written to Nest's Logger methods, process.stdout and process.stderr
   * while `fn()` runs, without suppressing normal output.
   */
  async function captureLogsAndStdio<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; captured: string }> {
    const chunks: string[] = [];
    const record = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg === 'string') {
          chunks.push(arg);
        } else if (Buffer.isBuffer(arg)) {
          chunks.push(arg.toString('utf8'));
        } else {
          try {
            chunks.push(JSON.stringify(arg));
          } catch {
            chunks.push(String(arg));
          }
        }
      }
    };

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const loggerProto = Logger.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const loggerMethods = [
      'log',
      'error',
      'warn',
      'debug',
      'verbose',
      'fatal',
    ] as const;
    const origLoggerMethods = new Map<
      string,
      (...args: unknown[]) => unknown
    >();

    for (const method of loggerMethods) {
      if (typeof loggerProto[method] === 'function') {
        const orig = loggerProto[method];
        origLoggerMethods.set(method, orig);
        loggerProto[method] = function (...args: unknown[]) {
          record(...args);
          return orig.apply(this, args);
        };
      }
    }

    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      record(chunk);
      return (origStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      record(chunk);
      return (origStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    try {
      const result = await fn();
      return { result, captured: chunks.join('\n') };
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      for (const [method, orig] of origLoggerMethods.entries()) {
        loggerProto[method] = orig;
      }
    }
  }

  beforeAll(async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) {
      throw new Error(
        'DATABASE_MIGRATOR_URL is not set in the e2e environment',
      );
    }
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 2 });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    enableTrustProxyForTests(app);
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A password e2e ${randomUUID()}`, RUC_A);
    tenantB = await createTenant(`Taller B password e2e ${randomUUID()}`, RUC_B);
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: 'ana.perez@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    luis = await createUser({
      tenantId: tenantA.id,
      name: 'Luis Mora',
      email: 'luis.mora@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });
    martaB = await createUser({
      tenantId: tenantB.id,
      name: 'Marta Taller B',
      email: 'marta.b@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    pedro = await createSupportAccount({
      name: PEDRO_NAME,
      email: PEDRO_EMAIL,
      password: PASSWORD,
      mustChangePassword: false,
    });
    pedroSession = await loginAsSupport(app, PEDRO_EMAIL, PASSWORD);
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US3-AC1 / US3-AC13

  it('[US3-AC1][US3-AC13][FR-019] POST /support/tickets/{id}/temporary-password con nota → 200; invalida anterior, temporal a 72h, revoca las 2 sesiones de Ana, limpia login_attempts, resuelve el ticket con nota recortada y evento, sin cambiar rol ni estado (única admin)', async () => {
    // Ana has 2 open sessions and is subsequently locked out by failed login attempts.
    const anaSession1 = await loginAs(app, ana.email, PASSWORD);
    const anaSession2 = await loginAs(app, ana.email, PASSWORD);
    await setLockedUntil(ana.email, 15);
    expect(await loginAttempt(ana.email)).toBeDefined();

    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const noteWithSpaces =
      '  Verifiqué identidad por videollamada mostrando cédula y RUC.  ';
    const trimmedNote =
      'Verifiqué identidad por videollamada mostrando cédula y RUC.';
    const startedAt = Date.now();

    const res = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: noteWithSpaces },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      temporaryPassword: string;
      temporaryPasswordExpiresAt: string;
      sessionsClosed: number;
      ticket: Json;
    };
    expect(body.temporaryPassword).toMatch(TEMP_PASSWORD_RE);
    expectIsoZ(body.temporaryPasswordExpiresAt);
    expect(body.sessionsClosed).toBe(2);

    const expiresAtMs = Date.parse(body.temporaryPasswordExpiresAt);
    expect(
      Math.abs(expiresAtMs - (startedAt + SEVENTY_TWO_HOURS_MS)),
    ).toBeLessThan(EXPIRY_TOLERANCE_MS);

    // Old password gives 401 INVALID_CREDENTIALS (not 429 ACCOUNT_LOCKED: lock was cleared).
    const oldLogin = await server()
      .post('/api/v1/auth/login')
      .send({ email: ana.email, password: PASSWORD });
    expectProblem(oldLogin, 401, 'INVALID_CREDENTIALS');

    // The login_attempts row of Ana was deleted by auth_clear_login_failures.
    // Note: the failed login above just created a fresh failed_count = 1; check before or verify
    // that it is not locked and let's also verify on a clean account below.
    expect((await loginAttempt(ana.email))?.failed_count).toBe(1);
    expect((await loginAttempt(ana.email))?.locked_until).toBeNull();

    // Both previous sessions of Ana fail with 401 SESSION_REVOKED on their next action.
    const me1 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(anaSession1.accessToken));
    expectProblem(me1, 401, 'SESSION_REVOKED');

    const me2 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(anaSession2.accessToken));
    expectProblem(me2, 401, 'SESSION_REVOKED');

    const dbSessions = await readUserSessions(ana.id);
    expect(dbSessions).toHaveLength(2);
    for (const s of dbSessions) {
      expect(s.revokedAt).toBeInstanceOf(Date);
      expect(s.revokeReason).toBe('password_reset');
    }

    // Stored user state: must_change_password = true, ~72h expiry, role and status unchanged,
    // updated_by = pedro.id, updated_by_name = "Soporte MotorSync (Pedro Soporte)" (US3-AC13).
    const storedAna = await readWorkshopUser(ana);
    expect(storedAna.role).toBe('admin');
    expect(storedAna.status).toBe('active');
    expect(storedAna.mustChangePassword).toBe(true);
    expect(storedAna.tempPasswordExpiresAt).toBeInstanceOf(Date);
    expect(storedAna.tempPasswordExpiresAt?.toISOString()).toBe(
      body.temporaryPasswordExpiresAt,
    );
    expect(storedAna.updatedBy).toBe(pedro.id);
    expect(storedAna.updatedByName).toBe(`Soporte MotorSync (${PEDRO_NAME})`);

    // Ticket in DB: resolved with trimmed note, resolved_by = pedro.id and event recorded.
    const [ticketRow] = await readTickets(ana.id);
    expect(ticketRow).toMatchObject({
      id: ticket.id,
      status: 'resolved',
      verificationNote: trimmedNote,
      resolvedBy: pedro.id,
      discardReason: null,
      discardedBy: null,
      discardedAt: null,
    });
    expect(ticketRow.resolvedAt).toBeInstanceOf(Date);
    expect(
      Math.abs((ticketRow.resolvedAt as Date).getTime() - Date.now()),
    ).toBeLessThan(NOW_TOLERANCE_MS);

    const events = await readTicketEvents(ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ticketId: ticket.id,
      supportAccountId: pedro.id,
      action: 'temporary_password_generated',
      fromStatus: 'open',
      toStatus: 'resolved',
    });
  });

  it('[US3-AC1] la fila de login_attempts de Ana desaparece al generar la temporal', async () => {
    await setLockedUntil(ana.email, 15);
    expect(await loginAttempt(ana.email)).toBeDefined();
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });

    const res = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: 'Identidad verificada por llamada telefónica.' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await loginAttempt(ana.email)).toBeUndefined();
  });

  // ---------------------------------------------------------------- US3-AC2

  it('[US3-AC2][SC-007] respuesta con formato de temporal, Cache-Control: no-store y ticket resolved; la temporal no aparece en ninguna consulta posterior, tabla ni log; segunda generación → 409 TICKET_NOT_OPEN', async () => {
    const anaSession1 = await loginAs(app, ana.email, PASSWORD);
    const anaSession2 = await loginAs(app, ana.email, PASSWORD);
    expect(anaSession1.accessToken).toBeTruthy();
    expect(anaSession2.accessToken).toBeTruthy();

    // Create a second admin in workshop A so we can query GET /users/{id} and GET /users/{id}/history
    // right after without changing Ana's freshly generated temporary password.
    const carlosAdmin = await createUser({
      tenantId: tenantA.id,
      name: 'Carlos Admin',
      email: 'carlos.admin@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    const carlosSession = await loginAs(app, carlosAdmin.email, PASSWORD);

    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const note = 'Identidad confirmada en videollamada con documento original.';

    const { result: res, captured } = await captureLogsAndStdio(() =>
      generateTemporaryPassword(pedroSession.accessToken, ticket.id, {
        verificationNote: note,
      }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const body = res.body as {
      temporaryPassword: string;
      temporaryPasswordExpiresAt: string;
      sessionsClosed: number;
      ticket: Json;
    };
    expect(Object.keys(body).sort()).toEqual([
      'sessionsClosed',
      'temporaryPassword',
      'temporaryPasswordExpiresAt',
      'ticket',
    ]);
    const tempPassword = body.temporaryPassword;
    expect(tempPassword).toHaveLength(19);
    expect(tempPassword).toMatch(TEMP_PASSWORD_RE);
    expectIsoZ(body.temporaryPasswordExpiresAt);
    expect(body.sessionsClosed).toBe(2);

    expect(body.ticket).toMatchObject({
      id: ticket.id,
      number: Number(ticket.number),
      status: 'resolved',
      account: {
        email: ana.email,
        name: ana.name,
        role: 'admin',
        status: 'active',
      },
      workshop: {
        name: tenantA.name,
        ruc: RUC_A,
      },
      resolution: {
        verificationNote: note,
        resolvedByName: PEDRO_NAME,
      },
    });
    expectIsoZ((body.ticket.resolution as Json).resolvedAt);

    // 1. Captured Logger + stdout/stderr never contain the temporary password.
    expect(captured.includes(tempPassword)).toBe(false);

    // 2. GET /support/tickets/{id} and GET /support/tickets do not contain the temporary password.
    const detailRes = await server()
      .get(`${SUPPORT_TICKETS}/${ticket.id}`)
      .set(authHeader(pedroSession.accessToken));
    expect(detailRes.status).toBe(200);
    expect(detailRes.text.includes(tempPassword)).toBe(false);

    const inboxRes = await server()
      .get(SUPPORT_TICKETS)
      .set(authHeader(pedroSession.accessToken));
    expect(inboxRes.status).toBe(200);
    expect(inboxRes.text.includes(tempPassword)).toBe(false);

    // 3. GET /users/{id} and GET /users/{id}/history of the workshop admin do not contain it.
    const userRes = await server()
      .get(`/api/v1/users/${ana.id}`)
      .set(authHeader(carlosSession.accessToken));
    expect(userRes.status).toBe(200);
    expect(userRes.text.includes(tempPassword)).toBe(false);

    const historyRes = await server()
      .get(`/api/v1/users/${ana.id}/history`)
      .set(authHeader(carlosSession.accessToken));
    expect(historyRes.status).toBe(200);
    expect(historyRes.text.includes(tempPassword)).toBe(false);

    // 4. Database rows in support_tickets, support_ticket_events and audit_log do not contain it.
    const ticketsDump = JSON.stringify(await readTickets(ana.id));
    const eventsDump = JSON.stringify(await readTicketEvents(ticket.id));
    const auditDump = JSON.stringify(await readAuditLog(tenantA.id, ana.id));
    expect(ticketsDump.includes(tempPassword)).toBe(false);
    expect(eventsDump.includes(tempPassword)).toBe(false);
    expect(auditDump.includes(tempPassword)).toBe(false);

    // 5. A second generation on the same (now resolved) ticket -> 409 TICKET_NOT_OPEN.
    const secondRes = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: 'Segundo intento sobre el mismo ticket.' },
    );
    expectProblem(secondRes, 409, 'TICKET_NOT_OPEN');
    expect(secondRes.body).not.toHaveProperty('temporaryPassword');
  });

  // ---------------------------------------------------------------- US3-AC3 / FR-023

  it('[US3-AC3][FR-023] sin verificationNote, vacía, solo espacios o de 1001 caracteres → 400 VALIDATION_ERROR sin efectos; con nota, queda en el ticket y no en audit_log', async () => {
    const anaSession = await loginAs(app, ana.email, PASSWORD);
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const beforeUser = await readWorkshopUser(ana);

    for (const invalidBody of [
      {},
      { verificationNote: '' },
      { verificationNote: '   \t\n  ' },
    ]) {
      const res = await generateTemporaryPassword(
        pedroSession.accessToken,
        ticket.id,
        invalidBody,
      );
      expectFieldError(res, 'verificationNote', 'REQUIRED');
    }

    const tooLongRes = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: 'x'.repeat(1001) },
    );
    expectProblem(tooLongRes, 400, 'VALIDATION_ERROR');
    expect(fieldErrors(tooLongRes.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'verificationNote' }),
      ]),
    );

    // Nothing changed: password, sessions, audit_log, ticket still open.
    expect(await readWorkshopUser(ana)).toEqual(beforeUser);
    const me = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(anaSession.accessToken));
    expect(me.status).toBe(200);
    expect(await readAuditLog(tenantA.id, ana.id)).toEqual([]);
    const [stillOpen] = await readTickets(ana.id);
    expect(stillOpen.status).toBe('open');
    expect(await readTicketEvents(ticket.id)).toEqual([]);

    // Now with a valid note: saved in the ticket, absent from every column of audit_log.
    const secretNote = 'NOTA-UNICA-VERIFICACION-987654: llamada al 0991234567';
    const validRes = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: `  ${secretNote}  ` },
    );
    expect(validRes.status, JSON.stringify(validRes.body)).toBe(200);

    const [resolvedTicket] = await readTickets(ana.id);
    expect(resolvedTicket.verificationNote).toBe(secretNote);

    const auditRows = await readAuditLog(tenantA.id, ana.id);
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows).includes(secretNote)).toBe(false);
    expect(auditRows[0].reason).toBeNull();
  });

  // ---------------------------------------------------------------- US3-AC4

  it('[US3-AC4] login con la temporal tal cual → 200 con pwd_change: true y bloquea rutas de negocio (403 PASSWORD_CHANGE_REQUIRED) hasta POST /auth/password; sin guiones o en minúsculas → 401 INVALID_CREDENTIALS; vencida → 401 TEMPORARY_PASSWORD_EXPIRED', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });

    const genRes = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: 'Identidad verificada en persona.' },
    );
    expect(genRes.status, JSON.stringify(genRes.body)).toBe(200);
    const tempPassword = (genRes.body as { temporaryPassword: string })
      .temporaryPassword;

    // Without hyphens or in lowercase -> 401 INVALID_CREDENTIALS.
    const withoutHyphens = tempPassword.replace(/-/g, '');
    const lowerCase = tempPassword.toLowerCase();

    const noHyphensRes = await server()
      .post('/api/v1/auth/login')
      .send({ email: ana.email, password: withoutHyphens });
    expectProblem(noHyphensRes, 401, 'INVALID_CREDENTIALS');

    const lowerRes = await server()
      .post('/api/v1/auth/login')
      .send({ email: ana.email, password: lowerCase });
    expectProblem(lowerRes, 401, 'INVALID_CREDENTIALS');

    // Exact temporary password -> 200 with pwd_change = true.
    const loginTemp = await loginAs(app, ana.email, tempPassword);
    expect(loginTemp.body.user).toMatchObject({
      id: ana.id,
      email: ana.email,
      role: 'admin',
      mustChangePassword: true,
    });
    expect(decodeJwtPayload(loginTemp.accessToken)).toMatchObject({
      sub: ana.id,
      tenant_id: tenantA.id,
      role: 'admin',
      pwd_change: true,
    });

    // Business route blocked with 403 PASSWORD_CHANGE_REQUIRED until password is changed.
    const searchBlocked = await server()
      .get('/api/v1/vehicles/search?q=PB')
      .set(authHeader(loginTemp.accessToken));
    expectProblem(searchBlocked, 403, 'PASSWORD_CHANGE_REQUIRED');

    // After POST /auth/password, business route works.
    const changeRes = await server()
      .post('/api/v1/auth/password')
      .set(authHeader(loginTemp.accessToken))
      .send({
        currentPassword: tempPassword,
        newPassword: NEW_PERMANENT_PASSWORD,
      });
    expect(changeRes.status, JSON.stringify(changeRes.body)).toBe(200);
    const newAccessToken = (changeRes.body as { accessToken: string })
      .accessToken;

    const searchAllowed = await server()
      .get('/api/v1/vehicles/search?q=PB')
      .set(authHeader(newAccessToken));
    expect(searchAllowed.status).toBe(200);

    // Expired temporary password on a second ticket (for Luis) -> 401 TEMPORARY_PASSWORD_EXPIRED.
    const luisTicket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    const luisGen = await generateTemporaryPassword(
      pedroSession.accessToken,
      luisTicket.id,
      { verificationNote: 'Verificación de Luis por llamada.' },
    );
    expect(luisGen.status).toBe(200);
    const luisTemp = (luisGen.body as { temporaryPassword: string })
      .temporaryPassword;

    await setTemporaryPasswordExpiry(luis.id, -1);

    const expiredLogin = await server()
      .post('/api/v1/auth/login')
      .send({ email: luis.email, password: luisTemp });
    expectProblem(expiredLogin, 401, 'TEMPORARY_PASSWORD_EXPIRED');
  });

  // ---------------------------------------------------------------- US3-AC5

  it('[US3-AC5] cuenta sin ticket abierto (nunca tuvo, resolved o discarded): con id de ticket cerrado → 409 TICKET_NOT_OPEN; con id inexistente o no-uuid → 404 NOT_FOUND; nada cambia', async () => {
    const luisSession = await loginAs(app, luis.email, PASSWORD);
    const resolvedTicket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
      status: 'resolved',
      agentId: pedro.id,
      verificationNote: 'Resuelto antes.',
    });
    const discardedTicket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
      status: 'discarded',
      agentId: pedro.id,
      discardReason: 'Descartado antes.',
    });
    const beforeLuis = await readWorkshopUser(luis);

    const onResolved = await generateTemporaryPassword(
      pedroSession.accessToken,
      resolvedTicket.id,
      { verificationNote: 'Intento sobre ticket resuelto.' },
    );
    expectProblem(onResolved, 409, 'TICKET_NOT_OPEN');

    const onDiscarded = await generateTemporaryPassword(
      pedroSession.accessToken,
      discardedTicket.id,
      { verificationNote: 'Intento sobre ticket descartado.' },
    );
    expectProblem(onDiscarded, 409, 'TICKET_NOT_OPEN');

    const onMissing = await generateTemporaryPassword(
      pedroSession.accessToken,
      randomUUID(),
      { verificationNote: 'Intento con ticket inexistente.' },
    );
    expectProblem(onMissing, 404, 'NOT_FOUND');

    const onInvalidId = await generateTemporaryPassword(
      pedroSession.accessToken,
      'no-es-un-uuid',
      { verificationNote: 'Intento con id inválido.' },
    );
    expectProblem(onInvalidId, 404, 'NOT_FOUND');

    // Luis's password, session and workshop audit log are untouched.
    expect(await readWorkshopUser(luis)).toEqual(beforeLuis);
    const me = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(luisSession.accessToken));
    expect(me.status).toBe(200);
    expect(await readAuditLog(tenantA.id, luis.id)).toEqual([]);
  });

  // ---------------------------------------------------------------- US3-AC6 / FR-020 / SC-007

  it('[US3-AC6][FR-020][SC-007] crea exactamente un registro en audit_log del taller A con todos los campos del contrato, sin contraseñas ni nota ni correo del agente, visible en GET /users/{id}/history y sin registros en el taller B', async () => {
    await loginAs(app, ana.email, PASSWORD);
    await loginAs(app, ana.email, PASSWORD);
    const carlosAdmin = await createUser({
      tenantId: tenantA.id,
      name: 'Carlos Admin',
      email: 'carlos.audit@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    const carlosSession = await loginAs(app, carlosAdmin.email, PASSWORD);

    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const note = 'Verificación reservada de identidad #4455.';
    const agentIp = '203.0.113.77';
    const startedAt = Date.now();

    const res = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: note },
      agentIp,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      temporaryPassword: string;
      temporaryPasswordExpiresAt: string;
      sessionsClosed: number;
    };

    const auditA = await readAuditLog(tenantA.id, ana.id);
    expect(auditA).toHaveLength(1);
    const entry = auditA[0];
    expect(entry).toMatchObject({
      tenantId: tenantA.id,
      actorUserId: pedro.id,
      actorName: PEDRO_NAME,
      actorRole: 'platform_support',
      action: 'user.password_reset_by_support',
      entityType: 'user',
      entityId: ana.id,
      before: { mustChangePassword: false },
      after: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: body.temporaryPasswordExpiresAt,
        sessionsClosed: 2,
        supportTicketNumber: Number(ticket.number),
      },
      reason: null,
      channel: 'support_panel',
    });
    expect(entry.ip).toContain(agentIp);
    expect(entry.occurredAt).toBeInstanceOf(Date);
    expect(Math.abs(entry.occurredAt.getTime() - startedAt)).toBeLessThan(
      NOW_TOLERANCE_MS,
    );

    // No field in audit_log contains the temporary password, the old password, a scrypt hash,
    // the verification note or the support agent's email.
    const serializedAudit = JSON.stringify(entry);
    expect(serializedAudit.includes(body.temporaryPassword)).toBe(false);
    expect(serializedAudit.includes(PASSWORD)).toBe(false);
    expect(serializedAudit.includes('scrypt$')).toBe(false);
    expect(serializedAudit.includes(note)).toBe(false);
    expect(serializedAudit.includes(PEDRO_EMAIL)).toBe(false);

    // GET /users/{id}/history returns the entry with actorRole = 'platform_support' and without
    // the agent's email, passwords or verification note.
    const historyRes = await server()
      .get(`/api/v1/users/${ana.id}/history`)
      .set(authHeader(carlosSession.accessToken));
    expect(historyRes.status, JSON.stringify(historyRes.body)).toBe(200);
    const items = (historyRes.body as { items: Json[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: entry.id,
      action: 'user.password_reset_by_support',
      actorName: PEDRO_NAME,
      actorRole: 'platform_support',
      before: { mustChangePassword: false },
      after: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: body.temporaryPasswordExpiresAt,
        sessionsClosed: 2,
        supportTicketNumber: Number(ticket.number),
      },
      channel: 'support_panel',
    });
    expectIsoZ(items[0].occurredAt);
    expect(historyRes.text.includes(PEDRO_EMAIL)).toBe(false);
    expect(historyRes.text.includes(body.temporaryPassword)).toBe(false);
    expect(historyRes.text.includes(PASSWORD)).toBe(false);
    expect(historyRes.text.includes(note)).toBe(false);

    // Workshop B has zero audit_log records.
    expect(await readTenantAuditAll(tenantB.id)).toEqual([]);
  });

  // ---------------------------------------------------------------- US3-AC8

  it('[US3-AC8] ticket abierto de una cuenta desactivada (antes o después de crear el ticket) → 409 ACCOUNT_INACTIVE, nada cambia y el ticket sigue open', async () => {
    // Case 1: account already inactive when the ticket was created.
    const inactiveUser = await createUser({
      tenantId: tenantA.id,
      name: 'Diego Inactivo',
      email: 'diego.inactivo@taller.ec',
      role: 'asesor',
      status: 'inactive',
      password: PASSWORD,
    });
    const ticket1 = await createTicket({
      tenantId: tenantA.id,
      userId: inactiveUser.id,
      email: inactiveUser.email,
    });
    const beforeDiego = await readWorkshopUser(inactiveUser);

    const res1 = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket1.id,
      { verificationNote: 'Verificación de Diego.' },
    );
    expectProblem(res1, 409, 'ACCOUNT_INACTIVE');
    expect(await readWorkshopUser(inactiveUser)).toEqual(beforeDiego);
    expect(await readAuditLog(tenantA.id, inactiveUser.id)).toEqual([]);
    expect((await readTickets(inactiveUser.id))[0].status).toBe('open');
    expect(await readTicketEvents(ticket1.id)).toEqual([]);

    // Case 2: Luis is active when the ticket is created, then deactivated by the admin before
    // support generates the temporary password.
    const ticket2 = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    const anaSession = await loginAs(app, ana.email, PASSWORD);
    const deactRes = await server()
      .post(`/api/v1/users/${luis.id}/deactivate`)
      .set(authHeader(anaSession.accessToken));
    expect(deactRes.status).toBe(200);
    const beforeLuis = await readWorkshopUser(luis);
    const auditBefore = await readAuditLog(tenantA.id, luis.id);

    const res2 = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket2.id,
      { verificationNote: 'Verificación de Luis desactivado después.' },
    );
    expectProblem(res2, 409, 'ACCOUNT_INACTIVE');
    expect(await readWorkshopUser(luis)).toEqual(beforeLuis);
    expect(await readAuditLog(tenantA.id, luis.id)).toEqual(auditBefore);
    expect((await readTickets(luis.id))[0].status).toBe('open');
    expect(await readTicketEvents(ticket2.id)).toEqual([]);
  });

  // ---------------------------------------------------------------- US3-AC9 / US3-AC10 / FR-025

  it('[US3-AC9][US3-AC10][FR-025] userId o tenantId en el body → 400 UNKNOWN_FIELD sin efectos; al generar para Ana, las demás cuentas de A y las cuentas, sesiones y audit_log del taller B no cambian', async () => {
    const luisSession = await loginAs(app, luis.email, PASSWORD);
    const martaBSession = await loginAs(app, martaB.email, PASSWORD);
    expect(luisSession.accessToken).toBeTruthy();
    expect(martaBSession.accessToken).toBeTruthy();

    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });

    const beforeAna = await readWorkshopUser(ana);
    const beforeLuis = await readWorkshopUser(luis);
    const beforeMartaB = await readWorkshopUser(martaB);
    const beforeSessionsB = await readUserSessions(martaB.id);
    const beforeAuditB = await readTenantAuditAll(tenantB.id);

    // Extra identifiers in the body are rejected with 400 UNKNOWN_FIELD.
    for (const [field, value] of [
      ['userId', luis.id],
      ['userId', martaB.id],
      ['tenantId', tenantA.id],
      ['tenantId', tenantB.id],
    ] as const) {
      const badRes = await generateTemporaryPassword(
        pedroSession.accessToken,
        ticket.id,
        {
          verificationNote: 'Nota válida pero con campo extra.',
          [field]: value,
        },
      );
      expectFieldError(badRes, field, 'UNKNOWN_FIELD');
    }

    // Nothing changed after the rejected requests.
    expect(await readWorkshopUser(ana)).toEqual(beforeAna);
    expect((await readTickets(ana.id))[0].status).toBe('open');

    // Valid generation on Ana's ticket only affects Ana.
    const okRes = await generateTemporaryPassword(
      pedroSession.accessToken,
      ticket.id,
      { verificationNote: 'Identidad de Ana verificada.' },
    );
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(200);

    // Luis (same workshop A) keeps his password hash, updatedAt and active session.
    expect(await readWorkshopUser(luis)).toEqual(beforeLuis);
    expect(
      (
        await server()
          .get('/api/v1/auth/me')
          .set(authHeader(luisSession.accessToken))
      ).status,
    ).toBe(200);

    // Workshop B: Marta's account, her sessions and workshop B's audit_log are untouched.
    expect(await readWorkshopUser(martaB)).toEqual(beforeMartaB);
    expect(await readUserSessions(martaB.id)).toEqual(beforeSessionsB);
    expect(await readTenantAuditAll(tenantB.id)).toEqual(beforeAuditB);
    expect(
      (
        await server()
          .get('/api/v1/auth/me')
          .set(authHeader(martaBSession.accessToken))
      ).status,
    ).toBe(200);
  });

  // ---------------------------------------------------------------- Separación de zonas

  it('[US2-AC5][FR-008][FR-009] separación: con el token del admin de A → 403 FORBIDDEN; con sesión de soporte con temporal pendiente → 403 PASSWORD_CHANGE_REQUIRED; nada cambia', async () => {
    const anaSession = await loginAs(app, ana.email, PASSWORD);
    const pendingAgent = await createSupportAccount({
      name: 'Agente Temporal Pendiente',
      email: 'pendiente@motorsync.ec',
      password: PASSWORD,
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + SEVENTY_TWO_HOURS_MS),
    });
    const pendingSession = await loginAsSupport(
      app,
      pendingAgent.email,
      PASSWORD,
    );

    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    const beforeLuis = await readWorkshopUser(luis);

    // Workshop admin token on the panel route -> 403 FORBIDDEN.
    const fromWorkshop = await generateTemporaryPassword(
      anaSession.accessToken,
      ticket.id,
      { verificationNote: 'Intento desde token de taller.' },
    );
    expectProblem(fromWorkshop, 403, 'FORBIDDEN');
    expect(fromWorkshop.body).not.toHaveProperty('temporaryPassword');

    // Support session with mustChangePassword = true -> 403 PASSWORD_CHANGE_REQUIRED.
    const fromPendingSupport = await generateTemporaryPassword(
      pendingSession.accessToken,
      ticket.id,
      { verificationNote: 'Intento con temporal de soporte sin cambiar.' },
    );
    expectProblem(fromPendingSupport, 403, 'PASSWORD_CHANGE_REQUIRED');
    expect(fromPendingSupport.body).not.toHaveProperty('temporaryPassword');

    // Nothing changed on Luis or his ticket.
    expect(await readWorkshopUser(luis)).toEqual(beforeLuis);
    expect((await readTickets(luis.id))[0].status).toBe('open');
    expect(await readTicketEvents(ticket.id)).toEqual([]);
    expect(await readAuditLog(tenantA.id, luis.id)).toEqual([]);
  });
});
