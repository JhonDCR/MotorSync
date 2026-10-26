// T025 (specs/003-soporte-plataforma, Phase 4, US2): e2e of the support panel access
// (US2-AC3, US2-AC4, US2-AC5, US2-AC6, US2-AC9, US2-AC10, FR-009, FR-010 and research R4)
// over the full app wiring (AppModule + configureApp) and the real PostgreSQL, the API
// connecting as motorsync_app and the fixtures/operations as motorsync_migrator.
//
// Contract (contracts/openapi.yaml):
// - POST /api/v1/support/auth/login (@Public) body SupportLoginRequest { email, password } →
//   200 SupportSessionResponse { accessToken, expiresIn: 900, agent } and a NEW
//   `Set-Cookie: ms_support_refresh=<32 bytes base64url>; Path=/api/v1/support/auth; HttpOnly;
//   Secure; SameSite=Strict` (no Max-Age). The token is HS256, 15 minutes, with sub, sid, name,
//   pwd_change and aud motorsync-support, and NO tenant_id nor role (research R3).
//   401 INVALID_CREDENTIALS (unknown email, wrong password, inactive account: identical body and
//   equivalent time), 401 TEMPORARY_PASSWORD_EXPIRED (correct temporary but expired, not counted
//   as a failure) and 429 ACCOUNT_LOCKED (5 failures in a row, 15 minutes).
// - POST /api/v1/support/auth/refresh (@Public, cookie ms_support_refresh + `X-Requested-With:
//   motorsync`) → 200 with a rotated cookie and a new token; 401 SESSION_EXPIRED / SESSION_REVOKED
//   (clears the cookie); 409 REFRESH_CONFLICT (rotated less than 10 s ago); 400 VALIDATION_ERROR
//   without the CSRF header.
// - POST /api/v1/support/auth/logout (@Public, same header) → 204 always, revokes the session
//   (revoke_reason = 'logout') and clears the cookie.
// - GET /api/v1/support/auth/me (Bearer) → 200 { agent }, allowed with a pending password change.
// - POST /api/v1/support/auth/password (Bearer, allowed with a pending change) body
//   ChangePasswordRequest { currentPassword, newPassword } → 200 SupportSessionResponse with a
//   token whose pwd_change is false; 400 CURRENT_PASSWORD_INCORRECT (counts for the lock),
//   400 VALIDATION_ERROR (PASSWORD_TOO_SHORT, SAME_PASSWORD), 401 TEMPORARY_PASSWORD_EXPIRED
//   (revokes the session, revoke_reason = 'temp_password_expired'), 429 ACCOUNT_LOCKED. Changing
//   the password closes the other support sessions (revoke_reason = 'password_changed').
// - Zone separation in both directions (US2-AC5, US2-AC6): a workshop token on a panel route is
//   403 FORBIDDEN and a support token on a workshop route is 403 FORBIDDEN; each refresh cookie is
//   useless in the other zone and each set of credentials fails with INVALID_CREDENTIALS.
// - GET /support/tickets and the ticket routes belong to T029; they are asserted here as the
//   contract says (403) and stay red until then, exactly like the tasks.md bullet requires.
//
// Simulated time: setSupportSessionLastActivity (30 min inactivity), setSupportTemporaryPasswordExpiry
// (72 h temporary), setSupportRefreshRotatedAt (10 s reuse window) and setLockedUntil (15 min
// lock); the e2e never waits minutes. The statistical comparison (20 samples, 25 % tolerance)
// follows auth-login.e2e-spec.ts of the 002 and is skipped on local Windows (plan risk 4).
// The concurrency case uses the operations script of T026 (runSupportAccount), which does not
// exist yet: it is imported dynamically inside that test so the rest of the suite still runs and
// fails only with the 404 of the routes that T027 implements.
import { createHash, randomUUID } from 'node:crypto';
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
  withRefreshCookie,
} from './setup/auth.js';
import {
  closeFixtures,
  countRows,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  emailHash,
  readSupportSessions,
  readTickets,
  setLockedUntil,
  setSupportRefreshRotatedAt,
  setSupportSessionLastActivity,
  setSupportTemporaryPasswordExpiry,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  SUPPORT_REFRESH_COOKIE_NAME,
  enableTrustProxyForTests,
  loginAsSupport,
  supportRefreshCookieFrom,
  withSupportRefreshCookie,
} from './setup/support.js';

const SUPPORT_AUTH = '/api/v1/support/auth';
const SUPPORT_COOKIE_PATH = 'path=/api/v1/support/auth';
const SUPPORT_COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD = 'Clave-Segura-123';
const WRONG_PASSWORD = 'Clave-Equivocada-9';
const NEW_PASSWORD = 'Nueva-Clave-2026';
const TEMPORARY = 'Temporal-Pedro-472';
const SUPPORT_NAME = 'Pedro Soporte';
const SUPPORT_EMAIL = 'pedro@motorsync.ec';
const TEMPORARY_NAME = 'Pedro Temporal';
const TEMPORARY_EMAIL = 'pedro.temporal@motorsync.ec';
const SEVENTY_TWO_HOURS_MS = 72 * 3600 * 1000;
/** Tolerance for "last_activity_at is back to now()": far below the 29 minutes moved back. */
const NOW_TOLERANCE_MS = 60_000;

/** Statistical test (US2-AC3, like SC-003 of the 002): skippable on local Windows, always on CI. */
const SKIP_TIMING = process.platform === 'win32' && !process.env.CI;
const TIMING_SAMPLES = 20;
const TIMING_TOLERANCE = 0.25;

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

interface SupportRefreshTokenRow {
  token_hash: string;
  rotated_at: Date | null;
}

interface WorkshopUserRow {
  role: string;
  status: string;
}

// T026 contract (research R5): the operations script exports runSupportAccount(argv, deps).
// It does not exist yet, so this type-level import is the expected tsc error until T026 lands;
// it is erased at runtime, which keeps the rest of this suite runnable in the red phase.
type RunSupportAccount =
  typeof import('../scripts/support-account.js').runSupportAccount;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** An email that exists neither in support_accounts nor in users. */
function uniqueSupportEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@motorsync.ec`;
}

describe('Support auth: acceso al panel (e2e, T025, US2)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  /** Admin of workshop A: the workshop token of the separation checks (US2-AC5). */
  let ana: UserFixture;
  /** Asesor of workshop A: the target of the workshop operations (US2-AC6). */
  let luis: UserFixture;
  /** Active support account with a known, non-temporary password. */
  let pedro: SupportAccountFixture;

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

  function expectNoData(res: Response, ...keys: string[]): void {
    for (const key of keys) expect(res.body).not.toHaveProperty(key);
  }

  /** Full `Set-Cookie` header of ms_support_refresh, attributes included. */
  function rawSupportCookie(res: Response): string | undefined {
    const header = res.headers['set-cookie'] as string | string[] | undefined;
    const cookies =
      header === undefined ? [] : Array.isArray(header) ? header : [header];
    return cookies.find((value) =>
      value.startsWith(`${SUPPORT_REFRESH_COOKIE_NAME}=`),
    );
  }

  function attributesOf(cookie: string): string[] {
    return cookie
      .split(';')
      .slice(1)
      .map((part) => part.trim().toLowerCase());
  }

  /** A new ms_support_refresh: contract attributes, no Max-Age nor Expires. Returns `name=value`. */
  function expectSupportRefreshCookie(res: Response): string {
    const pair = supportRefreshCookieFrom(res);
    expect(pair, 'Set-Cookie ms_support_refresh').toBeDefined();
    expect(
      (pair as string).slice(SUPPORT_REFRESH_COOKIE_NAME.length + 1),
    ).toMatch(SUPPORT_COOKIE_VALUE_RE);
    const cookie = rawSupportCookie(res) as string;
    const attributes = attributesOf(cookie);
    expect(attributes).toEqual(
      expect.arrayContaining([
        SUPPORT_COOKIE_PATH,
        'httponly',
        'secure',
        'samesite=strict',
      ]),
    );
    expect(
      attributes.some((attribute) => attribute.startsWith('max-age')),
    ).toBe(false);
    expect(
      attributes.some((attribute) => attribute.startsWith('expires')),
    ).toBe(false);
    return pair as string;
  }

  /** The cookie is cleared: `ms_support_refresh=; Path=/api/v1/support/auth; ...; Max-Age=0`. */
  function expectClearedSupportCookie(res: Response): void {
    expect(supportRefreshCookieFrom(res)).toBe(
      `${SUPPORT_REFRESH_COOKIE_NAME}=`,
    );
    const cookie = rawSupportCookie(res) as string;
    const attributes = attributesOf(cookie);
    expect(attributes).toContain('max-age=0');
    expect(attributes).toContain(SUPPORT_COOKIE_PATH);
  }

  function loginSupport(email: string, password: string): Promise<Response> {
    return server().post(`${SUPPORT_AUTH}/login`).send({ email, password });
  }

  function loginSupportFrom(
    email: string,
    password: string,
    ip: string,
  ): Promise<Response> {
    return server()
      .post(`${SUPPORT_AUTH}/login`)
      .set('X-Forwarded-For', ip)
      .send({ email, password });
  }

  function supportMe(accessToken: string): Promise<Response> {
    return server().get(`${SUPPORT_AUTH}/me`).set(authHeader(accessToken));
  }

  function changeSupportPassword(
    accessToken: string,
    body: Json,
  ): Promise<Response> {
    return server()
      .post(`${SUPPORT_AUTH}/password`)
      .set(authHeader(accessToken))
      .send(body);
  }

  function supportRefresh(cookie: string): Promise<Response> {
    return server()
      .post(`${SUPPORT_AUTH}/refresh`)
      .set(withSupportRefreshCookie(cookie))
      .send();
  }

  function supportLogout(cookie: string): Promise<Response> {
    return server()
      .post(`${SUPPORT_AUTH}/logout`)
      .set(withSupportRefreshCookie(cookie))
      .send();
  }

  function sidOf(accessToken: string): string {
    return decodeJwtPayload(accessToken).sid as string;
  }

  /** SHA-256 hex of the cookie value: what support_refresh_tokens.token_hash stores. */
  function tokenHashOf(cookie: string): string {
    const value = cookie.slice(`${SUPPORT_REFRESH_COOKIE_NAME}=`.length);
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  function expectAboutNow(date: Date): void {
    expect(Math.abs(Date.now() - date.getTime())).toBeLessThan(
      NOW_TOLERANCE_MS,
    );
  }

  async function supportSessionById(accountId: string, sessionId: string) {
    const sessions = await readSupportSessions(accountId);
    const session = sessions.find((row) => row.id === sessionId);
    expect(session, `support session ${sessionId}`).toBeDefined();
    return session as NonNullable<typeof session>;
  }

  async function loginAttempt(email: string): Promise<AttemptRow | undefined> {
    const result = await migratorPool.query<AttemptRow>(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0];
  }

  async function clearLoginAttempts(email: string): Promise<void> {
    await migratorPool.query(
      'DELETE FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
  }

  async function refreshTokens(
    sessionId: string,
  ): Promise<SupportRefreshTokenRow[]> {
    const result = await migratorPool.query<SupportRefreshTokenRow>(
      `SELECT token_hash, rotated_at
         FROM support_refresh_tokens
        WHERE session_id = $1
        ORDER BY created_at, id`,
      [sessionId],
    );
    return result.rows;
  }

  async function supportAccountStatus(accountId: string): Promise<string> {
    const result = await migratorPool.query<{ status: string }>(
      'SELECT status FROM support_accounts WHERE id = $1',
      [accountId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].status;
  }

  /** Deactivation by the migrator, as the operations script does (research R5, US2-AC10). */
  async function setSupportAccountStatus(
    accountId: string,
    status: 'active' | 'inactive',
  ): Promise<void> {
    const result = await migratorPool.query(
      'UPDATE support_accounts SET status = $2, updated_at = now() WHERE id = $1',
      [accountId, status],
    );
    expect(result.rowCount).toBe(1);
  }

  async function readWorkshopUser(user: UserFixture): Promise<WorkshopUserRow> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        user.tenantId,
      ]);
      const result = await client.query<WorkshopUserRow>(
        'SELECT role, status FROM users WHERE id = $1',
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

  function temporaryAgent(): Promise<SupportAccountFixture> {
    return createSupportAccount({
      name: TEMPORARY_NAME,
      email: TEMPORARY_EMAIL,
      password: TEMPORARY,
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + SEVENTY_TWO_HOURS_MS),
    });
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
    // FR-004 / research R8: the test app reads X-Forwarded-For; production does not change.
    enableTrustProxyForTests(app);
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A soporte e2e ${randomUUID()}`);
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
    pedro = await createSupportAccount({
      name: SUPPORT_NAME,
      email: SUPPORT_EMAIL,
      password: PASSWORD,
      mustChangePassword: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US2-AC3

  it('[US2-AC3][T025] login correcto → 200 con agent, expiresIn 900, token de 15 min sin tenant_id ni role, sesión y cookie de soporte', async () => {
    const res = await loginSupport(SUPPORT_EMAIL, PASSWORD);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      agent: {
        id: pedro.id,
        name: SUPPORT_NAME,
        email: SUPPORT_EMAIL,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      },
    });
    const body = res.body as Json;
    expect(typeof body.accessToken).toBe('string');
    expect(Object.keys(body).sort()).toEqual([
      'accessToken',
      'agent',
      'expiresIn',
    ]);

    const claims = decodeJwtPayload(body.accessToken as string);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(claims).toMatchObject({
      sub: pedro.id,
      sid: expect.any(String),
      name: SUPPORT_NAME,
      pwd_change: false,
      aud: 'motorsync-support',
    });
    expect(claims.exp).toBe((claims.iat as number) + 900);
    expect(
      Math.abs((claims.exp as number) - (nowSeconds + 900)),
    ).toBeLessThanOrEqual(5);
    // Research R3: the support token carries no workshop identity.
    expect(claims).not.toHaveProperty('tenant_id');
    expect(claims).not.toHaveProperty('role');

    const sessions = await readSupportSessions(pedro.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: claims.sid,
      supportAccountId: pedro.id,
      revokedAt: null,
      revokeReason: null,
    });
    expectAboutNow(sessions[0].lastActivityAt);

    const cookie = expectSupportRefreshCookie(res);
    expect(cookie).not.toBe(body.accessToken);
    // The refresh token never travels in the body.
    expect(
      res.text.includes(cookie.slice(SUPPORT_REFRESH_COOKIE_NAME.length + 1)),
    ).toBe(false);
  }, 60_000);

  it('[US2-AC3] correo inexistente, contraseña incorrecta y cuenta inactive → 401 INVALID_CREDENTIALS con el mismo body y sin sesión', async () => {
    const inactive = await createSupportAccount({
      name: 'Pedro Inactivo',
      email: 'pedro.inactivo@motorsync.ec',
      password: PASSWORD,
      status: 'inactive',
      mustChangePassword: false,
    });

    const unknown = await loginSupport(uniqueSupportEmail('nadie'), PASSWORD);
    const wrong = await loginSupport(SUPPORT_EMAIL, WRONG_PASSWORD);
    const disabled = await loginSupport(inactive.email, PASSWORD);

    for (const res of [unknown, wrong, disabled]) {
      expectProblem(res, 401, 'INVALID_CREDENTIALS');
      expect(rawSupportCookie(res)).toBeUndefined();
      expect(res.body).not.toHaveProperty('accessToken');
    }
    expect(wrong.body).toEqual(unknown.body);
    expect(disabled.body).toEqual(unknown.body);

    expect(await readSupportSessions(pedro.id)).toEqual([]);
    expect(await readSupportSessions(inactive.id)).toEqual([]);
  }, 60_000);

  it.skipIf(SKIP_TIMING)(
    '[US2-AC3] estadística: 20 intentos de correo inexistente frente a contraseña incorrecta con medianas que difieren menos del 25 %',
    async () => {
      async function timed(body: Json): Promise<number> {
        const started = process.hrtime.bigint();
        const res = await server().post(`${SUPPORT_AUTH}/login`).send(body);
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        expectProblem(res, 401, 'INVALID_CREDENTIALS');
        return elapsed;
      }

      // Warm-up (JIT, connection pool, dummy hash).
      for (let index = 0; index < 3; index += 1) {
        await timed({
          email: uniqueSupportEmail('calentar'),
          password: PASSWORD,
        });
        await clearLoginAttempts(SUPPORT_EMAIL);
        await timed({ email: SUPPORT_EMAIL, password: WRONG_PASSWORD });
      }

      const unknownTimes: number[] = [];
      const wrongTimes: number[] = [];
      // Interleaved so load drift affects both cases alike. The lock counter is cleared before
      // every attempt on the real account so that none is answered by the 5/15 lock.
      for (let index = 0; index < TIMING_SAMPLES; index += 1) {
        unknownTimes.push(
          await timed({
            email: uniqueSupportEmail('nadie'),
            password: PASSWORD,
          }),
        );
        await clearLoginAttempts(SUPPORT_EMAIL);
        wrongTimes.push(
          await timed({ email: SUPPORT_EMAIL, password: WRONG_PASSWORD }),
        );
      }

      const unknownMedian = median(unknownTimes);
      const wrongMedian = median(wrongTimes);
      const summary = JSON.stringify({
        unknown: unknownMedian,
        wrong: wrongMedian,
      });
      const difference =
        Math.abs(unknownMedian - wrongMedian) /
        Math.max(unknownMedian, wrongMedian);
      expect(difference, `medianas (ms) ${summary}`).toBeLessThan(
        TIMING_TOLERANCE,
      );
    },
    120_000,
  );

  it('[US2-AC3] 5 fallos seguidos → 429 ACCOUNT_LOCKED también con la contraseña correcta; con el bloqueo vencido vuelve a entrar', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expectProblem(
        await loginSupport(SUPPORT_EMAIL, WRONG_PASSWORD),
        401,
        'INVALID_CREDENTIALS',
      );
    }
    const attempt = await loginAttempt(SUPPORT_EMAIL);
    expect(attempt?.failed_count).toBe(5);
    expect(attempt?.locked_until).toBeInstanceOf(Date);

    const locked = await loginSupport(SUPPORT_EMAIL, PASSWORD);
    expectProblem(locked, 429, 'ACCOUNT_LOCKED');
    expect(rawSupportCookie(locked)).toBeUndefined();
    expect(await readSupportSessions(pedro.id)).toEqual([]);

    await setLockedUntil(SUPPORT_EMAIL, -1);
    const recovered = await loginSupport(SUPPORT_EMAIL, PASSWORD);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(await loginAttempt(SUPPORT_EMAIL)).toBeUndefined();
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC4 / FR-010

  it('[US2-AC4][FR-010] el login solo pide correo y contraseña: tenantId o role en el body → 400 UNKNOWN_FIELD y ninguna sesión', async () => {
    for (const [field, value] of [
      ['tenantId', tenantA.id],
      ['role', 'admin'],
    ] as const) {
      const res = await server()
        .post(`${SUPPORT_AUTH}/login`)
        .send({ email: SUPPORT_EMAIL, password: PASSWORD, [field]: value });

      expectProblem(res, 400, 'VALIDATION_ERROR');
      expectFieldError(res, field, 'UNKNOWN_FIELD');
      expect(rawSupportCookie(res)).toBeUndefined();
    }
    expect(await readSupportSessions(pedro.id)).toEqual([]);
  });

  it('[US2-AC4][FR-010] desde dos X-Forwarded-For distintos las mismas credenciales dan el mismo resultado', async () => {
    const first = await loginSupportFrom(
      SUPPORT_EMAIL,
      PASSWORD,
      '203.0.113.10',
    );
    const second = await loginSupportFrom(
      SUPPORT_EMAIL,
      PASSWORD,
      '198.51.100.20',
    );

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect((first.body as Json).agent).toEqual((second.body as Json).agent);
    expect((first.body as Json).expiresIn).toBe(900);
    expect(await readSupportSessions(pedro.id)).toHaveLength(2);
  }, 60_000);

  // ---------------------------------------------------------------- FR-009 (temporary password)

  it('[FR-009] con mustChangePassword true: me → 200, tickets → 403 PASSWORD_CHANGE_REQUIRED y el cambio de la temporal → 200 con pwd_change false', async () => {
    await temporaryAgent();
    const session = await loginAsSupport(app, TEMPORARY_EMAIL, TEMPORARY);

    const me = await supportMe(session.accessToken);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body).toMatchObject({
      agent: {
        id: expect.any(String),
        name: TEMPORARY_NAME,
        email: TEMPORARY_EMAIL,
        mustChangePassword: true,
      },
    });
    const expiresAt = (me.body as { agent: Json }).agent
      .temporaryPasswordExpiresAt as string;
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // T029 implements GET /support/tickets; until then this route is 404.
    const tickets = await server()
      .get('/api/v1/support/tickets')
      .set(authHeader(session.accessToken));
    expectProblem(tickets, 403, 'PASSWORD_CHANGE_REQUIRED');
    expectNoData(tickets, 'tickets', 'items');

    const changed = await changeSupportPassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      expiresIn: 900,
      agent: {
        name: TEMPORARY_NAME,
        email: TEMPORARY_EMAIL,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      },
    });
    const newToken = (changed.body as Json).accessToken as string;
    expect(decodeJwtPayload(newToken)).toMatchObject({
      sub: (me.body as { agent: { id: string } }).agent.id,
      pwd_change: false,
      aud: 'motorsync-support',
    });
    expect((await supportMe(newToken)).status).toBe(200);

    // The temporary password stops working; the new one logs in without a pending change.
    expectProblem(
      await loginSupport(TEMPORARY_EMAIL, TEMPORARY),
      401,
      'INVALID_CREDENTIALS',
    );
    const relogin = await loginSupport(TEMPORARY_EMAIL, NEW_PASSWORD);
    expect(relogin.status, JSON.stringify(relogin.body)).toBe(200);
    expect((relogin.body as Json).agent).toMatchObject({
      mustChangePassword: false,
    });
  }, 60_000);

  it('[FR-009] nueva de 7 caracteres → PASSWORD_TOO_SHORT y nueva igual a la actual → SAME_PASSWORD, sin cambios ni fallos', async () => {
    await temporaryAgent();
    const session = await loginAsSupport(app, TEMPORARY_EMAIL, TEMPORARY);

    const short = await changeSupportPassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: 'Corta-7',
    });
    expectProblem(short, 400, 'VALIDATION_ERROR');
    expectFieldError(short, 'newPassword', 'PASSWORD_TOO_SHORT');

    const same = await changeSupportPassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: TEMPORARY,
    });
    expectProblem(same, 400, 'VALIDATION_ERROR');
    expectFieldError(same, 'newPassword', 'SAME_PASSWORD');

    const me = await supportMe(session.accessToken);
    expect(me.body).toMatchObject({ agent: { mustChangePassword: true } });
    expect(await loginAttempt(TEMPORARY_EMAIL)).toBeUndefined();
  }, 60_000);

  it('[FR-009] contraseña actual incorrecta → 400 CURRENT_PASSWORD_INCORRECT y 5 seguidas → 429 ACCOUNT_LOCKED sin cerrar la sesión', async () => {
    const temporal = await temporaryAgent();
    const session = await loginAsSupport(app, TEMPORARY_EMAIL, TEMPORARY);
    const sid = sidOf(session.accessToken);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await changeSupportPassword(session.accessToken, {
        currentPassword: WRONG_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expectProblem(res, 400, 'CURRENT_PASSWORD_INCORRECT');
      expectFieldError(res, 'currentPassword', 'CURRENT_PASSWORD_INCORRECT');
    }
    expect((await loginAttempt(TEMPORARY_EMAIL))?.failed_count).toBe(5);

    // Locked: even the correct current password is refused, without changing anything.
    const locked = await changeSupportPassword(session.accessToken, {
      currentPassword: TEMPORARY,
      newPassword: NEW_PASSWORD,
    });
    expectProblem(locked, 429, 'ACCOUNT_LOCKED');
    expectProblem(
      await loginSupport(TEMPORARY_EMAIL, TEMPORARY),
      429,
      'ACCOUNT_LOCKED',
    );

    // The session in course stays open and the temporary password is still pending.
    const me = await supportMe(session.accessToken);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body).toMatchObject({ agent: { mustChangePassword: true } });
    expect((await supportSessionById(temporal.id, sid)).revokedAt).toBeNull();
  }, 60_000);

  it('[FR-009] con dos sesiones, cambiar desde una revoca la otra con revoke_reason password_changed', async () => {
    const tablet = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const phone = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const tabletSid = sidOf(tablet.accessToken);
    const phoneSid = sidOf(phone.accessToken);
    expect(tabletSid).not.toBe(phoneSid);

    const changed = await changeSupportPassword(tablet.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const newToken = (changed.body as Json).accessToken as string;
    expect(sidOf(newToken)).toBe(tabletSid);
    expect(decodeJwtPayload(newToken)).toMatchObject({
      sub: pedro.id,
      sid: tabletSid,
      pwd_change: false,
    });

    expectProblem(await supportMe(phone.accessToken), 401, 'SESSION_REVOKED');
    const phoneRefresh = await supportRefresh(phone.refreshCookie);
    expectProblem(phoneRefresh, 401, 'SESSION_REVOKED');
    expectClearedSupportCookie(phoneRefresh);
    expect((await supportSessionById(pedro.id, phoneSid)).revokeReason).toBe(
      'password_changed',
    );

    expect((await supportMe(newToken)).status).toBe(200);
    expect((await supportMe(tablet.accessToken)).status).toBe(200);
    expect(
      (await supportSessionById(pedro.id, tabletSid)).revokedAt,
    ).toBeNull();
  }, 60_000);

  it('[FR-009] temporal vencida: el login con la contraseña correcta → 401 TEMPORARY_PASSWORD_EXPIRED sin contar fallo ni abrir sesión', async () => {
    await setSupportTemporaryPasswordExpiry(pedro.id, -1);

    const res = await loginSupport(SUPPORT_EMAIL, PASSWORD);

    expectProblem(res, 401, 'TEMPORARY_PASSWORD_EXPIRED');
    expect(rawSupportCookie(res)).toBeUndefined();
    expect(res.body).not.toHaveProperty('accessToken');
    expect(await loginAttempt(SUPPORT_EMAIL)).toBeUndefined();
    expect(await readSupportSessions(pedro.id)).toEqual([]);

    // A wrong password is still the generic error and it does count as a failure.
    const wrong = await loginSupport(SUPPORT_EMAIL, WRONG_PASSWORD);
    expectProblem(wrong, 401, 'INVALID_CREDENTIALS');
    expect((await loginAttempt(SUPPORT_EMAIL))?.failed_count).toBe(1);
  }, 60_000);

  it('[FR-009] si la temporal vence durante la sesión, POST /support/auth/password → 401 TEMPORARY_PASSWORD_EXPIRED y revoca la sesión', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);
    await setSupportTemporaryPasswordExpiry(pedro.id, -1);

    const res = await changeSupportPassword(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expectProblem(res, 401, 'TEMPORARY_PASSWORD_EXPIRED');
    expect(res.body).not.toHaveProperty('accessToken');
    const row = await supportSessionById(pedro.id, sid);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe('temp_password_expired');

    expectProblem(await supportMe(session.accessToken), 401, 'SESSION_REVOKED');
    const refresh = await supportRefresh(session.refreshCookie);
    expectProblem(refresh, 401, 'SESSION_REVOKED');
    expectClearedSupportCookie(refresh);
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC9 (inactivity and logout)

  it('[US2-AC9] con 29 minutos sin actividad → 200 y con 31 → 401 SESSION_EXPIRED, también en el refresh que borra la cookie', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);

    await setSupportSessionLastActivity(sid, 29);
    const alive = await supportMe(session.accessToken);
    expect(alive.status, JSON.stringify(alive.body)).toBe(200);
    expectAboutNow((await supportSessionById(pedro.id, sid)).lastActivityAt);

    await setSupportSessionLastActivity(sid, 31);
    const expired = await supportMe(session.accessToken);
    expectProblem(expired, 401, 'SESSION_EXPIRED');
    expectNoData(expired, 'agent');

    const refresh = await supportRefresh(session.refreshCookie);
    expectProblem(refresh, 401, 'SESSION_EXPIRED');
    expectClearedSupportCookie(refresh);
    expect(refresh.body).not.toHaveProperty('accessToken');
  }, 60_000);

  it('[US2-AC9] logout → 204 con Max-Age=0 y Path de soporte; después el token y la cookie dan 401 SESSION_REVOKED; un segundo logout → 204', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);

    const logout = await supportLogout(session.refreshCookie);
    expect(logout.status, JSON.stringify(logout.body)).toBe(204);
    expect(logout.text ?? '').toBe('');
    expectClearedSupportCookie(logout);
    expect((await supportSessionById(pedro.id, sid)).revokeReason).toBe(
      'logout',
    );

    expectProblem(await supportMe(session.accessToken), 401, 'SESSION_REVOKED');
    const refresh = await supportRefresh(session.refreshCookie);
    expectProblem(refresh, 401, 'SESSION_REVOKED');
    expectClearedSupportCookie(refresh);

    const again = await supportLogout(session.refreshCookie);
    expect(again.status, JSON.stringify(again.body)).toBe(204);
    expectClearedSupportCookie(again);
    expect((await supportSessionById(pedro.id, sid)).revokeReason).toBe(
      'logout',
    );
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC9 (refresh)

  it('[US2-AC9] el refresh rota la cookie y el token, marca el anterior como rotado y renueva la actividad', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);

    const refreshed = await supportRefresh(session.refreshCookie);

    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body).toMatchObject({
      expiresIn: 900,
      agent: { id: pedro.id, name: SUPPORT_NAME, email: SUPPORT_EMAIL },
    });
    const body = refreshed.body as Json;
    expect(body.accessToken).not.toBe(session.accessToken);
    expect(decodeJwtPayload(body.accessToken as string)).toMatchObject({
      sub: pedro.id,
      sid,
      pwd_change: false,
      aud: 'motorsync-support',
    });

    const newCookie = expectSupportRefreshCookie(refreshed);
    expect(newCookie).not.toBe(session.refreshCookie);
    expect(
      refreshed.text.includes(
        newCookie.slice(SUPPORT_REFRESH_COOKIE_NAME.length + 1),
      ),
    ).toBe(false);

    const tokens = await refreshTokens(sid);
    const oldToken = tokens.find(
      (token) => token.token_hash === tokenHashOf(session.refreshCookie),
    );
    const currentToken = tokens.find(
      (token) => token.token_hash === tokenHashOf(newCookie),
    );
    expect(oldToken?.rotated_at).toBeInstanceOf(Date);
    expect(currentToken).toMatchObject({ rotated_at: null });

    expectAboutNow((await supportSessionById(pedro.id, sid)).lastActivityAt);
    expect((await supportMe(body.accessToken as string)).status).toBe(200);
  }, 60_000);

  it('[US2-AC9] una cookie rotada hace 5 s (ventana de 10 s) → 409 REFRESH_CONFLICT sin revocar la sesión', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);
    const first = await supportRefresh(session.refreshCookie);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const current = expectSupportRefreshCookie(first);
    await setSupportRefreshRotatedAt(tokenHashOf(session.refreshCookie), 5);

    const conflict = await supportRefresh(session.refreshCookie);

    expectProblem(conflict, 409, 'REFRESH_CONFLICT');
    expect(conflict.body).not.toHaveProperty('accessToken');
    const row = await supportSessionById(pedro.id, sid);
    expect(row.revokedAt).toBeNull();
    expect(row.revokeReason).toBeNull();
    // The client retries with the cookie the browser already has and it works.
    const retry = await supportRefresh(current);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expectSupportRefreshCookie(retry);
  }, 60_000);

  it('[US2-AC9] una cookie rotada hace 11 s → 401 SESSION_REVOKED y revoca la sesión entera (refresh_reuse)', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);
    const first = await supportRefresh(session.refreshCookie);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const current = expectSupportRefreshCookie(first);
    const currentAccess = (first.body as Json).accessToken as string;
    await setSupportRefreshRotatedAt(tokenHashOf(session.refreshCookie), 11);

    const reuse = await supportRefresh(session.refreshCookie);

    expectProblem(reuse, 401, 'SESSION_REVOKED');
    expectClearedSupportCookie(reuse);
    const row = await supportSessionById(pedro.id, sid);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe('refresh_reuse');

    expectProblem(await supportRefresh(current), 401, 'SESSION_REVOKED');
    expectProblem(await supportMe(currentAccess), 401, 'SESSION_REVOKED');
    expectProblem(await supportMe(session.accessToken), 401, 'SESSION_REVOKED');
  }, 60_000);

  it('[US2-AC9] el refresh sin X-Requested-With: motorsync → 400 VALIDATION_ERROR y no rota la cookie', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const sid = sidOf(session.accessToken);

    const withoutHeader = await server()
      .post(`${SUPPORT_AUTH}/refresh`)
      .set('Cookie', session.refreshCookie)
      .send();
    expectProblem(withoutHeader, 400, 'VALIDATION_ERROR');
    expect(supportRefreshCookieFrom(withoutHeader)).toBeUndefined();

    expect(
      (await refreshTokens(sid)).every((token) => token.rotated_at === null),
    ).toBe(true);
    expect((await supportRefresh(session.refreshCookie)).status).toBe(200);
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC5 (workshop → panel)

  it('[US2-AC5] el token del admin del taller A en las rutas del panel → 403 FORBIDDEN sin datos ni cambios; su cookie y sus credenciales tampoco sirven', async () => {
    const workshop = await loginAs(app, ana.email, PASSWORD);
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const before = {
      users: await countRows('users'),
      supportSessions: await countRows('support_sessions'),
      tickets: await countRows('support_tickets'),
    };

    const me = await supportMe(workshop.accessToken);
    expectProblem(me, 403, 'FORBIDDEN');
    expectNoData(me, 'agent', 'user');

    const password = await changeSupportPassword(workshop.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expectProblem(password, 403, 'FORBIDDEN');
    expectNoData(password, 'accessToken', 'agent');

    // T029 implements the ticket routes; until then they are 404.
    const inbox = await server()
      .get('/api/v1/support/tickets')
      .set(authHeader(workshop.accessToken));
    expectProblem(inbox, 403, 'FORBIDDEN');
    expectNoData(inbox, 'tickets', 'items');

    const detail = await server()
      .get(`/api/v1/support/tickets/${ticket.id}`)
      .set(authHeader(workshop.accessToken));
    expectProblem(detail, 403, 'FORBIDDEN');
    expectNoData(detail, 'ticket', 'id');

    const discard = await server()
      .post(`/api/v1/support/tickets/${ticket.id}/discard`)
      .set(authHeader(workshop.accessToken))
      .send({ reason: 'Intento desde un taller' });
    expectProblem(discard, 403, 'FORBIDDEN');
    expectNoData(discard, 'ticket');

    // The ms_refresh cookie is not a support cookie: the panel refresh rejects it.
    const panelRefresh = await server()
      .post(`${SUPPORT_AUTH}/refresh`)
      .set(withRefreshCookie(workshop.refreshCookie))
      .send();
    expect(panelRefresh.status, JSON.stringify(panelRefresh.body)).toBe(401);
    expect(panelRefresh.body).toMatchObject({
      code: expect.stringMatching(/^(SESSION_EXPIRED|SESSION_REVOKED)$/),
    });
    expect(panelRefresh.body).not.toHaveProperty('accessToken');

    // Workshop credentials do not open a support session.
    expectProblem(
      await loginSupport(ana.email, PASSWORD),
      401,
      'INVALID_CREDENTIALS',
    );

    expect(await countRows('users')).toBe(before.users);
    expect(await countRows('support_sessions')).toBe(before.supportSessions);
    expect(await countRows('support_tickets')).toBe(before.tickets);
    expect((await readTickets(ana.id))[0]).toMatchObject({
      id: ticket.id,
      status: 'open',
    });
    // The workshop session of Ana is untouched.
    expect(
      (
        await server()
          .get('/api/v1/auth/me')
          .set(authHeader(workshop.accessToken))
      ).status,
    ).toBe(200);
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC6 (panel → workshop)

  it('[US2-AC6] el token de soporte en las rutas del taller → 403 FORBIDDEN sin datos ni cambios; su cookie y sus credenciales tampoco sirven', async () => {
    const support = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);
    const before = {
      users: await countRows('users'),
      userSessions: await countRows('user_sessions'),
      auditLog: await countRows('audit_log'),
      luis: await readWorkshopUser(luis),
    };

    const attempts: { label: string; response: Response }[] = [];
    attempts.push({
      label: 'GET /clients/search',
      response: await server()
        .get('/api/v1/clients/search')
        .query({ q: 'an' })
        .set(authHeader(support.accessToken)),
    });
    attempts.push({
      label: 'GET /vehicles/search',
      response: await server()
        .get('/api/v1/vehicles/search')
        .query({ q: 'PB' })
        .set(authHeader(support.accessToken)),
    });
    attempts.push({
      label: 'GET /users',
      response: await server()
        .get('/api/v1/users')
        .set(authHeader(support.accessToken)),
    });
    attempts.push({
      label: 'GET /users/{id}/history',
      response: await server()
        .get(`/api/v1/users/${luis.id}/history`)
        .set(authHeader(support.accessToken)),
    });
    attempts.push({
      label: 'PUT /users/{id}/role',
      response: await server()
        .put(`/api/v1/users/${luis.id}/role`)
        .set(authHeader(support.accessToken))
        .send({ role: 'admin' }),
    });
    attempts.push({
      label: 'POST /users/{id}/deactivate',
      response: await server()
        .post(`/api/v1/users/${luis.id}/deactivate`)
        .set(authHeader(support.accessToken))
        .send({}),
    });
    attempts.push({
      label: 'GET /auth/me',
      response: await server()
        .get('/api/v1/auth/me')
        .set(authHeader(support.accessToken)),
    });
    attempts.push({
      label: 'POST /auth/password',
      response: await server()
        .post('/api/v1/auth/password')
        .set(authHeader(support.accessToken))
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });

    for (const { label, response } of attempts) {
      expect(
        response.status,
        `${label}: ${JSON.stringify(response.body)}`,
      ).toBe(403);
      expect(response.body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expectNoData(
        response,
        'items',
        'users',
        'user',
        'accessToken',
        'history',
      );
    }

    expect(await countRows('users')).toBe(before.users);
    expect(await countRows('user_sessions')).toBe(before.userSessions);
    expect(await countRows('audit_log')).toBe(before.auditLog);
    expect(await readWorkshopUser(luis)).toEqual(before.luis);
    expect(before.luis).toEqual({ role: 'asesor', status: 'active' });

    // The ms_support_refresh cookie is not a workshop cookie: the workshop refresh rejects it.
    const workshopRefresh = await server()
      .post('/api/v1/auth/refresh')
      .set(withRefreshCookie(support.refreshCookie))
      .send();
    expect(workshopRefresh.status, JSON.stringify(workshopRefresh.body)).toBe(
      401,
    );
    expect(workshopRefresh.body).toMatchObject({
      code: expect.stringMatching(/^(SESSION_EXPIRED|SESSION_REVOKED)$/),
    });
    expect(workshopRefresh.body).not.toHaveProperty('accessToken');

    // Support credentials do not open a workshop session.
    expectProblem(
      await server()
        .post('/api/v1/auth/login')
        .send({ email: SUPPORT_EMAIL, password: PASSWORD }),
      401,
      'INVALID_CREDENTIALS',
    );

    // Neither password changed.
    expect((await loginAs(app, ana.email, PASSWORD)).accessToken).toBeTruthy();
    expect((await loginAs(app, luis.email, PASSWORD)).accessToken).toBeTruthy();
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC10

  it('[US2-AC10] con la cuenta desactivada por el migrator, la siguiente petición y el refresh → 401 SESSION_REVOKED', async () => {
    const session = await loginAsSupport(app, SUPPORT_EMAIL, PASSWORD);

    await setSupportAccountStatus(pedro.id, 'inactive');

    expectProblem(await supportMe(session.accessToken), 401, 'SESSION_REVOKED');
    const refresh = await supportRefresh(session.refreshCookie);
    expectProblem(refresh, 401, 'SESSION_REVOKED');
    expectClearedSupportCookie(refresh);
    expect(refresh.body).not.toHaveProperty('accessToken');

    expectProblem(
      await loginSupport(SUPPORT_EMAIL, PASSWORD),
      401,
      'INVALID_CREDENTIALS',
    );
  }, 60_000);

  // ---------------------------------------------------------------- R4 (login ↔ deactivation)

  it('[R4][US2-AC10] concurrencia login ↔ desactivación: nunca queda una sesión no revocada de una cuenta inactive', async () => {
    // T026 contract: backend/scripts/support-account.ts exports runSupportAccount(argv, deps).
    // It does not exist yet, so the import is dynamic (by absolute URL of the TS source, which
    // Vitest transforms) and typed with the type-level import above. A static value import would
    // abort the whole suite before T026 lands, hiding the 404 red of the routes of T027.
    const moduleUrl = new URL('../scripts/support-account.ts', import.meta.url)
      .href;
    const { runSupportAccount } = (await import(
      /* @vite-ignore */ moduleUrl
    )) as { runSupportAccount: RunSupportAccount };

    const stdout: string[] = [];
    const stderr: string[] = [];
    const logins = Array.from({ length: 10 }, () =>
      loginSupport(SUPPORT_EMAIL, PASSWORD),
    );
    const deactivate = runSupportAccount(
      ['deactivate', '--email', SUPPORT_EMAIL, '--confirm'],
      {
        pool: migratorPool,
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
    );
    const [responses, code] = await Promise.all([
      Promise.all(logins),
      deactivate,
    ]);

    expect(code, stderr.join('\n')).toBe(0);
    for (const response of responses) {
      // A login of a deactivated account counts as a failed attempt (US2-AC3, FR-009): if the
      // deactivation lands early, 5 of the 10 logins fail and the rest see the lock (429).
      expect([200, 401, 429], JSON.stringify(response.body)).toContain(
        response.status,
      );
      if (response.status === 401) {
        expect(response.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      }
      if (response.status === 429) {
        expect(response.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      }
    }

    expect(await supportAccountStatus(pedro.id)).toBe('inactive');
    // The invariant of research R4: if the account is inactive, no session of it may stay open.
    for (const session of await readSupportSessions(pedro.id)) {
      expect(
        session.revokedAt,
        `open session ${session.id} of an inactive account`,
      ).toBeInstanceOf(Date);
    }
    expect(stdout.join('\n')).not.toContain(PASSWORD);
  }, 60_000);
});
