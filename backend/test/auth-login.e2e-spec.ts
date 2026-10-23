// T021 (specs/002-autenticacion): e2e of the login (US2-AC1 to US2-AC12, FR-007 to FR-011,
// FR-014, FR-024, SC-003) and of the per-request session validation (research R6) over the full
// app wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as
// motorsync_app.
// Contract: POST /api/v1/auth/login (LoginRequest, @Public) → 200 SessionResponse
// { accessToken, expiresIn: 900, user: SessionUser, workshop: { id, name } } plus
// `Set-Cookie: ms_refresh=<32 bytes base64url>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`
// (no Max-Age). 401 INVALID_CREDENTIALS (unknown email, wrong password or inactive account, same
// body), 429 ACCOUNT_LOCKED (5 failures in a row for an email, 15 minutes, research R4), 400
// VALIDATION_ERROR with errors[].code UNKNOWN_FIELD. With the real session the 001 routes take the
// tenant and the CURRENT role from the database on every request (401 SESSION_REVOKED once the
// account is deactivated).
// Simulated time: the e2e never wait 15 minutes; they write login_attempts with the migrator
// (setLockedUntil). Accounts are created with createUser (scrypt, research R3).
// SC-003 timing test: statistical. It compares medians with a 25 % tolerance and is skipped on
// local Windows (noisy timers and the Vitest worker issue of CLAUDE.md) unless CI is set; on CI
// (Linux) it always runs.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  REFRESH_COOKIE_NAME,
  authHeader,
  decodeJwtPayload,
  issueTestToken,
  loginAs,
} from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  createUser,
  emailHash,
  readAuditLog,
  readUserSessions,
  setLockedUntil,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
  type UserRole,
} from './setup/db-fixtures.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD = 'Clave-Segura-123';
const WRONG_PASSWORD = 'Clave-Equivocada-9';

/** Statistical test (SC-003): skippable on local Windows, always on CI. */
const SKIP_TIMING = process.platform === 'win32' && !process.env.CI;
const TIMING_SAMPLES = 20;
const TIMING_TOLERANCE = 0.25;

type Json = Record<string, unknown>;

interface FieldErrorBody {
  field: string;
  code: string;
  message: string;
}

interface AttemptRow {
  failed_count: number;
  locked_until: Date | null;
}

function uniqueEmail(prefix = 'ana'): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

describe('Auth login (e2e, T021, US2)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Active asesor of A: "Ana Pérez". */
  let ana: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  /** FR-006: no response contains the password that was sent, nor a stored hash. */
  function expectNoPassword(res: Response, password: unknown): void {
    const text = res.text ?? '';
    if (typeof password === 'string' && password.length > 0) {
      expect(text.includes(password), 'the response contains the password').toBe(false);
    }
    expect(text.includes('scrypt$'), 'the response contains a password hash').toBe(false);
  }

  async function login(body: Json): Promise<Response> {
    const res = await server().post('/api/v1/auth/login').send(body);
    expectNoPassword(res, body.password);
    return res;
  }

  function fieldErrors(body: unknown): FieldErrorBody[] {
    const errors = (body as { errors?: unknown }).errors;
    return Array.isArray(errors) ? (errors as FieldErrorBody[]) : [];
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function expectValidationError(res: Response, field: string, code: string): void {
    expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(fieldErrors(res.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
  }

  function rawRefreshCookie(res: Response): string | undefined {
    const header = res.headers['set-cookie'] as string | string[] | undefined;
    const cookies = header === undefined ? [] : Array.isArray(header) ? header : [header];
    return cookies.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  }

  function expectRefreshCookie(res: Response): string {
    const cookie = rawRefreshCookie(res);
    expect(cookie, 'Set-Cookie ms_refresh').toBeDefined();
    const [pair, ...attributes] = (cookie as string).split(';').map((part) => part.trim());
    const value = pair.slice(`${REFRESH_COOKIE_NAME}=`.length);
    expect(value).toMatch(REFRESH_VALUE_RE);
    const lower = attributes.map((attribute) => attribute.toLowerCase());
    expect(lower).toContain('path=/api/v1/auth');
    expect(lower).toContain('httponly');
    expect(lower).toContain('secure');
    expect(lower).toContain('samesite=strict');
    expect(lower.some((attribute) => attribute.startsWith('max-age'))).toBe(false);
    expect(lower.some((attribute) => attribute.startsWith('expires'))).toBe(false);
    return value;
  }

  async function loginAttempt(email: string): Promise<AttemptRow | undefined> {
    const result = await migratorPool.query<AttemptRow>(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0];
  }

  async function clearLoginAttempts(email: string): Promise<void> {
    await migratorPool.query('DELETE FROM login_attempts WHERE email_hash = $1', [
      emailHash(email),
    ]);
  }

  /** UPDATE users as the migrator with the tenant pinned (FORCE RLS), like an admin change would. */
  async function updateUser(
    user: UserFixture,
    changes: { role?: UserRole; status?: 'active' | 'inactive' },
  ): Promise<void> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [user.tenantId]);
      const result = await client.query(
        `UPDATE users
            SET role = COALESCE($2, role), status = COALESCE($3, status), updated_at = now()
          WHERE id = $1`,
        [user.id, changes.role ?? null, changes.status ?? null],
      );
      expect(result.rowCount).toBe(1);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function sessionlessToken(tenant: TenantFixture): string {
    return issueTestToken({
      tenantId: tenant.id,
      userId: randomUUID(),
      role: 'asesor',
      name: 'Asesor de prueba',
    });
  }

  async function createClient(token: string, documentNumber: string, firstNames: string, lastNames: string): Promise<Json> {
    const res = await server()
      .post('/api/v1/clients')
      .set(authHeader(token))
      .send({
        clientType: 'natural',
        documentType: 'passport',
        documentNumber,
        firstNames,
        lastNames,
        phone: '0991234567',
      });
    expect(res.status, `POST /clients ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as Json;
  }

  async function createVehicle(token: string, ownerClientId: string, plate = 'PBA1234'): Promise<Json> {
    const res = await server()
      .post('/api/v1/vehicles')
      .set(authHeader(token))
      .send({
        ownerClientId,
        plate,
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45000,
      });
    expect(res.status, `POST /vehicles ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as Json;
  }

  function newAccount(
    tenant: TenantFixture,
    name: string,
    role: UserRole,
    extra: { status?: 'active' | 'inactive'; email?: string } = {},
  ): Promise<UserFixture> {
    return createUser({
      tenantId: tenant.id,
      name,
      email: extra.email ?? uniqueEmail(name.split(' ')[0].toLowerCase()),
      role,
      password: PASSWORD,
      status: extra.status,
    });
  }

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!appUrl || !migratorUrl) {
      throw new Error('DATABASE_URL or DATABASE_MIGRATOR_URL is not set in the e2e environment');
    }
    appPool = new pg.Pool({ connectionString: appUrl, max: 2 });
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 2 });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A login e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B login e2e ${randomUUID()}`);
    // Every workshop keeps an active admin (FR-018), also when a test demotes another one.
    await newAccount(tenantA, 'Alberto Admin', 'admin');
    await newAccount(tenantB, 'Beatriz Admin', 'admin');
    ana = await newAccount(tenantA, 'Ana Pérez', 'asesor', { email: 'ana.perez@taller.ec' });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US2-AC1

  it('US2-AC1 login correcto → 200 SessionResponse con el taller y el rol de la cuenta', async () => {
    const res = await login({ email: ana.email, password: PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      user: {
        id: ana.id,
        name: 'Ana Pérez',
        email: 'ana.perez@taller.ec',
        role: 'asesor',
        mustChangePassword: false,
      },
      workshop: { id: tenantA.id, name: tenantA.name },
    });
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body).not.toHaveProperty('refreshToken');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('US2-AC1 el token lleva tenant_id y role de la cuenta y el sid de una fila nueva de user_sessions', async () => {
    expect(await readUserSessions(ana.id)).toEqual([]);

    const res = await login({ email: ana.email, password: PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const claims = decodeJwtPayload(res.body.accessToken as string);
    expect(claims).toMatchObject({
      sub: ana.id,
      tenant_id: tenantA.id,
      role: 'asesor',
      name: 'Ana Pérez',
      pwd_change: false,
    });
    expect(claims.sid).toMatch(UUID_RE);
    const sessions = await readUserSessions(ana.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: claims.sid,
      tenantId: tenantA.id,
      userId: ana.id,
      revokedAt: null,
    });
  });

  it('US2-AC1 el login fija ms_refresh con HttpOnly, Secure, SameSite=Strict y Path=/api/v1/auth, sin Max-Age', async () => {
    const res = await login({ email: ana.email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const value = expectRefreshCookie(res);
    expect(res.text.includes(value)).toBe(false);
  });

  it('US2-AC1 FR-011 dos logins de la misma cuenta crean dos sesiones independientes', async () => {
    const first = await loginAs(app, ana.email, PASSWORD);
    const second = await loginAs(app, ana.email, PASSWORD);

    const sidFirst = decodeJwtPayload(first.accessToken).sid;
    const sidSecond = decodeJwtPayload(second.accessToken).sid;
    expect(sidFirst).not.toBe(sidSecond);
    expect(first.refreshCookie).not.toBe(second.refreshCookie);
    expect((await readUserSessions(ana.id)).map((session) => session.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [sidFirst as string, sidSecond as string].sort((a, b) => a.localeCompare(b)),
    );
  });

  // ---------------------------------------------------------------- US2-AC2

  it('US2-AC2 el correo " ANA.Perez@taller.ec " con espacios y mayúsculas → 200 como la cuenta de Ana', async () => {
    const res = await login({ email: ' ANA.Perez@taller.ec ', password: PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user).toMatchObject({ id: ana.id, email: 'ana.perez@taller.ec' });
  });

  it.each([
    ['otra capitalización', PASSWORD.toLowerCase()],
    ['todo en mayúsculas', PASSWORD.toUpperCase()],
    ['espacio al final', `${PASSWORD} `],
    ['espacio al inicio', ` ${PASSWORD}`],
  ])(
    'US2-AC2 la contraseña con %s → 401 INVALID_CREDENTIALS (no se recorta ni se normaliza)',
    async (_label, password) => {
      const res = await login({ email: ana.email, password });

      expectProblem(res, 401, 'INVALID_CREDENTIALS');
      expect(await readUserSessions(ana.id)).toEqual([]);
    },
  );

  // ---------------------------------------------------------------- US2-AC3

  it('US2-AC3 correo inexistente, contraseña incorrecta y cuenta inactiva → 401 INVALID_CREDENTIALS con un body idéntico', async () => {
    const inactive = await newAccount(tenantA, 'Luis Inactivo', 'asesor', { status: 'inactive' });

    const unknown = await login({ email: uniqueEmail('nadie'), password: PASSWORD });
    const wrong = await login({ email: ana.email, password: WRONG_PASSWORD });
    const disabled = await login({ email: inactive.email, password: PASSWORD });

    for (const res of [unknown, wrong, disabled]) {
      expectProblem(res, 401, 'INVALID_CREDENTIALS');
      expect(rawRefreshCookie(res)).toBeUndefined();
    }
    expect(wrong.body).toEqual(unknown.body);
    expect(disabled.body).toEqual(unknown.body);
  });

  it.skipIf(SKIP_TIMING)(
    'US2-AC3 SC-003 (estadística) con 20 intentos de cada caso, las medianas del correo inexistente, la contraseña incorrecta y la cuenta inactiva difieren menos del 25 %',
    async () => {
      const inactive = await newAccount(tenantA, 'Luis Inactivo', 'asesor', { status: 'inactive' });

      async function timed(body: Json): Promise<number> {
        const started = process.hrtime.bigint();
        const res = await server().post('/api/v1/auth/login').send(body);
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        expectProblem(res, 401, 'INVALID_CREDENTIALS');
        return elapsed;
      }

      // Warm-up (JIT, connection pool, dummy hash).
      for (let i = 0; i < 3; i += 1) {
        await timed({ email: uniqueEmail('calentar'), password: PASSWORD });
        await clearLoginAttempts(ana.email);
        await timed({ email: ana.email, password: WRONG_PASSWORD });
      }

      const unknownTimes: number[] = [];
      const wrongTimes: number[] = [];
      const inactiveTimes: number[] = [];
      // Interleaved so that load drift affects every case alike. The lock counter is cleared
      // before each attempt on a real email so that no attempt is answered by the lock (429).
      for (let i = 0; i < TIMING_SAMPLES; i += 1) {
        unknownTimes.push(await timed({ email: uniqueEmail('nadie'), password: PASSWORD }));
        await clearLoginAttempts(ana.email);
        wrongTimes.push(await timed({ email: ana.email, password: WRONG_PASSWORD }));
        await clearLoginAttempts(inactive.email);
        inactiveTimes.push(await timed({ email: inactive.email, password: PASSWORD }));
      }

      const unknownMedian = median(unknownTimes);
      const summary = JSON.stringify({
        unknown: unknownMedian,
        wrong: median(wrongTimes),
        inactive: median(inactiveTimes),
      });
      for (const other of [median(wrongTimes), median(inactiveTimes)]) {
        const difference = Math.abs(unknownMedian - other) / Math.max(unknownMedian, other);
        expect(difference, `medians (ms) ${summary}`).toBeLessThan(TIMING_TOLERANCE);
      }
    },
    120_000,
  );

  // ---------------------------------------------------------------- US2-AC4

  it('US2-AC4 la cuenta desactivada con su contraseña correcta no crea ninguna sesión', async () => {
    const inactive = await newAccount(tenantA, 'Luis Inactivo', 'asesor', { status: 'inactive' });

    const res = await login({ email: inactive.email, password: PASSWORD });

    expectProblem(res, 401, 'INVALID_CREDENTIALS');
    expect(rawRefreshCookie(res)).toBeUndefined();
    expect(await readUserSessions(inactive.id)).toEqual([]);
  });

  // ---------------------------------------------------------------- US2-AC5

  it('US2-AC5 5 fallos seguidos y luego la contraseña correcta → 429 ACCOUNT_LOCKED, sin sesión', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login({ email: ana.email, password: WRONG_PASSWORD });
      expectProblem(res, 401, 'INVALID_CREDENTIALS');
    }

    const res = await login({ email: ana.email, password: PASSWORD });

    expectProblem(res, 429, 'ACCOUNT_LOCKED');
    expect(rawRefreshCookie(res)).toBeUndefined();
    expect(await readUserSessions(ana.id)).toEqual([]);
    const attempt = await loginAttempt(ana.email);
    expect(attempt?.failed_count).toBe(5);
    expect(attempt?.locked_until).toBeInstanceOf(Date);
    const lockedForMs = new Date(attempt?.locked_until ?? 0).getTime() - Date.now();
    expect(lockedForMs).toBeGreaterThan(14 * 60_000);
    expect(lockedForMs).toBeLessThanOrEqual(15 * 60_000 + 5_000);
  });

  // ---------------------------------------------------------------- US2-AC6

  it('US2-AC6 con el bloqueo vencido (setLockedUntil en el pasado) el login correcto → 200 y la fila de login_attempts desaparece', async () => {
    await setLockedUntil(ana.email, -1);

    const res = await login({ email: ana.email, password: PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await loginAttempt(ana.email)).toBeUndefined();
  });

  it('US2-AC6 con el bloqueo vigente (setLockedUntil en el futuro) el login correcto → 429', async () => {
    await setLockedUntil(ana.email, 10);

    const res = await login({ email: ana.email, password: PASSWORD });

    expectProblem(res, 429, 'ACCOUNT_LOCKED');
  });

  // ---------------------------------------------------------------- US2-AC7

  it('US2-AC7 4 fallos, un acierto y luego un fallo → failed_count = 1 y sin bloqueo', async () => {
    for (let i = 0; i < 4; i += 1) {
      expectProblem(await login({ email: ana.email, password: WRONG_PASSWORD }), 401, 'INVALID_CREDENTIALS');
    }
    expect((await loginAttempt(ana.email))?.failed_count).toBe(4);

    const success = await login({ email: ana.email, password: PASSWORD });
    expect(success.status, JSON.stringify(success.body)).toBe(200);
    expect(await loginAttempt(ana.email)).toBeUndefined();

    expectProblem(await login({ email: ana.email, password: WRONG_PASSWORD }), 401, 'INVALID_CREDENTIALS');
    expect(await loginAttempt(ana.email)).toEqual({ failed_count: 1, locked_until: null });
  });

  // ---------------------------------------------------------------- US2-AC8

  it('US2-AC8 un correo inexistente con 5 fallos y un 6.º intento → 429 ACCOUNT_LOCKED, igual que una cuenta real bloqueada', async () => {
    const ghost = uniqueEmail('fantasma');
    for (let i = 0; i < 5; i += 1) {
      expectProblem(await login({ email: ghost, password: WRONG_PASSWORD }), 401, 'INVALID_CREDENTIALS');
    }

    const sixth = await login({ email: ghost, password: WRONG_PASSWORD });

    expectProblem(sixth, 429, 'ACCOUNT_LOCKED');
    expect((await loginAttempt(ghost))?.failed_count).toBe(5);

    await setLockedUntil(ana.email, 15);
    const realLocked = await login({ email: ana.email, password: PASSWORD });
    expectProblem(realLocked, 429, 'ACCOUNT_LOCKED');
    expect(sixth.body).toEqual(realLocked.body);
  });

  // ---------------------------------------------------------------- US2-AC9

  it('US2-AC9 10 intentos fallidos simultáneos → todos cuentan y la cuenta queda bloqueada; un intento correcto inmediato → 429', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => login({ email: ana.email, password: WRONG_PASSWORD })),
    );

    for (const res of responses) {
      expect([401, 429], JSON.stringify(res.body)).toContain(res.status);
      expect(res.body.code).toBe(res.status === 401 ? 'INVALID_CREDENTIALS' : 'ACCOUNT_LOCKED');
    }
    const rejectedAsInvalid = responses.filter((res) => res.status === 401).length;
    const attempt = await loginAttempt(ana.email);
    // Every attempt that was evaluated (401) was counted, and at least 5 reached the lock.
    expect(attempt?.failed_count).toBeGreaterThanOrEqual(Math.max(5, rejectedAsInvalid));
    expect(attempt?.locked_until).toBeInstanceOf(Date);
    expect(new Date(attempt?.locked_until ?? 0).getTime()).toBeGreaterThan(Date.now());

    const correct = await login({ email: ana.email, password: PASSWORD });
    expectProblem(correct, 429, 'ACCOUNT_LOCKED');
    expect(await readUserSessions(ana.id)).toEqual([]);
  });

  // ---------------------------------------------------------------- US2-AC10

  it.each([
    ['tenantId', () => tenantB.id],
    ['role', () => 'admin'],
  ])(
    'US2-AC10 %s en el body del login → 400 UNKNOWN_FIELD y no se crea sesión',
    async (field, value) => {
      const res = await login({ email: ana.email, password: PASSWORD, [field]: value() });

      expectValidationError(res, field, 'UNKNOWN_FIELD');
      expect(await readUserSessions(ana.id)).toEqual([]);
    },
  );

  // ---------------------------------------------------------------- US2-AC11

  it('US2-AC11 con la sesión de A, abrir el cliente o el vehículo de B por su id → 404 NOT_FOUND', async () => {
    const tokenB = sessionlessToken(tenantB);
    const clientB = await createClient(tokenB, 'BB998877', 'Beatriz', 'Torres');
    const vehicleB = await createVehicle(tokenB, clientB.id as string);
    const { accessToken } = await loginAs(app, ana.email, PASSWORD);

    const client = await server()
      .get(`/api/v1/clients/${clientB.id as string}`)
      .set(authHeader(accessToken));
    const vehicle = await server()
      .get(`/api/v1/vehicles/${vehicleB.id as string}`)
      .set(authHeader(accessToken));
    const search = await server()
      .get('/api/v1/clients/search')
      .query({ q: 'BB998877' })
      .set(authHeader(accessToken));

    expectProblem(client, 404, 'NOT_FOUND');
    expectProblem(vehicle, 404, 'NOT_FOUND');
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([]);
  });

  // ---------------------------------------------------------------- US2-AC12

  it('US2-AC12 GET /api/v1/vehicles/search?q=PB sin token → 401 UNAUTHORIZED', async () => {
    const res = await server().get('/api/v1/vehicles/search').query({ q: 'PB' });

    expectProblem(res, 401, 'UNAUTHORIZED');
  });

  // ---------------------------------------------------------------- FR-024

  describe('FR-024 las rutas de la 001 funcionan con la sesión real (taller y rol de la base)', () => {
    let carlos: Json;
    let vehicle: Json;

    async function transferWithoutReason(token: string): Promise<Response> {
      return server()
        .post(`/api/v1/vehicles/${vehicle.id as string}/ownership-transfers`)
        .set(authHeader(token))
        .send({ newOwnerClientId: carlos.id, version: vehicle.version });
    }

    async function ownerChangedAudit(): Promise<Json[]> {
      const rows = await readAuditLog(tenantA.id, vehicle.id as string);
      return rows.filter((row) => row.action === 'vehicle.owner_changed') as unknown as Json[];
    }

    beforeEach(async () => {
      const token = sessionlessToken(tenantA);
      const owner = await createClient(token, 'AP123456', 'Ana', 'Propietaria');
      carlos = await createClient(token, 'CR456789', 'Carlos', 'Ruiz');
      vehicle = await createVehicle(token, owner.id as string);
    });

    it('FR-024 la sesión real de un asesor busca y crea clientes en su taller', async () => {
      const { accessToken } = await loginAs(app, ana.email, PASSWORD);

      const created = await createClient(accessToken, 'DM112233', 'Diego', 'Mora');
      const search = await server()
        .get('/api/v1/clients/search')
        .query({ q: 'DM112233' })
        .set(authHeader(accessToken));

      expect(created).toMatchObject({ updatedBy: ana.id, updatedByName: 'Ana Pérez' });
      expect(search.status).toBe(200);
      expect(search.body.items).toEqual([expect.objectContaining({ id: created.id })]);
    });

    it('FR-024 un asesor con sesión real transfiere un vehículo sin motivo → 400 REASON_REQUIRED, sin cambios ni auditoría', async () => {
      const { accessToken } = await loginAs(app, ana.email, PASSWORD);

      const res = await transferWithoutReason(accessToken);

      expectValidationError(res, 'reason', 'REASON_REQUIRED');
      expect(await ownerChangedAudit()).toEqual([]);
    });

    it('FR-024 un admin con sesión real transfiere sin motivo → 200 y la auditoría lleva su id, su nombre y el rol admin', async () => {
      const admin = await newAccount(tenantA, 'Pedro Admin', 'admin');
      const { accessToken } = await loginAs(app, admin.email, PASSWORD);

      const res = await transferWithoutReason(accessToken);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ updatedBy: admin.id, updatedByName: 'Pedro Admin' });
      const audit = await ownerChangedAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: tenantA.id,
        actorUserId: admin.id,
        actorName: 'Pedro Admin',
        actorRole: 'admin',
        reason: null,
      });
    });

    it('FR-024 R6 el rol sale de la base en cada request: un asesor ascendido a admin con el mismo token transfiere sin motivo y la auditoría dice admin', async () => {
      const { accessToken } = await loginAs(app, ana.email, PASSWORD);
      expect(decodeJwtPayload(accessToken).role).toBe('asesor');

      await updateUser(ana, { role: 'admin' });
      const res = await transferWithoutReason(accessToken);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const audit = await ownerChangedAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: ana.id, actorRole: 'admin', reason: null });
    });

    it('FR-024 R6 un admin degradado a asesor con el mismo token recibe REASON_REQUIRED en su siguiente acción', async () => {
      const admin = await newAccount(tenantA, 'Pedro Admin', 'admin');
      const { accessToken } = await loginAs(app, admin.email, PASSWORD);
      expect(decodeJwtPayload(accessToken).role).toBe('admin');

      await updateUser(admin, { role: 'asesor' });
      const res = await transferWithoutReason(accessToken);

      expectValidationError(res, 'reason', 'REASON_REQUIRED');
      expect(await ownerChangedAudit()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- R6

  it('R6 si se desactiva la cuenta con el migrator, la siguiente petición con el mismo token → 401 SESSION_REVOKED', async () => {
    const { accessToken } = await loginAs(app, ana.email, PASSWORD);
    const before = await server()
      .get('/api/v1/clients/search')
      .query({ q: 'an' })
      .set(authHeader(accessToken));
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    await updateUser(ana, { status: 'inactive' });
    const after = await server()
      .get('/api/v1/clients/search')
      .query({ q: 'an' })
      .set(authHeader(accessToken));

    expectProblem(after, 401, 'SESSION_REVOKED');
  });

  it('R6 cada request autenticado con la sesión real renueva last_activity_at de su sesión', async () => {
    const { accessToken } = await loginAs(app, ana.email, PASSWORD);
    const [session] = await readUserSessions(ana.id);
    await migratorPool.query('SELECT pg_sleep(0.05)');

    const res = await server()
      .get('/api/v1/clients/search')
      .query({ q: 'an' })
      .set(authHeader(accessToken));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [after] = await readUserSessions(ana.id);
    expect(after.lastActivityAt.getTime()).toBeGreaterThan(session.lastActivityAt.getTime());
  });
});
