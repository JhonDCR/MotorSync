// T037 (specs/002-autenticacion): e2e of the temporary password and of changing the own password
// (US5-AC1 to US5-AC9, FR-026, FR-027, FR-009 applied to the change, research R4 and R7) over the
// full app wiring (AppModule + configureApp) and the real PostgreSQL as motorsync_app.
// Contract (contracts/openapi.yaml):
// - POST /api/v1/auth/password (Bearer, allowed with a pending change) body ChangePasswordRequest
//   { currentPassword (1..128), newPassword (8..128) }, additionalProperties: false →
//   200 SessionResponse with a new access token (`pwd_change: false`) of the SAME session.
//   400 CURRENT_PASSWORD_INCORRECT (errors[] on currentPassword; counts for the 5-failure lock),
//   400 VALIDATION_ERROR with errors[].code PASSWORD_TOO_SHORT / SAME_PASSWORD on newPassword and
//   UNKNOWN_FIELD for any other field (US5-AC8), 401 TEMPORARY_PASSWORD_EXPIRED (the temporary
//   password expired during the session; revokes the current session, revoke_reason =
//   'temp_password_expired'), 429 ACCOUNT_LOCKED (the session in course stays open).
// - The change closes every OTHER session of the account (revoke_reason = 'password_changed').
// - Login with a correct but expired temporary password → 401 TEMPORARY_PASSWORD_EXPIRED, without a
//   login_attempts row and without a session; with a wrong password, the generic INVALID_CREDENTIALS.
// - With a temporary password only GET /auth/me, POST /auth/password and POST /auth/logout are
//   allowed; anything else → 403 PASSWORD_CHANGE_REQUIRED (FR-026).
// Temporary accounts come from createUser({ mustChangePassword, tempPasswordExpiresAt }) because
// /users arrives in PR3; time is simulated with setTemporaryPasswordExpiry.
import { randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  authHeader,
  decodeJwtPayload,
  loginAs,
  refreshCookieFrom,
  withRefreshCookie,
  type LoginResult,
} from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  createUser,
  emailHash,
  readUserSessions,
  setTemporaryPasswordExpiry,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
  type UserRole,
} from './setup/db-fixtures.js';

const PASSWORD = 'Clave-Segura-123';
const TEMPORARY = 'Temporal-Luis-472';
const NEW_PASSWORD = 'Nueva-Clave-2026';
const WRONG_PASSWORD = 'Clave-Equivocada-9';
const SEVENTY_TWO_HOURS_MS = 72 * 3600 * 1000;

type Json = Record<string, unknown>;

interface FieldErrorBody {
  field: string;
  code: string;
  message?: string;
}

interface AttemptRow {
  failed_count: number;
  locked_until: Date | null;
}

interface UserPasswordRow {
  password_hash: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
}

let rucCounter = 0;

/** A valid and unique RUC of a private company (structure only, decision P1 of the 001). */
function newRuc(): string {
  rucCounter += 1;
  const middle = String((randomInt(0, 10_000) * 1000 + rucCounter) % 10_000_000).padStart(7, '0');
  return `179${middle}001`;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

function sidOf(accessToken: string): string {
  return decodeJwtPayload(accessToken).sid as string;
}

describe('Auth password: temporal y cambio de la propia contraseña (e2e, T037, US5)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Asesor of A with her own (not temporary) password. */
  let ana: UserFixture;
  /** Asesor of A with a temporary password valid for 72 h. */
  let luis: UserFixture;
  /** Asesor of B. */
  let marta: UserFixture;

  function server() {
    return request(app.getHttpServer());
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

  function expectFieldError(res: Response, field: string, code: string): void {
    expect(fieldErrors(res.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
  }

  /** US5-AC7: no response contains a password (current, previous or new) nor a hash. */
  function expectNoPasswords(res: Response, ...passwords: string[]): void {
    const text = res.text ?? '';
    for (const password of passwords) {
      expect(text.includes(password), `la respuesta contiene la contraseña "${password}"`).toBe(false);
    }
    expect(text.includes('scrypt$'), 'la respuesta contiene un hash').toBe(false);
  }

  async function changePassword(accessToken: string, body: Json): Promise<Response> {
    const res = await server()
      .post('/api/v1/auth/password')
      .set(authHeader(accessToken))
      .send(body);
    const passwords = [body.currentPassword, body.newPassword].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    expectNoPasswords(res, ...passwords);
    return res;
  }

  async function login(email: string, password: string): Promise<Response> {
    const res = await server().post('/api/v1/auth/login').send({ email, password });
    expectNoPasswords(res, password);
    return res;
  }

  function loginOk(user: UserFixture, password = user.password): Promise<LoginResult> {
    return loginAs(app, user.email, password);
  }

  function me(accessToken: string): Promise<Response> {
    return server().get('/api/v1/auth/me').set(authHeader(accessToken));
  }

  function searchVehicles(accessToken: string): Promise<Response> {
    return server().get('/api/v1/vehicles/search').query({ q: 'PB' }).set(authHeader(accessToken));
  }

  function searchClients(accessToken: string): Promise<Response> {
    return server().get('/api/v1/clients/search').query({ q: 'an' }).set(authHeader(accessToken));
  }

  function refresh(cookie: string): Promise<Response> {
    return server().post('/api/v1/auth/refresh').set(withRefreshCookie(cookie)).send();
  }

  function newAccount(
    tenant: TenantFixture,
    name: string,
    role: UserRole,
    extra: { password?: string; mustChangePassword?: boolean; tempPasswordExpiresAt?: Date } = {},
  ): Promise<UserFixture> {
    return createUser({
      tenantId: tenant.id,
      name,
      email: uniqueEmail(name.split(' ')[0].toLowerCase()),
      role,
      password: extra.password ?? PASSWORD,
      mustChangePassword: extra.mustChangePassword,
      tempPasswordExpiresAt: extra.tempPasswordExpiresAt,
    });
  }

  function temporaryAccount(tenant: TenantFixture, name: string, role: UserRole): Promise<UserFixture> {
    return newAccount(tenant, name, role, {
      password: TEMPORARY,
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + SEVENTY_TWO_HOURS_MS),
    });
  }

  async function loginAttempt(email: string): Promise<AttemptRow | undefined> {
    const result = await migratorPool.query<AttemptRow>(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0];
  }

  async function passwordRow(user: UserFixture): Promise<UserPasswordRow> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [user.tenantId]);
      const result = await client.query<UserPasswordRow>(
        'SELECT password_hash, must_change_password, temp_password_expires_at FROM users WHERE id = $1',
        [user.id],
      );
      await client.query('COMMIT');
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function sessionById(user: UserFixture, sessionId: string) {
    const session = (await readUserSessions(user.id)).find((row) => row.id === sessionId);
    expect(session, `session ${sessionId}`).toBeDefined();
    return session as NonNullable<typeof session>;
  }

  beforeAll(async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) throw new Error('DATABASE_MIGRATOR_URL is not set in the e2e environment');
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
    tenantA = await createTenant(`Taller A contraseña e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B contraseña e2e ${randomUUID()}`);
    await newAccount(tenantA, 'Alberto Admin', 'admin');
    await newAccount(tenantB, 'Beatriz Admin', 'admin');
    ana = await newAccount(tenantA, 'Ana Pérez', 'asesor');
    luis = await temporaryAccount(tenantA, 'Luis Mora', 'asesor');
    marta = await newAccount(tenantB, 'Marta Ruiz', 'asesor');
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US5-AC1

  it('[US5-AC1] con una temporal vigente el login da 200 con mustChangePassword y pwd_change: true', async () => {
    const res = await login(luis.email, TEMPORARY);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      user: { id: luis.id, role: 'asesor', mustChangePassword: true },
      workshop: { id: tenantA.id },
    });
    const expiresAt = (res.body as { user: Json }).user.temporaryPasswordExpiresAt as string;
    expect(new Date(expiresAt).getTime()).toBe(luis.tempPasswordExpiresAt?.getTime());
    expect(decodeJwtPayload((res.body as Json).accessToken as string)).toMatchObject({
      sub: luis.id,
      pwd_change: true,
    });
    expect(refreshCookieFrom(res)).toBeDefined();
  });

  it('[US5-AC1][FR-026] con el token temporal, /vehicles/search y /clients/search → 403 PASSWORD_CHANGE_REQUIRED sin datos; /auth/me → 200', async () => {
    const session = await loginOk(luis, TEMPORARY);

    const vehicles = await searchVehicles(session.accessToken);
    expectProblem(vehicles, 403, 'PASSWORD_CHANGE_REQUIRED');
    expect(vehicles.body).not.toHaveProperty('items');
    const clients = await searchClients(session.accessToken);
    expectProblem(clients, 403, 'PASSWORD_CHANGE_REQUIRED');
    expect(clients.body).not.toHaveProperty('items');

    const current = await me(session.accessToken);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body).toMatchObject({
      user: { id: luis.id, mustChangePassword: true },
      workshop: { id: tenantA.id, name: tenantA.name },
    });
  });

  it('[US5-AC1][FR-026] con el token temporal el logout sí está permitido (204)', async () => {
    const session = await loginOk(luis, TEMPORARY);

    const res = await server()
      .post('/api/v1/auth/logout')
      .set(withRefreshCookie(session.refreshCookie))
      .set(authHeader(session.accessToken))
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect((await sessionById(luis, sidOf(session.accessToken))).revokeReason).toBe('logout');
  });

  // ---------------------------------------------------------------- US5-AC2

  it('[US5-AC2] POST /auth/password con la temporal → 200 con un token pwd_change: false de la misma sesión que ya accede a /vehicles/search', async () => {
    const session = await loginOk(luis, TEMPORARY);
    const sid = sidOf(session.accessToken);

    const res = await changePassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      user: {
        id: luis.id,
        role: 'asesor',
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      },
      workshop: { id: tenantA.id, name: tenantA.name },
    });
    const accessToken = (res.body as Json).accessToken as string;
    expect(decodeJwtPayload(accessToken)).toMatchObject({ sub: luis.id, sid, pwd_change: false });

    const vehicles = await searchVehicles(accessToken);
    expect(vehicles.status, JSON.stringify(vehicles.body)).toBe(200);
    expect((await sessionById(luis, sid)).revokedAt).toBeNull();

    const row = await passwordRow(luis);
    expect(row.must_change_password).toBe(false);
    expect(row.temp_password_expires_at).toBeNull();
  });

  it('[US5-AC2] después del cambio la temporal deja de servir para el login y la nueva entra sin cambio obligatorio', async () => {
    const session = await loginOk(luis, TEMPORARY);
    const changed = await changePassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    expectProblem(await login(luis.email, TEMPORARY), 401, 'INVALID_CREDENTIALS');
    const res = await login(luis.email, NEW_PASSWORD);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ user: { mustChangePassword: false } });
    expect(decodeJwtPayload((res.body as Json).accessToken as string).pwd_change).toBe(false);
  });

  // ---------------------------------------------------------------- US5-AC3

  it('[US5-AC3][FR-027] con dos sesiones, cambiar desde A deja B con 401 SESSION_REVOKED (password_changed) y A sigue', async () => {
    const tablet = await loginOk(ana);
    const phone = await loginOk(ana);
    const tabletSid = sidOf(tablet.accessToken);
    const phoneSid = sidOf(phone.accessToken);

    const res = await changePassword(tablet.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const newAccess = (res.body as Json).accessToken as string;
    expect(sidOf(newAccess)).toBe(tabletSid);

    // The phone is closed in the same operation: access token and cookie.
    expectProblem(await searchClients(phone.accessToken), 401, 'SESSION_REVOKED');
    expectProblem(await refresh(phone.refreshCookie), 401, 'SESSION_REVOKED');
    const phoneRow = await sessionById(ana, phoneSid);
    expect(phoneRow.revokedAt).toBeInstanceOf(Date);
    expect(phoneRow.revokeReason).toBe('password_changed');

    // The tablet goes on: the new token, the previous one and its refresh cookie.
    expect((await searchClients(newAccess)).status).toBe(200);
    expect((await searchClients(tablet.accessToken)).status).toBe(200);
    expect((await refresh(tablet.refreshCookie)).status).toBe(200);
    expect((await sessionById(ana, tabletSid)).revokedAt).toBeNull();
  });

  it('[US5-AC3] la contraseña anterior da INVALID_CREDENTIALS y la nueva entra', async () => {
    const session = await loginOk(ana);
    const res = await changePassword(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expectProblem(await login(ana.email, PASSWORD), 401, 'INVALID_CREDENTIALS');
    expect((await login(ana.email, NEW_PASSWORD)).status).toBe(200);
  });

  // ---------------------------------------------------------------- US5-AC4

  it('[US5-AC4] contraseña actual incorrecta → 400 CURRENT_PASSWORD_INCORRECT en currentPassword, sin cambiar nada ni revocar sesiones; cuenta un fallo', async () => {
    const tablet = await loginOk(ana);
    const phone = await loginOk(ana);
    const before = await passwordRow(ana);

    const res = await changePassword(tablet.accessToken, {
      currentPassword: WRONG_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expectProblem(res, 400, 'CURRENT_PASSWORD_INCORRECT');
    expectFieldError(res, 'currentPassword', 'CURRENT_PASSWORD_INCORRECT');
    expect(await passwordRow(ana)).toEqual(before);
    for (const row of await readUserSessions(ana.id)) {
      expect(row.revokedAt).toBeNull();
    }
    expect((await searchClients(phone.accessToken)).status).toBe(200);
    expect(await loginAttempt(ana.email)).toMatchObject({ failed_count: 1, locked_until: null });
  });

  it('[US5-AC4][FR-009] 5 fallos seguidos → 429 ACCOUNT_LOCKED en el cambio y en el login de ese correo; la sesión en curso sigue con 200 en /auth/me', async () => {
    const session = await loginOk(ana);
    const sid = sidOf(session.accessToken);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await changePassword(session.accessToken, {
        currentPassword: WRONG_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expectProblem(res, 400, 'CURRENT_PASSWORD_INCORRECT');
    }
    const attempt = await loginAttempt(ana.email);
    expect(attempt?.failed_count).toBe(5);
    expect(attempt?.locked_until).toBeInstanceOf(Date);

    // Locked: even the correct current password is refused, without scrypt nor change.
    const locked = await changePassword(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expectProblem(locked, 429, 'ACCOUNT_LOCKED');
    expectProblem(await login(ana.email, PASSWORD), 429, 'ACCOUNT_LOCKED');

    // The session in course is not closed (clarification of US5-AC4).
    const current = await me(session.accessToken);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect((await sessionById(ana, sid)).revokedAt).toBeNull();
    // Nothing changed: the password is still the old one (checked on the stored hash).
    expect((await passwordRow(ana)).must_change_password).toBe(false);
  });

  // ---------------------------------------------------------------- US5-AC5

  it('[US5-AC5] nueva de 7 caracteres → 400 VALIDATION_ERROR con PASSWORD_TOO_SHORT en newPassword, sin cambios', async () => {
    const session = await loginOk(ana);
    const before = await passwordRow(ana);

    const res = await changePassword(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: 'Corta-7',
    });

    expectProblem(res, 400, 'VALIDATION_ERROR');
    expectFieldError(res, 'newPassword', 'PASSWORD_TOO_SHORT');
    expect(await passwordRow(ana)).toEqual(before);
  });

  it('[US5-AC5] nueva igual a la actual → 400 VALIDATION_ERROR con SAME_PASSWORD en newPassword, sin cambios ni sesiones cerradas ni fallo contado', async () => {
    const tablet = await loginOk(ana);
    const phone = await loginOk(ana);
    const before = await passwordRow(ana);

    const res = await changePassword(tablet.accessToken, {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });

    expectProblem(res, 400, 'VALIDATION_ERROR');
    expectFieldError(res, 'newPassword', 'SAME_PASSWORD');
    expect(await passwordRow(ana)).toEqual(before);
    expect((await searchClients(phone.accessToken)).status).toBe(200);
    expect(await loginAttempt(ana.email)).toBeUndefined();
  });

  it('[US5-AC5] con la temporal, una nueva igual a la temporal → SAME_PASSWORD y sigue obligado a cambiarla', async () => {
    const session = await loginOk(luis, TEMPORARY);

    const res = await changePassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: TEMPORARY,
    });

    expectProblem(res, 400, 'VALIDATION_ERROR');
    expectFieldError(res, 'newPassword', 'SAME_PASSWORD');
    expect((await passwordRow(luis)).must_change_password).toBe(true);
    expectProblem(await searchVehicles(session.accessToken), 403, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('[US5-AC5] campos ausentes → 400 VALIDATION_ERROR con REQUIRED', async () => {
    const session = await loginOk(ana);

    const res = await changePassword(session.accessToken, {});

    expectProblem(res, 400, 'VALIDATION_ERROR');
    expectFieldError(res, 'currentPassword', 'REQUIRED');
    expectFieldError(res, 'newPassword', 'REQUIRED');
  });

  // ---------------------------------------------------------------- US5-AC6

  it('[US5-AC6] el dueño registrado en US1 no tiene pwd_change, accede a todo y puede cambiar su contraseña', async () => {
    const email = uniqueEmail('dueno');
    const registered = await server()
      .post('/api/v1/auth/register')
      .send({
        workshopName: 'Taller del Dueño',
        ruc: newRuc(),
        name: 'Daniel Dueño',
        email,
        password: PASSWORD,
      });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    expect(registered.body).toMatchObject({
      user: { role: 'admin', mustChangePassword: false, temporaryPasswordExpiresAt: null },
    });
    const registeredToken = (registered.body as Json).accessToken as string;
    expect(decodeJwtPayload(registeredToken).pwd_change).toBe(false);

    const session = await loginAs(app, email, PASSWORD);
    expect(session.body).toMatchObject({ user: { mustChangePassword: false } });
    expect(decodeJwtPayload(session.accessToken).pwd_change).toBe(false);
    expect((await searchVehicles(session.accessToken)).status).toBe(200);
    expect((await searchClients(session.accessToken)).status).toBe(200);

    const changed = await changePassword(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  // ---------------------------------------------------------------- US5-AC7

  it('[US5-AC7] ningún body del flujo (éxito y errores) contiene la contraseña actual, la anterior ni la nueva', async () => {
    const session = await loginOk(luis, TEMPORARY);
    const responses: Response[] = [];

    responses.push(
      await changePassword(session.accessToken, { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD }),
      await changePassword(session.accessToken, { currentPassword: TEMPORARY, newPassword: 'Corta-7' }),
      await changePassword(session.accessToken, { currentPassword: TEMPORARY, newPassword: TEMPORARY }),
      await changePassword(session.accessToken, { currentPassword: TEMPORARY, newPassword: NEW_PASSWORD }),
    );
    expect(responses[3].status, JSON.stringify(responses[3].body)).toBe(200);
    const accessToken = (responses[3].body as Json).accessToken as string;
    responses.push(await me(accessToken));

    for (const res of responses) {
      expectNoPasswords(res, TEMPORARY, NEW_PASSWORD, WRONG_PASSWORD, 'Corta-7');
    }
  });

  // ---------------------------------------------------------------- US5-AC8

  it('[US5-AC8] userId en el body → 400 VALIDATION_ERROR con UNKNOWN_FIELD, sin cambiar ninguna cuenta', async () => {
    const session = await loginOk(ana);
    const anaBefore = await passwordRow(ana);
    const martaBefore = await passwordRow(marta);

    for (const target of [luis.id, marta.id]) {
      const res = await changePassword(session.accessToken, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        userId: target,
      });
      expectProblem(res, 400, 'VALIDATION_ERROR');
      expectFieldError(res, 'userId', 'UNKNOWN_FIELD');
    }

    expect(await passwordRow(ana)).toEqual(anaBefore);
    expect(await passwordRow(marta)).toEqual(martaBefore);
    expect((await login(marta.email, PASSWORD)).status).toBe(200);
    expect((await login(luis.email, TEMPORARY)).status).toBe(200);
  });

  // ---------------------------------------------------------------- US5-AC9

  it('[US5-AC9] con la temporal vencida, el login correcto → 401 TEMPORARY_PASSWORD_EXPIRED sin fila en login_attempts ni sesión', async () => {
    await setTemporaryPasswordExpiry(luis.id, -1);

    const res = await login(luis.email, TEMPORARY);

    expectProblem(res, 401, 'TEMPORARY_PASSWORD_EXPIRED');
    expect(refreshCookieFrom(res)).toBeUndefined();
    expect(res.body).not.toHaveProperty('accessToken');
    expect(await loginAttempt(luis.email)).toBeUndefined();
    expect(await readUserSessions(luis.id)).toEqual([]);
  });

  it('[US5-AC9] con la temporal vencida y una contraseña incorrecta → INVALID_CREDENTIALS genérico, que sí cuenta', async () => {
    await setTemporaryPasswordExpiry(luis.id, -1);

    const wrong = await login(luis.email, WRONG_PASSWORD);
    const unknown = await login(uniqueEmail('nadie'), WRONG_PASSWORD);

    expectProblem(wrong, 401, 'INVALID_CREDENTIALS');
    expect(wrong.body).toEqual(unknown.body);
    expect(await loginAttempt(luis.email)).toMatchObject({ failed_count: 1 });
  });

  it('[US5-AC9] si la temporal vence durante la sesión, POST /auth/password → 401 TEMPORARY_PASSWORD_EXPIRED y revoca la sesión (temp_password_expired)', async () => {
    const session = await loginOk(luis, TEMPORARY);
    const sid = sidOf(session.accessToken);
    await setTemporaryPasswordExpiry(luis.id, -1);
    const before = await passwordRow(luis);

    const res = await changePassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: NEW_PASSWORD,
    });

    expectProblem(res, 401, 'TEMPORARY_PASSWORD_EXPIRED');
    expect(res.body).not.toHaveProperty('accessToken');
    // The revocation is committed although the request fails.
    const row = await sessionById(luis, sid);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe('temp_password_expired');
    expect(await passwordRow(luis)).toEqual(before);
    expectProblem(await me(session.accessToken), 401, 'SESSION_REVOKED');
    expectProblem(await refresh(session.refreshCookie), 401, 'SESSION_REVOKED');
  });
});
