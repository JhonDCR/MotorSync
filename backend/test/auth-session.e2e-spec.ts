// T035 (specs/002-autenticacion): e2e of the session lifecycle (US3-AC1 to US3-AC7, FR-012, FR-013,
// FR-019) over the full app wiring (AppModule + configureApp) and the real PostgreSQL, the API
// connecting as motorsync_app.
// Contract (contracts/openapi.yaml):
// - POST /api/v1/auth/refresh (@Public, cookie ms_refresh + `X-Requested-With: motorsync`) →
//   200 SessionResponse { accessToken, expiresIn: 900, user, workshop } and a NEW
//   `Set-Cookie: ms_refresh=<32 bytes base64url>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`
//   (rotation, research R5). 401 SESSION_EXPIRED (no cookie, unknown cookie or 30 minutes without
//   activity) or SESSION_REVOKED (closed session, inactive account, reuse of a rotated token more
//   than 10 s ago, which revokes the whole session with revoke_reason = 'refresh_reuse'); every 401
//   clears the cookie (`ms_refresh=; Path=/api/v1/auth; ...; Max-Age=0`). 409 REFRESH_CONFLICT when
//   the presented token was rotated less than 10 s ago (no revocation).
// - POST /api/v1/auth/logout (@Public, same header) → 204 always (idempotent, US3-AC6), revokes the
//   session of the cookie (revoke_reason = 'logout') and clears the cookie.
// - GET /api/v1/auth/me (Bearer) → 200 CurrentSession { user: SessionUser, workshop: { id, name } }.
// - Without `X-Requested-With: motorsync`, refresh and logout → 400 VALIDATION_ERROR (research R11).
// Simulated time: setSessionLastActivity (inactivity) and setRefreshRotatedAt (reuse window); the
// e2e never wait 30 minutes or 10 seconds. Accounts come from createUser (scrypt, research R3).
import { createHash, randomUUID } from 'node:crypto';
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
  loginAs,
  refreshCookieFrom,
  withRefreshCookie,
  type LoginResult,
} from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  createUser,
  readUserSessions,
  setRefreshRotatedAt,
  setSessionLastActivity,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
  type UserRole,
} from './setup/db-fixtures.js';

const REFRESH_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD = 'Clave-Segura-123';
/** Tolerance for "last_activity_at is back to now()": far below the 29 minutes moved back. */
const NOW_TOLERANCE_MS = 60_000;
const ME_SAMPLES = 200;

type Json = Record<string, unknown>;

interface RefreshTokenRow {
  token_hash: string;
  rotated_at: Date | null;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

/** SHA-256 hex of the cookie value: what refresh_tokens.token_hash stores (research R5). */
function tokenHashOf(cookie: string): string {
  const value = cookie.slice(`${REFRESH_COOKIE_NAME}=`.length);
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sidOf(accessToken: string): string {
  return decodeJwtPayload(accessToken).sid as string;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

describe('Auth session: refresh, logout and me (e2e, T035, US3)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Active asesor of A. */
  let ana: UserFixture;
  /** Active asesor of B. */
  let marta: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function rawRefreshCookie(res: Response): string | undefined {
    const header = res.headers['set-cookie'] as string | string[] | undefined;
    const cookies = header === undefined ? [] : Array.isArray(header) ? header : [header];
    return cookies.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  }

  function attributesOf(cookie: string): string[] {
    return cookie
      .split(';')
      .slice(1)
      .map((part) => part.trim().toLowerCase());
  }

  /** A new ms_refresh (rotation): attributes of the contract, no Max-Age. Returns `ms_refresh=<v>`. */
  function expectNewRefreshCookie(res: Response): string {
    const cookie = rawRefreshCookie(res);
    expect(cookie, 'Set-Cookie ms_refresh').toBeDefined();
    const pair = (cookie as string).split(';')[0].trim();
    expect(pair.slice(`${REFRESH_COOKIE_NAME}=`.length)).toMatch(REFRESH_VALUE_RE);
    const attributes = attributesOf(cookie as string);
    expect(attributes).toEqual(
      expect.arrayContaining(['path=/api/v1/auth', 'httponly', 'secure', 'samesite=strict']),
    );
    expect(attributes.some((attribute) => attribute.startsWith('max-age'))).toBe(false);
    expect(attributes.some((attribute) => attribute.startsWith('expires'))).toBe(false);
    return pair;
  }

  /** The cookie is cleared: `ms_refresh=; Path=/api/v1/auth; ...; Max-Age=0`. */
  function expectClearedCookie(res: Response): void {
    const cookie = rawRefreshCookie(res);
    expect(cookie, 'Set-Cookie ms_refresh that clears the cookie').toBeDefined();
    expect((cookie as string).split(';')[0].trim()).toBe(`${REFRESH_COOKIE_NAME}=`);
    const attributes = attributesOf(cookie as string);
    expect(attributes).toContain('max-age=0');
    expect(attributes).toContain('path=/api/v1/auth');
  }

  function refresh(cookie: string): Promise<Response> {
    return server().post('/api/v1/auth/refresh').set(withRefreshCookie(cookie)).send();
  }

  function logout(cookie: string): Promise<Response> {
    return server().post('/api/v1/auth/logout').set(withRefreshCookie(cookie)).send();
  }

  function me(accessToken: string): Promise<Response> {
    return server().get('/api/v1/auth/me').set(authHeader(accessToken));
  }

  /** Any 001 route: an authenticated "action" of the user. */
  function searchClients(accessToken: string): Promise<Response> {
    return server().get('/api/v1/clients/search').query({ q: 'an' }).set(authHeader(accessToken));
  }

  function login(user: UserFixture): Promise<LoginResult> {
    return loginAs(app, user.email, user.password);
  }

  function newAccount(
    tenant: TenantFixture,
    name: string,
    role: UserRole,
  ): Promise<UserFixture> {
    return createUser({
      tenantId: tenant.id,
      name,
      email: uniqueEmail(name.split(' ')[0].toLowerCase()),
      role,
      password: PASSWORD,
    });
  }

  /** Runs `sql` as the migrator with the tenant pinned (FORCE RLS reaches the owner). */
  async function asMigrator<T extends pg.QueryResultRow>(
    tenantId: string,
    sql: string,
    params: unknown[],
  ): Promise<pg.QueryResult<T>> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function updateUser(
    user: UserFixture,
    changes: { role?: UserRole; status?: 'active' | 'inactive' },
  ): Promise<void> {
    const result = await asMigrator(
      user.tenantId,
      `UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status), updated_at = now()
        WHERE id = $1`,
      [user.id, changes.role ?? null, changes.status ?? null],
    );
    expect(result.rowCount).toBe(1);
  }

  async function sessionById(user: UserFixture, sessionId: string) {
    const sessions = await readUserSessions(user.id);
    const session = sessions.find((row) => row.id === sessionId);
    expect(session, `session ${sessionId}`).toBeDefined();
    return session as NonNullable<typeof session>;
  }

  async function refreshTokens(tenantId: string, sessionId: string): Promise<RefreshTokenRow[]> {
    const result = await asMigrator<RefreshTokenRow>(
      tenantId,
      'SELECT token_hash, rotated_at FROM refresh_tokens WHERE session_id = $1 ORDER BY created_at, id',
      [sessionId],
    );
    return result.rows;
  }

  function expectAboutNow(date: Date): void {
    expect(Math.abs(Date.now() - date.getTime())).toBeLessThan(NOW_TOLERANCE_MS);
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
    tenantA = await createTenant(`Taller A sesión e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B sesión e2e ${randomUUID()}`);
    // Every workshop keeps an active admin (FR-018), also when a test changes another account.
    await newAccount(tenantA, 'Alberto Admin', 'admin');
    await newAccount(tenantB, 'Beatriz Admin', 'admin');
    ana = await newAccount(tenantA, 'Ana Pérez', 'asesor');
    marta = await newAccount(tenantB, 'Marta Ruiz', 'asesor');
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US3-AC1

  it('[US3-AC1] con 29 minutos sin actividad una petición da 200 y last_activity_at vuelve a ≈ now()', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);
    await setSessionLastActivity(sid, 29);

    const res = await searchClients(session.accessToken);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectAboutNow((await sessionById(ana, sid)).lastActivityAt);
  });

  it('[US3-AC1][FR-012] tres ciclos de 29 minutos sobre una sesión de más de 12 h siguen dando 200 (sin duración máxima)', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);
    // The session was opened 13 hours ago: there is no maximum duration, only inactivity.
    await asMigrator(
      ana.tenantId,
      `UPDATE user_sessions SET created_at = now() - interval '13 hours' WHERE id = $1`,
      [sid],
    );

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await setSessionLastActivity(sid, 29);
      const res = await searchClients(session.accessToken);
      expect(res.status, `ciclo ${cycle}: ${JSON.stringify(res.body)}`).toBe(200);
      expectAboutNow((await sessionById(ana, sid)).lastActivityAt);
    }

    const row = await sessionById(ana, sid);
    expect(row.revokedAt).toBeNull();
    expect(Date.now() - row.createdAt.getTime()).toBeGreaterThan(12 * 3600 * 1000);
  });

  it('[US3-AC1] POST /auth/refresh con la cookie → 200 SessionResponse, Set-Cookie nuevo y un token de la misma sesión con el rol vigente', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);
    // The role changes in the database after the login: the new token carries the current one.
    await updateUser(ana, { role: 'admin' });
    await setSessionLastActivity(sid, 20);

    const res = await refresh(session.refreshCookie);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      user: {
        id: ana.id,
        name: ana.name,
        email: ana.email,
        role: 'admin',
        mustChangePassword: false,
      },
      workshop: { id: tenantA.id, name: tenantA.name },
    });
    const body = res.body as Json;
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken).not.toBe(session.accessToken);
    const claims = decodeJwtPayload(body.accessToken as string);
    expect(claims).toMatchObject({
      sub: ana.id,
      tenant_id: tenantA.id,
      role: 'admin',
      sid,
      pwd_change: false,
    });

    const newCookie = expectNewRefreshCookie(res);
    expect(newCookie).not.toBe(session.refreshCookie);
    // The refresh token never travels in a body (research R5).
    expect(res.text.includes(newCookie.slice(`${REFRESH_COOKIE_NAME}=`.length))).toBe(false);
    expect(res.text.includes(session.refreshCookie.slice(`${REFRESH_COOKIE_NAME}=`.length))).toBe(false);

    // Rotation: the old token is marked rotated and the new one belongs to the same session.
    const tokens = await refreshTokens(tenantA.id, sid);
    const oldToken = tokens.find((token) => token.token_hash === tokenHashOf(session.refreshCookie));
    const rotatedToken = tokens.find((token) => token.token_hash === tokenHashOf(newCookie));
    expect(oldToken?.rotated_at).toBeInstanceOf(Date);
    expect(rotatedToken).toMatchObject({ rotated_at: null });

    // The refresh is activity too (FR-012), and the new access token works.
    expectAboutNow((await sessionById(ana, sid)).lastActivityAt);
    const search = await searchClients(body.accessToken as string);
    expect(search.status, JSON.stringify(search.body)).toBe(200);
  });

  it('[US3-AC1] la cookie nueva vuelve a refrescar: la sesión se renueva indefinidamente con refresh', async () => {
    const session = await login(ana);
    let cookie = session.refreshCookie;
    for (let round = 1; round <= 3; round += 1) {
      await setSessionLastActivity(sidOf(session.accessToken), 29);
      const res = await refresh(cookie);
      expect(res.status, `ronda ${round}: ${JSON.stringify(res.body)}`).toBe(200);
      cookie = expectNewRefreshCookie(res);
    }
  });

  // ---------------------------------------------------------------- US3-AC2

  it('[US3-AC2] con 31 minutos sin actividad una petición da 401 SESSION_EXPIRED', async () => {
    const session = await login(ana);
    await setSessionLastActivity(sidOf(session.accessToken), 31);

    const res = await searchClients(session.accessToken);

    expectProblem(res, 401, 'SESSION_EXPIRED');
    expect(res.body).not.toHaveProperty('items');
  });

  it('[US3-AC2] con 31 minutos sin actividad el refresh también da 401 SESSION_EXPIRED y borra la cookie', async () => {
    const session = await login(ana);
    await setSessionLastActivity(sidOf(session.accessToken), 31);

    const res = await refresh(session.refreshCookie);

    expectProblem(res, 401, 'SESSION_EXPIRED');
    expectClearedCookie(res);
    expect(res.body).not.toHaveProperty('accessToken');
    // The refresh does not revive the session: the old access token keeps failing.
    expectProblem(await searchClients(session.accessToken), 401, 'SESSION_EXPIRED');
  });

  it('[US3-AC2] contrato: refresh sin cookie o con una cookie desconocida → 401 SESSION_EXPIRED y borra la cookie', async () => {
    const withoutCookie = await server()
      .post('/api/v1/auth/refresh')
      .set('X-Requested-With', 'motorsync')
      .send();
    expectProblem(withoutCookie, 401, 'SESSION_EXPIRED');
    expectClearedCookie(withoutCookie);

    const unknown = await refresh(`${REFRESH_COOKIE_NAME}=${'A'.repeat(43)}`);
    expectProblem(unknown, 401, 'SESSION_EXPIRED');
    expectClearedCookie(unknown);
  });

  // ---------------------------------------------------------------- US3-AC3

  it('[US3-AC3] POST /auth/logout → 204 sin body, borra la cookie con Max-Age=0 y revoca la sesión con revoke_reason = logout', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);

    const res = await logout(session.refreshCookie);

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(res.text ?? '').toBe('');
    expectClearedCookie(res);
    const row = await sessionById(ana, sid);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe('logout');
  });

  // ---------------------------------------------------------------- US3-AC4

  it('[US3-AC4] después del logout el mismo token de acceso da 401 SESSION_REVOKED y el refresh con la cookie anterior también', async () => {
    const session = await login(ana);
    expect((await logout(session.refreshCookie)).status).toBe(204);

    expectProblem(await searchClients(session.accessToken), 401, 'SESSION_REVOKED');
    expectProblem(await me(session.accessToken), 401, 'SESSION_REVOKED');

    const res = await refresh(session.refreshCookie);
    expectProblem(res, 401, 'SESSION_REVOKED');
    expectClearedCookie(res);
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('[US3-AC4] reutilizar una cookie rotada hace 11 s → 401 SESSION_REVOKED y revoca la sesión entera (refresh_reuse)', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);
    const first = await refresh(session.refreshCookie);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const current = expectNewRefreshCookie(first);
    const currentAccess = (first.body as Json).accessToken as string;
    await setRefreshRotatedAt(tokenHashOf(session.refreshCookie), 11);

    const reuse = await refresh(session.refreshCookie);

    expectProblem(reuse, 401, 'SESSION_REVOKED');
    expectClearedCookie(reuse);
    const row = await sessionById(ana, sid);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe('refresh_reuse');
    // The whole family is dead: the current cookie and every access token of the session.
    expectProblem(await refresh(current), 401, 'SESSION_REVOKED');
    expectProblem(await searchClients(currentAccess), 401, 'SESSION_REVOKED');
    expectProblem(await searchClients(session.accessToken), 401, 'SESSION_REVOKED');
  });

  it('[US3-AC4] reutilizar una cookie rotada hace 5 s (ventana de 10 s) → 409 REFRESH_CONFLICT sin revocar', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);
    const first = await refresh(session.refreshCookie);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const current = expectNewRefreshCookie(first);
    await setRefreshRotatedAt(tokenHashOf(session.refreshCookie), 5);

    const conflict = await refresh(session.refreshCookie);

    expectProblem(conflict, 409, 'REFRESH_CONFLICT');
    expect(conflict.body).not.toHaveProperty('accessToken');
    // It must not clear the cookie the browser already replaced with the new one.
    const cleared = rawRefreshCookie(conflict);
    expect(cleared === undefined || !attributesOf(cleared).includes('max-age=0')).toBe(true);
    const row = await sessionById(ana, sid);
    expect(row.revokedAt).toBeNull();
    expect(row.revokeReason).toBeNull();
    // The client retries with the current cookie and it works.
    const retry = await refresh(current);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expectNewRefreshCookie(retry);
  });

  // ---------------------------------------------------------------- US3-AC5

  it('[US3-AC5] dos logins del mismo usuario: el logout de uno no afecta al otro', async () => {
    const tablet = await login(ana);
    const phone = await login(ana);
    const tabletSid = sidOf(tablet.accessToken);
    const phoneSid = sidOf(phone.accessToken);
    expect(tabletSid).not.toBe(phoneSid);

    expect((await logout(tablet.refreshCookie)).status).toBe(204);

    expectProblem(await searchClients(tablet.accessToken), 401, 'SESSION_REVOKED');
    const phoneSearch = await searchClients(phone.accessToken);
    expect(phoneSearch.status, JSON.stringify(phoneSearch.body)).toBe(200);
    const phoneRefresh = await refresh(phone.refreshCookie);
    expect(phoneRefresh.status, JSON.stringify(phoneRefresh.body)).toBe(200);

    expect((await sessionById(ana, tabletSid)).revokeReason).toBe('logout');
    const phoneRow = await sessionById(ana, phoneSid);
    expect(phoneRow.revokedAt).toBeNull();
    expect(phoneRow.revokeReason).toBeNull();
  });

  // ---------------------------------------------------------------- US3-AC6

  it('[US3-AC6] un segundo logout con la misma cookie → 204, borra la cookie y no cambia la revocación', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);
    expect((await logout(session.refreshCookie)).status).toBe(204);
    const before = await sessionById(ana, sid);

    const again = await logout(session.refreshCookie);

    expect(again.status, JSON.stringify(again.body)).toBe(204);
    expectClearedCookie(again);
    const after = await sessionById(ana, sid);
    expect(after.revokeReason).toBe('logout');
    expect(after.revokedAt?.getTime()).toBe(before.revokedAt?.getTime());
  });

  it('[US3-AC6] un logout sin cookie o con una cookie desconocida → 204 sin efectos', async () => {
    const session = await login(ana);

    const withoutCookie = await server()
      .post('/api/v1/auth/logout')
      .set('X-Requested-With', 'motorsync')
      .send();
    expect(withoutCookie.status, JSON.stringify(withoutCookie.body)).toBe(204);
    expectClearedCookie(withoutCookie);

    const unknown = await logout(`${REFRESH_COOKIE_NAME}=${'B'.repeat(43)}`);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(204);

    // The open session of Ana is untouched.
    const search = await searchClients(session.accessToken);
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect((await sessionById(ana, sidOf(session.accessToken))).revokedAt).toBeNull();
  });

  // ---------------------------------------------------------------- US3-AC7

  it('[US3-AC7] el logout de un usuario de A no cambia las sesiones de B', async () => {
    const sessionA = await login(ana);
    const sessionB = await login(marta);
    const before = await readUserSessions(marta.id);

    expect((await logout(sessionA.refreshCookie)).status).toBe(204);

    const after = await readUserSessions(marta.id);
    expect(after).toEqual(
      before.map((row) => expect.objectContaining({ id: row.id, revokedAt: null, revokeReason: null })),
    );
    const search = await searchClients(sessionB.accessToken);
    expect(search.status, JSON.stringify(search.body)).toBe(200);
  });

  it('[US3-AC7] una cookie de B solo refresca la sesión de B, aunque la petición lleve el token de A', async () => {
    const sessionA = await login(ana);
    const sessionB = await login(marta);
    const sidB = sidOf(sessionB.accessToken);

    const res = await server()
      .post('/api/v1/auth/refresh')
      .set(withRefreshCookie(sessionB.refreshCookie))
      .set(authHeader(sessionA.accessToken))
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      user: { id: marta.id, email: marta.email },
      workshop: { id: tenantB.id, name: tenantB.name },
    });
    expect(decodeJwtPayload((res.body as Json).accessToken as string)).toMatchObject({
      sub: marta.id,
      tenant_id: tenantB.id,
      sid: sidB,
    });
    // The session of A was not rotated nor revoked: its cookie still refreshes A.
    const refreshA = await refresh(sessionA.refreshCookie);
    expect(refreshA.status, JSON.stringify(refreshA.body)).toBe(200);
    expect(decodeJwtPayload((refreshA.body as Json).accessToken as string)).toMatchObject({
      sub: ana.id,
      tenant_id: tenantA.id,
    });
  });

  it('[US3-AC7] un logout con la cookie de B y el token de A cierra solo la sesión de B (la del refresh token)', async () => {
    const sessionA = await login(ana);
    const sessionB = await login(marta);

    const res = await server()
      .post('/api/v1/auth/logout')
      .set(withRefreshCookie(sessionB.refreshCookie))
      .set(authHeader(sessionA.accessToken))
      .send();

    expect(res.status).toBe(204);
    expect((await sessionById(marta, sidOf(sessionB.accessToken))).revokeReason).toBe('logout');
    expect((await sessionById(ana, sidOf(sessionA.accessToken))).revokedAt).toBeNull();
  });

  // ---------------------------------------------------------------- CSRF (research R11)

  it('[R11][US3-AC4] refresh sin X-Requested-With: motorsync → 400 VALIDATION_ERROR y no rota la cookie', async () => {
    const session = await login(ana);
    const sid = sidOf(session.accessToken);

    const withoutHeader = await server()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .send();
    expectProblem(withoutHeader, 400, 'VALIDATION_ERROR');
    expect(refreshCookieFrom(withoutHeader)).toBeUndefined();

    const otherValue = await server()
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send();
    expectProblem(otherValue, 400, 'VALIDATION_ERROR');

    // Nothing was rotated: the same cookie still works with the header.
    expect((await refreshTokens(tenantA.id, sid)).every((token) => token.rotated_at === null)).toBe(true);
    expect((await refresh(session.refreshCookie)).status).toBe(200);
  });

  it('[R11][US3-AC3] logout sin X-Requested-With: motorsync → 400 VALIDATION_ERROR y la sesión sigue abierta', async () => {
    const session = await login(ana);

    const res = await server()
      .post('/api/v1/auth/logout')
      .set('Cookie', session.refreshCookie)
      .send();

    expectProblem(res, 400, 'VALIDATION_ERROR');
    expect((await sessionById(ana, sidOf(session.accessToken))).revokedAt).toBeNull();
    expect((await searchClients(session.accessToken)).status).toBe(200);
  });

  // ---------------------------------------------------------------- GET /auth/me

  it('[US3-AC1] GET /auth/me devuelve user y workshop del taller propio, leídos de la base', async () => {
    const session = await login(ana);

    const res = await me(session.accessToken);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      user: {
        id: ana.id,
        name: ana.name,
        email: ana.email,
        role: 'asesor',
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      },
      workshop: { id: tenantA.id, name: tenantA.name },
    });
    expect(res.text.includes('scrypt$')).toBe(false);
    expect(res.text.includes(PASSWORD)).toBe(false);

    // Current data: a role change applies from the next request (FR-014).
    await updateUser(ana, { role: 'admin' });
    const after = await me(session.accessToken);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ user: { role: 'admin' } });
  });

  it('[US3-AC7] GET /auth/me con la sesión de B devuelve a B y su taller, nunca datos de A', async () => {
    const session = await login(marta);

    const res = await me(session.accessToken);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      user: { id: marta.id, email: marta.email },
      workshop: { id: tenantB.id, name: tenantB.name },
    });
    expect(res.text.includes(tenantA.id)).toBe(false);
    expect(res.text.includes(ana.email)).toBe(false);
  });

  it('[US3-AC4] GET /auth/me sin token → 401 UNAUTHORIZED', async () => {
    expectProblem(await server().get('/api/v1/auth/me'), 401, 'UNAUTHORIZED');
  });

  // ---------------------------------------------------------------- FR-013 / FR-019

  it('[FR-013][FR-019] con la cuenta desactivada por el migrator, el refresh da 401 SESSION_REVOKED y borra la cookie', async () => {
    const session = await login(ana);
    await updateUser(ana, { status: 'inactive' });

    const res = await refresh(session.refreshCookie);

    expectProblem(res, 401, 'SESSION_REVOKED');
    expectClearedCookie(res);
    expect(res.body).not.toHaveProperty('accessToken');
    expectProblem(await me(session.accessToken), 401, 'SESSION_REVOKED');
  });

  // ---------------------------------------------------------------- quickstart §5

  it('[R6] quickstart §5: registra en el log el p95 de 200 peticiones GET /auth/me (sin umbral)', async () => {
    const session = await login(ana);
    const durations: number[] = [];

    for (let index = 0; index < ME_SAMPLES; index += 1) {
      const started = performance.now();
      const res = await me(session.accessToken);
      durations.push(performance.now() - started);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    const p95 = percentile(durations, 95);
    console.log(
      `[R6] GET /auth/me: p50 ${percentile(durations, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (${ME_SAMPLES} peticiones)`,
    );
    expect(Number.isFinite(p95)).toBe(true);
  }, 60_000);
});
