// T022 (specs/003-soporte-plataforma): e2e of "¿Olvidaste tu contraseña?" (US1-AC1 to US1-AC10,
// SC-003, SC-008, FR-004, FR-005, FR-006, FR-025) over the full app wiring (AppModule +
// configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract (contracts/openapi.yaml): POST /api/v1/auth/forgot-password (@Public) with
// `{ email }` → 202 without body; 400 VALIDATION_ERROR with errors[] in email (REQUIRED or
// INVALID_EMAIL); 429 HELP_RATE_LIMITED after 20 requests from the same origin in one hour.
// Every valid request is answered after a fixed 400 ms floor (research R7) and creates or updates
// at most one open ticket per workshop account (research R6). Unknown fields (tenantId, userId,
// ticketId) are ignored (US1-AC9). Missing emails and support-account emails are never stored.
// Origins are simulated with X-Forwarded-For and `trust proxy` enabled only in the test app
// (research R8); the throttle key is the SHA-256 of req.ip, so every case uses its own IP.
// Simulated time: setHelpThrottle moves help_request_throttle.window_started_at; the e2e never
// wait one hour. Accounts come from createUser / createSupportAccount (scrypt, research R3).
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
  countRows,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  emailHash,
  originHash,
  readAuditLog,
  readTickets,
  setHelpThrottle,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  enableTrustProxyForTests,
  forgotPassword,
  type ForgotPasswordResult,
} from './setup/support.js';

const PASSWORD = 'Clave-Segura-123';
const WRONG_PASSWORD = 'Clave-Equivocada-9';
const SUPPORT_PASSWORD = 'Soporte-Segura-123';
const MISSING_EMAIL = 'nadie@ejemplo.ec';
const SAMPLES = 20;
const TIMING_TOLERANCE = 0.25;
const FLOOR_MS = 400;
/** The 20–30 request groups with the 400 ms floor exceed the default 5 s of Vitest. */
const SLOW_TEST_TIMEOUT_MS = 180_000;

interface FieldErrorBody {
  field: string;
  code: string;
  message: string;
}

interface LoginAttemptRow {
  failed_count: number;
}

interface ThrottleRow {
  request_count: number;
  window_started_at: Date;
}

interface UsersFlagRow {
  must_change_password: boolean;
}

/** Tables the e2e searches for an email; they have RLS ENABLE without FORCE (migrator sees all). */
type SearchableTable =
  'support_tickets' | 'support_ticket_events' | 'help_request_throttle';

/**
 * Unique simulated origin per request group (research R8). The throttle key is the SHA-256 of
 * the IP, so two cases sharing an IP would share the 20-request window.
 */
let ipSequence = 0;

function nextIp(): string {
  ipSequence += 1;
  const third = Math.floor(ipSequence / 250) % 256;
  const fourth = (ipSequence % 250) + 1;
  return `198.18.${third}.${fourth}`;
}

/** Median of a sample: sorts it and averages the two middle values on an even length. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function samplesOf(samples: Map<string, number[]>, name: string): number[] {
  const values = samples.get(name);
  if (!values) throw new Error(`no timing samples for case "${name}"`);
  return values;
}

describe('"¿Olvidaste tu contraseña?" (e2e, T022, US1)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Active admin of A (FR-018). */
  let adminA: UserFixture;
  /** Active admin of B (FR-018). */
  let adminB: UserFixture;
  /** Active asesor of A: "Ana Pérez". */
  let ana: UserFixture;
  /** Active asesor of B: "Marta Ruiz". */
  let marta: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  /** POST /auth/forgot-password with a simulated origin and, optionally, extra client fields. */
  function ask(
    email: string,
    ip: string,
    extra: Record<string, unknown> = {},
  ): Promise<ForgotPasswordResult> {
    return forgotPassword(app, { email, ...extra }, { ip });
  }

  function expectAccepted(result: ForgotPasswordResult): void {
    expect(result.response.status, JSON.stringify(result.response.body)).toBe(
      202,
    );
    expect(result.response.text, 'a 202 has no body').toBe('');
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function expectValidationError(
    res: Response,
    field: string,
    code: string,
  ): void {
    expectProblem(res, 400, 'VALIDATION_ERROR');
    const errors = (res.body as { errors?: FieldErrorBody[] }).errors ?? [];
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
  }

  /** `login_attempts` is a global table without RLS: the raw migrator pool reads it directly. */
  async function failedCount(email: string): Promise<number | undefined> {
    const result = await migratorPool.query<LoginAttemptRow>(
      'SELECT failed_count FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0]?.failed_count;
  }

  /** Rows of a support table whose JSON representation contains `text` (US1-AC3). */
  async function rowsContaining(
    table: SearchableTable,
    text: string,
  ): Promise<number> {
    const result = await migratorPool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM public.${table} t
        WHERE to_jsonb(t)::text ILIKE '%' || $1 || '%'`,
      [text],
    );
    return result.rows[0].count;
  }

  async function throttleRow(ip: string): Promise<ThrottleRow | undefined> {
    const result = await migratorPool.query<ThrottleRow>(
      `SELECT request_count, window_started_at
         FROM help_request_throttle
        WHERE origin_hash = $1`,
      [originHash(ip)],
    );
    return result.rows[0];
  }

  /**
   * `users` has FORCE RLS, so the raw migrator pool reads the flag with the tenant pinned
   * (same procedure as db-fixtures, without importing it).
   */
  async function mustChangePasswordOf(user: UserFixture): Promise<boolean> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        user.tenantId,
      ]);
      const result = await client.query<UsersFlagRow>(
        'SELECT must_change_password FROM users WHERE id = $1',
        [user.id],
      );
      await client.query('COMMIT');
      return result.rows[0].must_change_password;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
    // Only the test app reads X-Forwarded-For as req.ip (research R8, plan risk 3).
    enableTrustProxyForTests(app);
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A forgot e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B forgot e2e ${randomUUID()}`);
    // Every workshop keeps an active admin (FR-018).
    adminA = await createUser({
      tenantId: tenantA.id,
      name: 'Alberto Admin',
      email: 'alberto.admin@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    adminB = await createUser({
      tenantId: tenantB.id,
      name: 'Beatriz Admin',
      email: 'beatriz.admin@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: 'ana.perez@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });
    marta = await createUser({
      tenantId: tenantB.id,
      name: 'Marta Ruiz',
      email: 'marta.ruiz@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US1-AC1

  it('[US1-AC1] un correo con espacios y mayúsculas → 202 sin body y un ticket open de Ana en el taller A con el correo normalizado y request_count 1', async () => {
    const result = await ask(' Ana.Perez@Taller.EC ', nextIp());

    expectAccepted(result);

    const tickets = await readTickets(ana.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      tenantId: tenantA.id,
      userId: ana.id,
      email: 'ana.perez@taller.ec',
      status: 'open',
      requestCount: 1,
    });
  });

  // ---------------------------------------------------------------- US1-AC2

  it(
    '[US1-AC2][SC-003] 20 solicitudes por caso (inexistente, activa, desactivada, con ticket abierto y de soporte) → 202 con body idéntico, nunca antes de 400 ms y medianas dentro del 25 %',
    async () => {
      const inactive = await createUser({
        tenantId: tenantA.id,
        name: 'Inés Inactiva',
        email: 'ines.inactiva@taller.ec',
        role: 'asesor',
        password: PASSWORD,
        status: 'inactive',
      });
      const carla = await createUser({
        tenantId: tenantA.id,
        name: 'Carla Con Ticket',
        email: 'carla.ticket@taller.ec',
        role: 'asesor',
        password: PASSWORD,
      });
      await createTicket({
        tenantId: tenantA.id,
        userId: carla.id,
        email: carla.email,
      });
      const support = await createSupportAccount({
        name: 'Pedro Soporte',
        email: 'pedro.soporte@motorsync.ec',
        password: SUPPORT_PASSWORD,
      });

      const cases: Array<{ name: string; email: string }> = [
        { name: 'inexistente', email: MISSING_EMAIL },
        { name: 'activa', email: ana.email },
        { name: 'desactivada', email: inactive.email },
        { name: 'ticket-abierto', email: carla.email },
        { name: 'soporte', email: support.email },
      ];

      const samples = new Map<string, number[]>();
      const texts = new Set<string>();
      for (const current of cases) {
        const ip = nextIp();
        const durations: number[] = [];
        for (let index = 0; index < SAMPLES; index += 1) {
          const result = await ask(current.email, ip);
          expect(
            result.response.status,
            `${current.name} #${index + 1}: ${JSON.stringify(result.response.body)}`,
          ).toBe(202);
          texts.add(result.response.text);
          expect(
            result.durationMs,
            `${current.name} #${index + 1} answered before the 400 ms floor`,
          ).toBeGreaterThanOrEqual(FLOOR_MS);
          durations.push(result.durationMs);
        }
        samples.set(current.name, durations);
      }

      // Every 202 is empty, so the body of the five cases is identical.
      expect([...texts]).toEqual(['']);

      const base = median(samplesOf(samples, 'inexistente'));
      for (const current of cases.slice(1)) {
        const sample = median(samplesOf(samples, current.name));
        expect(
          Math.abs(sample - base) / base,
          `median of "${current.name}" (${sample} ms) differs more than 25 % from the missing email (${base} ms)`,
        ).toBeLessThan(TIMING_TOLERANCE);
      }
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------- US1-AC3

  it('[US1-AC3] un correo inexistente → 202, ningún ticket y el correo no aparece en tickets, eventos, límite ni auditoría', async () => {
    const result = await ask(MISSING_EMAIL, nextIp());

    expectAccepted(result);
    expect(await countRows('support_tickets')).toBe(0);

    for (const table of [
      'support_tickets',
      'support_ticket_events',
      'help_request_throttle',
    ] as const) {
      expect(
        await rowsContaining(table, MISSING_EMAIL),
        `${table} stores the missing email`,
      ).toBe(0);
    }

    const auditA = JSON.stringify(await readAuditLog(tenantA.id, ana.id));
    const auditB = JSON.stringify(await readAuditLog(tenantB.id, marta.id));
    expect(auditA).not.toContain(MISSING_EMAIL);
    expect(auditB).not.toContain(MISSING_EMAIL);
    expect(await countRows('audit_log')).toBe(0);
  });

  // ---------------------------------------------------------------- US1-AC4

  it('[US1-AC4][FR-005] una solicitud no toca la sesión, el bloqueo, la contraseña ni la auditoría de Ana', async () => {
    const session = await loginAs(app, ana.email, PASSWORD);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const failed = await server()
        .post('/api/v1/auth/login')
        .send({ email: ana.email, password: WRONG_PASSWORD });
      expect(
        failed.status,
        `fallo ${attempt}: ${JSON.stringify(failed.body)}`,
      ).toBe(401);
    }
    expect(await failedCount(ana.email)).toBe(2);

    const auditBefore = JSON.stringify(await readAuditLog(tenantA.id, ana.id));
    const auditCountBefore = await countRows('audit_log');
    const mustChangeBefore = await mustChangePasswordOf(ana);
    expect(mustChangeBefore).toBe(false);

    const result = await ask(ana.email, nextIp());
    expectAccepted(result);

    const me = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session.accessToken));
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(
      (me.body as { user: { mustChangePassword: boolean } }).user
        .mustChangePassword,
    ).toBe(false);

    // The failed attempts are still 2: the help request neither resets nor adds to them.
    expect(await failedCount(ana.email)).toBe(2);
    expect(await mustChangePasswordOf(ana)).toBe(mustChangeBefore);
    expect(JSON.stringify(await readAuditLog(tenantA.id, ana.id))).toBe(
      auditBefore,
    );
    expect(await countRows('audit_log')).toBe(auditCountBefore);

    const login = await server()
      .post('/api/v1/auth/login')
      .send({ email: ana.email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  });

  // ---------------------------------------------------------------- US1-AC5

  it('[US1-AC5] con un ticket abierto otra solicitud no crea otro: sube request_count a 2 y last_requested_at', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
      requestCount: 1,
    });

    const result = await ask(ana.email, nextIp());
    expectAccepted(result);

    const tickets = await readTickets(ana.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe(ticket.id);
    expect(tickets[0].status).toBe('open');
    expect(tickets[0].requestCount).toBe(2);
    expect(new Date(tickets[0].lastRequestedAt).getTime()).toBeGreaterThan(
      new Date(ticket.lastRequestedAt).getTime(),
    );
  });

  it('[US1-AC5] con el ticket resuelto una solicitud abre uno nuevo y el cerrado no cambia', async () => {
    const closed = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
      status: 'resolved',
      requestCount: 3,
    });
    const before = (await readTickets(ana.id)).find(
      (ticket) => ticket.id === closed.id,
    );
    expect(before).toBeDefined();

    const result = await ask(ana.email, nextIp());
    expectAccepted(result);

    const tickets = await readTickets(ana.id);
    expect(tickets).toHaveLength(2);
    const open = tickets.filter((ticket) => ticket.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].requestCount).toBe(1);
    expect(open[0].id).not.toBe(closed.id);
    expect(tickets.find((ticket) => ticket.id === closed.id)).toEqual(before);
  });

  it('[US1-AC5] con el ticket descartado una solicitud abre uno nuevo y el cerrado no cambia', async () => {
    const closed = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
      status: 'discarded',
      requestCount: 4,
    });
    const before = (await readTickets(ana.id)).find(
      (ticket) => ticket.id === closed.id,
    );
    expect(before).toBeDefined();

    const result = await ask(ana.email, nextIp());
    expectAccepted(result);

    const tickets = await readTickets(ana.id);
    expect(tickets).toHaveLength(2);
    const open = tickets.filter((ticket) => ticket.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].requestCount).toBe(1);
    expect(open[0].id).not.toBe(closed.id);
    expect(tickets.find((ticket) => ticket.id === closed.id)).toEqual(before);
  });

  // ---------------------------------------------------------------- US1-AC6

  it(
    '[US1-AC6] 20 solicitudes desde la misma IP → 202; la 21.ª → 429 HELP_RATE_LIMITED con body idéntico y sin tocar tickets, medianas dentro del 25 % y la ventana vencida vuelve a 202',
    async () => {
      const ip = nextIp();

      // Ten existing accounts and ten missing emails: the origin counts both the same way.
      const existing: UserFixture[] = [];
      for (let index = 1; index <= 10; index += 1) {
        existing.push(
          await createUser({
            tenantId: tenantA.id,
            name: `Asesor ${index}`,
            email: `asesor.${index}@taller.ec`,
            role: 'asesor',
            password: PASSWORD,
          }),
        );
      }
      const emails = [
        ...existing.map((user) => user.email),
        ...Array.from(
          { length: 10 },
          (_, index) => `nadie.${index + 1}@ejemplo.ec`,
        ),
      ];

      // Ana already has an open ticket: the limit must not create or update anything.
      const anaTicket = await createTicket({
        tenantId: tenantA.id,
        userId: ana.id,
        email: ana.email,
        requestCount: 1,
      });

      for (const email of emails) {
        expectAccepted(await ask(email, ip));
      }

      const existingLimited = await ask(ana.email, ip);
      expectProblem(existingLimited.response, 429, 'HELP_RATE_LIMITED');
      const missingLimited = await ask('nadie.21@ejemplo.ec', ip);
      expectProblem(missingLimited.response, 429, 'HELP_RATE_LIMITED');
      expect(JSON.stringify(existingLimited.response.body)).toBe(
        JSON.stringify(missingLimited.response.body),
      );

      const tickets = await readTickets(ana.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].id).toBe(anaTicket.id);
      expect(tickets[0].requestCount).toBe(anaTicket.requestCount);
      // The 20 accepted requests include the 10 existing accounts, and each one opens its own
      // ticket (US1-AC1); the limit only leaves Ana's ticket untouched, so 10 + 1 remain.
      expect(await countRows('support_tickets')).toBe(existing.length + 1);

      // Timing of the 21st request: existing vs. missing, already at the limit.
      const existingDurations: number[] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        await setHelpThrottle(originHash(ip), 20, 0);
        const result = await ask(ana.email, ip);
        expectProblem(result.response, 429, 'HELP_RATE_LIMITED');
        expect(
          result.durationMs,
          `existing 429 #${sample + 1} answered before the 400 ms floor`,
        ).toBeGreaterThanOrEqual(FLOOR_MS);
        existingDurations.push(result.durationMs);
      }

      const missingDurations: number[] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        await setHelpThrottle(originHash(ip), 20, 0);
        const result = await ask('nadie.timing@ejemplo.ec', ip);
        expectProblem(result.response, 429, 'HELP_RATE_LIMITED');
        expect(
          result.durationMs,
          `missing 429 #${sample + 1} answered before the 400 ms floor`,
        ).toBeGreaterThanOrEqual(FLOOR_MS);
        missingDurations.push(result.durationMs);
      }

      const base = median(missingDurations);
      expect(
        Math.abs(median(existingDurations) - base) / base,
        'the median of the 429 with an existing email differs more than 25 % from the missing one',
      ).toBeLessThan(TIMING_TOLERANCE);

      // A window that started more than one hour ago restarts the counter.
      await setHelpThrottle(originHash(ip), 20, 61);
      expectAccepted(await ask(ana.email, ip));
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------- US1-AC7

  it(
    '[US1-AC7] 30 solicitudes con el correo de Ana desde 30 IP distintas → todas 202 y un único ticket open con request_count 30',
    async () => {
      for (let index = 0; index < 30; index += 1) {
        expectAccepted(await ask(ana.email, nextIp()));
      }

      const tickets = await readTickets(ana.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].status).toBe('open');
      expect(tickets[0].requestCount).toBe(30);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------- US1-AC8

  it(
    '[US1-AC8] correo vacío, solo espacios o inválido → 400 VALIDATION_ERROR en email y no cuenta para el límite',
    async () => {
      const invalid: Array<{ email: string; code: string }> = [
        { email: '', code: 'REQUIRED' },
        { email: '   ', code: 'REQUIRED' },
        { email: 'nadie', code: 'INVALID_EMAIL' },
        { email: 'a@b.c', code: 'INVALID_EMAIL' },
      ];
      for (const current of invalid) {
        const result = await ask(current.email, nextIp());
        expectValidationError(result.response, 'email', current.code);
      }
      expect(await countRows('support_tickets')).toBe(0);

      // Invalid bodies do not reach support_request_help: 20 of them do not consume the limit.
      const ip = nextIp();
      for (let index = 0; index < SAMPLES; index += 1) {
        const result = await ask('nadie', ip);
        expectValidationError(result.response, 'email', 'INVALID_EMAIL');
      }
      for (let index = 0; index < SAMPLES; index += 1) {
        expectAccepted(await ask(`nadie.limite.${index + 1}@ejemplo.ec`, ip));
      }
      expect(await countRows('support_tickets')).toBe(0);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------- US1-AC9

  it('[US1-AC9][FR-006] tenantId, userId y ticketId del cliente se ignoran: el ticket queda en la cuenta y el taller del correo', async () => {
    const result = await ask(ana.email, nextIp(), {
      tenantId: tenantB.id,
      userId: marta.id,
      ticketId: randomUUID(),
    });
    expectAccepted(result);

    const anaTickets = await readTickets(ana.id);
    expect(anaTickets).toHaveLength(1);
    expect(anaTickets[0]).toMatchObject({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
      status: 'open',
      requestCount: 1,
    });
    expect(await readTickets(marta.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US1-AC10

  it('[US1-AC10] el correo de una cuenta de soporte → 202 y ningún ticket', async () => {
    const support = await createSupportAccount({
      name: 'Pedro Soporte',
      email: 'pedro.soporte@motorsync.ec',
      password: SUPPORT_PASSWORD,
    });

    const result = await ask(support.email, nextIp());
    expectAccepted(result);
    expect(await countRows('support_tickets')).toBe(0);
  });

  // ---------------------------------------------------------------- SC-008

  it(
    '[SC-008][FR-004] 10 solicitudes simultáneas → un ticket open con request_count 10; 25 simultáneas desde la misma IP → 20 aceptadas, 5 rechazadas y contador 21',
    async () => {
      const sameOrigin = nextIp();
      const simultaneous = await Promise.all(
        Array.from({ length: 10 }, () => ask(ana.email, sameOrigin)),
      );
      for (const [index, result] of simultaneous.entries()) {
        expect(
          result.response.status,
          `simultánea #${index + 1}: ${JSON.stringify(result.response.body)}`,
        ).toBe(202);
      }

      const tickets = await readTickets(ana.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].status).toBe('open');
      expect(tickets[0].requestCount).toBe(10);

      // A second origin: 25 at once, all of them counted (the cap keeps the row at 21).
      const burstOrigin = nextIp();
      const burst = await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          ask(`nadie.burst.${index + 1}@ejemplo.ec`, burstOrigin),
        ),
      );
      const accepted = burst.filter((result) => result.response.status === 202);
      const limited = burst.filter((result) => result.response.status === 429);
      expect(accepted).toHaveLength(20);
      expect(limited).toHaveLength(5);
      for (const result of limited) {
        expectProblem(result.response, 429, 'HELP_RATE_LIMITED');
      }

      const throttle = await throttleRow(burstOrigin);
      expect(throttle?.request_count).toBe(21);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------- FR-025

  it('[FR-025] el admin del taller A no tiene ruta para ver tickets: GET /support/tickets → 403 FORBIDDEN', async () => {
    const session = await loginAs(app, adminA.email, PASSWORD);

    const res = await server()
      .get('/api/v1/support/tickets')
      .set(authHeader(session.accessToken));

    expectProblem(res, 403, 'FORBIDDEN');
    // The workshop admin of B is not a support agent either (the route is implemented in T029).
    const other = await loginAs(app, adminB.email, PASSWORD);
    const resB = await server()
      .get('/api/v1/support/tickets')
      .set(authHeader(other.accessToken));
    expectProblem(resB, 403, 'FORBIDDEN');
  });
});
