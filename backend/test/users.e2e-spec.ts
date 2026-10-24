// T053 (specs/002-autenticacion): e2e of team user accounts management (US4-AC1 to US4-AC11,
// US4-AC15, US4-AC16, US4-AC19, US4-AC21 to US4-AC23, FR-020, and edge cases) over the full app
// wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract (contracts/openapi.yaml):
// - GET /api/v1/users (admin only) -> 200 { items: UserAccount[] }
// - POST /api/v1/users (admin only) -> 201 UserAccount
// - GET /api/v1/users/{userId} (admin only) -> 200 UserAccount
// - PUT /api/v1/users/{userId}/role (admin only) -> 200 UserAccount
// - POST /api/v1/users/{userId}/deactivate (admin only) -> 200 UserAccount
// - POST /api/v1/users/{userId}/reactivate (admin only) -> 200 UserAccount
// - POST /api/v1/users/{userId}/password-reset (admin only) -> 200 UserAccount
// - GET /api/v1/users/{userId}/history (admin only) -> 200 { items: UserAuditEntry[] }
// - DELETE /api/v1/users/{userId} -> 404 NOT_FOUND (FR-017)
import { randomUUID } from 'node:crypto';
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
  createTenant,
  createUser,
  readAuditLog,
  setLockedUntil,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
  type UserRole,
} from './setup/db-fixtures.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PASSWORD = 'Clave-Segura-123';
const NEW_TEMP_PASSWORD = 'Temp-Password-456';
const ANOTHER_TEMP_PASSWORD = 'Temp-Password-789';
const NEW_PERMANENT_PASSWORD = 'Nueva-Clave-Final-999';

interface FieldErrorBody {
  field: string;
  code: string;
  message?: string;
}

interface UserAccountResponse {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'active' | 'inactive';
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

describe('Users management (e2e, T053, US4)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let adminA: UserFixture;
  let adminPedroA: UserFixture;
  let asesorA: UserFixture;
  let adminB: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  function expectNoPassword(
    res: Response,
    ...passwords: (string | undefined)[]
  ): void {
    const text = res.text ?? '';
    for (const pwd of passwords) {
      if (pwd) {
        expect(
          text.includes(pwd),
          `Response text contains raw password: "${pwd}"`,
        ).toBe(false);
      }
    }
    expect(
      text.includes('scrypt$'),
      'Response text contains a scrypt password hash',
    ).toBe(false);
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(
      res.status,
      `Expected status ${status}, got ${res.status}: ${JSON.stringify(res.body)}`,
    ).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function fieldErrors(body: unknown): FieldErrorBody[] {
    const errors = (body as { errors?: unknown })?.errors;
    return Array.isArray(errors) ? (errors as FieldErrorBody[]) : [];
  }

  function expectValidationError(
    res: Response,
    field: string,
    code: string,
  ): void {
    expectProblem(res, 400, 'VALIDATION_ERROR');
    expect(fieldErrors(res.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
  }

  function expectValidUserAccount(item: unknown): UserAccountResponse {
    const account = item as UserAccountResponse;
    expect(account).toBeDefined();
    expect(account.id).toMatch(UUID_RE);
    expect(typeof account.name).toBe('string');
    expect(account.name.length).toBeGreaterThan(0);
    expect(typeof account.email).toBe('string');
    expect(account.email).toContain('@');
    expect(['admin', 'asesor']).toContain(account.role);
    expect(['active', 'inactive']).toContain(account.status);
    expect(typeof account.mustChangePassword).toBe('boolean');
    if (account.temporaryPasswordExpiresAt !== null) {
      expect(account.temporaryPasswordExpiresAt).toMatch(ISO_DATE_RE);
    }
    expect(account.createdAt).toMatch(ISO_DATE_RE);
    expect(account.updatedAt).toMatch(ISO_DATE_RE);
    expect(typeof account.updatedByName).toBe('string');
    expect(account.updatedByName.length).toBeGreaterThan(0);
    return account;
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
  });

  afterAll(async () => {
    await app?.close();
    if (migratorPool) {
      await migratorPool.end();
    }
    await closeFixtures();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A users e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B users e2e ${randomUUID()}`);

    adminA = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: uniqueEmail('ana'),
      role: 'admin',
      password: PASSWORD,
    });

    adminPedroA = await createUser({
      tenantId: tenantA.id,
      name: 'Pedro Gómez',
      email: uniqueEmail('pedro'),
      role: 'admin',
      password: PASSWORD,
    });

    asesorA = await createUser({
      tenantId: tenantA.id,
      name: 'Luis Asesor',
      email: uniqueEmail('luis'),
      role: 'asesor',
      password: PASSWORD,
    });

    adminB = await createUser({
      tenantId: tenantB.id,
      name: 'Beatriz Admin',
      email: uniqueEmail('beatriz'),
      role: 'admin',
      password: PASSWORD,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC1: List users of the workshop
  // ---------------------------------------------------------------------------------------------
  it('US4-AC1: GET /api/v1/users lists active and inactive accounts of workshop, without password or passwordHash', async () => {
    // Add an inactive user to tenant A
    const inactiveUser = await createUser({
      tenantId: tenantA.id,
      name: 'María Inactiva',
      email: uniqueEmail('maria'),
      role: 'asesor',
      status: 'inactive',
      password: PASSWORD,
    });

    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);
    const res = await server()
      .get('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken));

    expect(res.status).toBe(200);
    expectNoPassword(res, PASSWORD);

    const body = res.body as { items: UserAccountResponse[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(4); // adminA, adminPedroA, asesorA, inactiveUser

    for (const item of body.items) {
      expectValidUserAccount(item);
    }

    const ids = body.items.map((u) => u.id);
    expect(ids).toContain(adminA.id);
    expect(ids).toContain(adminPedroA.id);
    expect(ids).toContain(asesorA.id);
    expect(ids).toContain(inactiveUser.id);
    expect(ids).not.toContain(adminB.id);

    const foundInactive = body.items.find((u) => u.id === inactiveUser.id);
    expect(foundInactive?.status).toBe('inactive');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC2: Create user with temporary password
  // ---------------------------------------------------------------------------------------------
  it('US4-AC2: POST /api/v1/users returns 201 with mustChangePassword=true, tempPasswordExpiresAt approx now+72h; person can login with temp password', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);
    const newEmail = uniqueEmail('carlos');
    const tempPassword = 'TempPassword-123';

    const res = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Carlos Ruiz',
        email: newEmail,
        role: 'asesor',
        temporaryPassword: tempPassword,
      });

    expect(res.status).toBe(201);
    expectNoPassword(res, tempPassword);

    const created = expectValidUserAccount(res.body);
    expect(created.name).toBe('Carlos Ruiz');
    expect(created.email).toBe(newEmail);
    expect(created.role).toBe('asesor');
    expect(created.status).toBe('active');
    expect(created.mustChangePassword).toBe(true);
    expect(created.updatedByName).toBe(adminA.name);

    expect(created.temporaryPasswordExpiresAt).toBeDefined();
    const expiryMs = new Date(
      created.temporaryPasswordExpiresAt as string,
    ).getTime();
    const nowMs = Date.now();
    const diffHours = (expiryMs - nowMs) / (3600 * 1000);
    expect(diffHours).toBeGreaterThanOrEqual(71);
    expect(diffHours).toBeLessThanOrEqual(73);

    // Person can login with temporary password
    const loginNew = await loginAs(app, newEmail, tempPassword);
    expect(loginNew.body.user).toMatchObject({
      email: newEmail,
      mustChangePassword: true,
    });
    const payload = decodeJwtPayload(loginNew.accessToken);
    expect(payload.pwd_change).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC3: Duplicate email rejection
  // ---------------------------------------------------------------------------------------------
  it('US4-AC3: POST /api/v1/users with duplicate email (in workshop A or B) -> 409 EMAIL_UNAVAILABLE without revealing existing account', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Duplicate within workshop A, with surrounding spaces and mixed casing
    const resSameWorkshop = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Ana Clon',
        email: `  ${adminA.email.toUpperCase()}  `,
        role: 'asesor',
        temporaryPassword: 'TempPassword-123',
      });

    expectProblem(resSameWorkshop, 409, 'EMAIL_UNAVAILABLE');
    expect(resSameWorkshop.text.includes(adminA.id)).toBe(false);

    // Duplicate from workshop B
    const resOtherWorkshop = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Beatriz Copia',
        email: adminB.email,
        role: 'asesor',
        temporaryPassword: 'TempPassword-123',
      });

    expectProblem(resOtherWorkshop, 409, 'EMAIL_UNAVAILABLE');
    expect(resOtherWorkshop.text.includes(tenantB.id)).toBe(false);
    expect(resOtherWorkshop.text.includes(adminB.id)).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC4: Validation errors
  // ---------------------------------------------------------------------------------------------
  it('US4-AC4: Validation errors (REQUIRED, INVALID_EMAIL, PASSWORD_TOO_SHORT, role "tecnico") -> 400', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Missing all required fields
    const resEmpty = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({});

    expectProblem(resEmpty, 400, 'VALIDATION_ERROR');
    expectValidationError(resEmpty, 'name', 'REQUIRED');
    expectValidationError(resEmpty, 'email', 'REQUIRED');
    expectValidationError(resEmpty, 'role', 'REQUIRED');
    expectValidationError(resEmpty, 'temporaryPassword', 'REQUIRED');

    // Invalid email format
    const resInvalidEmail = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Nombre Válido',
        email: 'correo-sin-arroba',
        role: 'asesor',
        temporaryPassword: 'Password-Valido-123',
      });

    expectValidationError(resInvalidEmail, 'email', 'INVALID_EMAIL');

    // Temporary password too short (< 8 chars)
    const resShortPassword = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Nombre Válido',
        email: uniqueEmail('shortpwd'),
        role: 'asesor',
        temporaryPassword: 'short',
      });

    expectValidationError(
      resShortPassword,
      'temporaryPassword',
      'PASSWORD_TOO_SHORT',
    );

    // Invalid role ('tecnico' is not supported)
    const resInvalidRole = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Nombre Válido',
        email: uniqueEmail('tecnico'),
        role: 'tecnico',
        temporaryPassword: 'Password-Valido-123',
      });

    expectProblem(resInvalidRole, 400, 'VALIDATION_ERROR');
    const errors = fieldErrors(resInvalidRole.body);
    expect(errors.some((e) => e.field === 'role')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC5: Role change effective immediately without re-login
  // ---------------------------------------------------------------------------------------------
  it('US4-AC5: PUT /api/v1/users/:id/role: changing Luis from asesor to admin -> on his next request he can access GET /users without re-login. Changing admin to asesor -> on next request gets 403', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);
    const loginLuis = await loginAs(app, asesorA.email, PASSWORD);

    // Luis is asesor: calling GET /users gives 403 FORBIDDEN
    const resLuisBefore = await server()
      .get('/api/v1/users')
      .set(authHeader(loginLuis.accessToken));
    expectProblem(resLuisBefore, 403, 'FORBIDDEN');

    // Admin promotes Luis to admin
    const resPromote = await server()
      .put(`/api/v1/users/${asesorA.id}/role`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ role: 'admin' });
    expect(resPromote.status).toBe(200);
    expect((resPromote.body as UserAccountResponse).role).toBe('admin');

    // Luis, using the EXACT SAME access token without re-login, now succeeds
    const resLuisAfterPromote = await server()
      .get('/api/v1/users')
      .set(authHeader(loginLuis.accessToken));
    expect(resLuisAfterPromote.status).toBe(200);

    // Admin demotes Luis back to asesor
    const resDemote = await server()
      .put(`/api/v1/users/${asesorA.id}/role`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ role: 'asesor' });
    expect(resDemote.status).toBe(200);
    expect((resDemote.body as UserAccountResponse).role).toBe('asesor');

    // Luis, using the same token, now gets 403 FORBIDDEN
    const resLuisAfterDemote = await server()
      .get('/api/v1/users')
      .set(authHeader(loginLuis.accessToken));
    expectProblem(resLuisAfterDemote, 403, 'FORBIDDEN');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC6: Deactivate closes all sessions and blocks login
  // ---------------------------------------------------------------------------------------------
  it('US4-AC6: Luis has 2 sessions; after POST /users/:id/deactivate, both sessions give 401 SESSION_REVOKED and login gives 401 INVALID_CREDENTIALS', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis opens 2 sessions
    const session1 = await loginAs(app, asesorA.email, PASSWORD);
    const session2 = await loginAs(app, asesorA.email, PASSWORD);

    // Both sessions work initially
    const me1 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session1.accessToken));
    expect(me1.status).toBe(200);
    const me2 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session2.accessToken));
    expect(me2.status).toBe(200);

    // Admin deactivates Luis
    const resDeactivate = await server()
      .post(`/api/v1/users/${asesorA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resDeactivate.status).toBe(200);
    expect((resDeactivate.body as UserAccountResponse).status).toBe('inactive');

    // Both sessions are revoked on their next request
    const req1After = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session1.accessToken));
    expectProblem(req1After, 401, 'SESSION_REVOKED');

    const req2After = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session2.accessToken));
    expectProblem(req2After, 401, 'SESSION_REVOKED');

    // Subsequent login attempt gives INVALID_CREDENTIALS
    const resLogin = await server()
      .post('/api/v1/auth/login')
      .send({ email: asesorA.email, password: PASSWORD });
    expectProblem(resLogin, 401, 'INVALID_CREDENTIALS');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC7: Reactivate user
  // ---------------------------------------------------------------------------------------------
  it('US4-AC7: POST /users/:id/reactivate: keeps role, login with password works (200), previously revoked tokens still 401', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Deactivate Luis first
    const sessionLuis = await loginAs(app, asesorA.email, PASSWORD);
    await server()
      .post(`/api/v1/users/${asesorA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));

    // Admin reactivates Luis
    const resReactivate = await server()
      .post(`/api/v1/users/${asesorA.id}/reactivate`)
      .set(authHeader(loginAdmin.accessToken));

    expect(resReactivate.status).toBe(200);
    const account = expectValidUserAccount(resReactivate.body);
    expect(account.status).toBe('active');
    expect(account.role).toBe('asesor');

    // Previously revoked token still gives 401 SESSION_REVOKED
    const resOldToken = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(sessionLuis.accessToken));
    expectProblem(resOldToken, 401, 'SESSION_REVOKED');

    // Login with regular password succeeds
    const newLogin = await loginAs(app, asesorA.email, PASSWORD);
    expect(newLogin.accessToken).toBeDefined();
    expect(newLogin.body.user).toMatchObject({
      email: asesorA.email,
      role: 'asesor',
    });
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC8: DELETE /api/v1/users/:id returns 404 without changes
  // ---------------------------------------------------------------------------------------------
  it('US4-AC8: DELETE /api/v1/users/:id returns 404 without changes', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    const resDelete = await server()
      .delete(`/api/v1/users/${asesorA.id}`)
      .set(authHeader(loginAdmin.accessToken));

    expectProblem(resDelete, 404, 'NOT_FOUND');

    // User is still present and intact
    const resGet = await server()
      .get(`/api/v1/users/${asesorA.id}`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resGet.status).toBe(200);
    expect((resGet.body as UserAccountResponse).id).toBe(asesorA.id);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC9: Sole active admin cannot be demoted or deactivated
  // ---------------------------------------------------------------------------------------------
  it('US4-AC9: Only admin cannot change own role to asesor or deactivate self -> 409 LAST_ADMIN', async () => {
    // Demote Pedro first so Ana is the sole active admin
    const loginAna = await loginAs(app, adminA.email, PASSWORD);
    await server()
      .put(`/api/v1/users/${adminPedroA.id}/role`)
      .set(authHeader(loginAna.accessToken))
      .send({ role: 'asesor' });

    // Ana attempts to demote herself
    const resDemoteSelf = await server()
      .put(`/api/v1/users/${adminA.id}/role`)
      .set(authHeader(loginAna.accessToken))
      .send({ role: 'asesor' });
    expectProblem(resDemoteSelf, 409, 'LAST_ADMIN');

    // Ana attempts to deactivate herself
    const resDeactivateSelf = await server()
      .post(`/api/v1/users/${adminA.id}/deactivate`)
      .set(authHeader(loginAna.accessToken));
    expectProblem(resDeactivateSelf, 409, 'LAST_ADMIN');

    // Ana remains active admin
    const resAnaCheck = await server()
      .get(`/api/v1/users/${adminA.id}`)
      .set(authHeader(loginAna.accessToken));
    expect(resAnaCheck.status).toBe(200);
    expect((resAnaCheck.body as UserAccountResponse).role).toBe('admin');
    expect((resAnaCheck.body as UserAccountResponse).status).toBe('active');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC10: Concurrent deactivation preserves at least one admin
  // ---------------------------------------------------------------------------------------------
  it('US4-AC10: Two admins attempting to deactivate each other simultaneously (Promise.all) -> at most one succeeds, workshop keeps >=1 active admin', async () => {
    const loginAna = await loginAs(app, adminA.email, PASSWORD);
    const loginPedro = await loginAs(app, adminPedroA.email, PASSWORD);

    // Concurrently try to deactivate each other
    const [resAnaDeactivatingPedro, resPedroDeactivatingAna] =
      await Promise.all([
        server()
          .post(`/api/v1/users/${adminPedroA.id}/deactivate`)
          .set(authHeader(loginAna.accessToken)),
        server()
          .post(`/api/v1/users/${adminA.id}/deactivate`)
          .set(authHeader(loginPedro.accessToken)),
      ]);

    const statuses = [
      resAnaDeactivatingPedro.status,
      resPedroDeactivatingAna.status,
    ];
    const successes = statuses.filter((s) => s === 200).length;
    const failures = statuses.filter((s) => s === 409 || s === 401).length;

    expect(successes).toBeLessThanOrEqual(1);
    expect(failures).toBeGreaterThanOrEqual(1);

    // Check that at least one admin is still active in the database
    const survivingToken =
      resAnaDeactivatingPedro.status === 200
        ? loginAna.accessToken
        : loginPedro.accessToken;
    const resList = await server()
      .get('/api/v1/users')
      .set(authHeader(survivingToken));
    expect(resList.status).toBe(200);

    const activeAdmins = (
      resList.body as { items: UserAccountResponse[] }
    ).items.filter((u) => u.role === 'admin' && u.status === 'active');
    expect(activeAdmins.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC11: Self-demotion permitted when another active admin exists
  // ---------------------------------------------------------------------------------------------
  it('US4-AC11: Two admins exist (Ana, Pedro); Ana removes own admin role -> 200; next request from Ana gets 403', async () => {
    const loginAna = await loginAs(app, adminA.email, PASSWORD);

    // Ana demotes herself to asesor
    const resDemote = await server()
      .put(`/api/v1/users/${adminA.id}/role`)
      .set(authHeader(loginAna.accessToken))
      .send({ role: 'asesor' });

    expect(resDemote.status).toBe(200);
    expect((resDemote.body as UserAccountResponse).role).toBe('asesor');

    // On Ana's very next request to admin routes, she gets 403 FORBIDDEN
    const resNextReq = await server()
      .get('/api/v1/users')
      .set(authHeader(loginAna.accessToken));

    expectProblem(resNextReq, 403, 'FORBIDDEN');
  });

  it('[US4-AC11][US4-AC6] con dos administradores, Ana se desactiva a sí misma -> 200; su sesión da 401 SESSION_REVOKED en la petición siguiente; se audita user.deactivated con actor y entidad Ana y sessionsClosed >= 1; Pedro sigue como administrador activo', async () => {
    const loginAna = await loginAs(app, adminA.email, PASSWORD);

    const resDeactivate = await server()
      .post(`/api/v1/users/${adminA.id}/deactivate`)
      .set(authHeader(loginAna.accessToken));
    expect(
      resDeactivate.status,
      `Expected 200, got ${resDeactivate.status}: ${JSON.stringify(resDeactivate.body)}`,
    ).toBe(200);
    expect((resDeactivate.body as UserAccountResponse).status).toBe('inactive');

    // US4-AC6: her sessions are closed, starting with the one she used.
    const resNext = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(loginAna.accessToken));
    expectProblem(resNext, 401, 'SESSION_REVOKED');

    // Audited like any other deactivation.
    const deactivations = (await readAuditLog(tenantA.id, adminA.id)).filter(
      (row) => row.action === 'user.deactivated',
    );
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0].actorUserId).toBe(adminA.id);
    expect(deactivations[0].entityType).toBe('user');
    expect(deactivations[0].entityId).toBe(adminA.id);
    expect(Number(deactivations[0].after?.sessionsClosed)).toBeGreaterThanOrEqual(1);

    // Pedro remains an active admin and can still manage users.
    const loginPedro = await loginAs(app, adminPedroA.email, PASSWORD);
    const resPedro = await server()
      .get(`/api/v1/users/${adminPedroA.id}`)
      .set(authHeader(loginPedro.accessToken));
    expect(resPedro.status).toBe(200);
    expect((resPedro.body as UserAccountResponse).role).toBe('admin');
    expect((resPedro.body as UserAccountResponse).status).toBe('active');
  });

  it('[US4-AC11] Ana se quita a sí misma el rol de administrador -> se audita exactamente un user.role_changed con actor y entidad Ana', async () => {
    const loginAna = await loginAs(app, adminA.email, PASSWORD);

    const resDemote = await server()
      .put(`/api/v1/users/${adminA.id}/role`)
      .set(authHeader(loginAna.accessToken))
      .send({ role: 'asesor' });
    expect(resDemote.status).toBe(200);

    const roleChanges = (await readAuditLog(tenantA.id, adminA.id)).filter(
      (row) => row.action === 'user.role_changed',
    );
    expect(roleChanges).toHaveLength(1);
    expect(roleChanges[0].actorUserId).toBe(adminA.id);
    expect(roleChanges[0].entityId).toBe(adminA.id);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC15: Idempotent / no-change operations return 200 without updatedAt modification
  // ---------------------------------------------------------------------------------------------
  it('US4-AC15: Setting same role or deactivating already inactive account -> 200 without changes in updatedAt', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis is currently asesor: setting role to 'asesor' again
    const resInitialUser = await server()
      .get(`/api/v1/users/${asesorA.id}`)
      .set(authHeader(loginAdmin.accessToken));
    const initialUpdatedAt = (resInitialUser.body as UserAccountResponse)
      .updatedAt;

    const resSameRole = await server()
      .put(`/api/v1/users/${asesorA.id}/role`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ role: 'asesor' });

    expect(resSameRole.status).toBe(200);
    expect((resSameRole.body as UserAccountResponse).updatedAt).toBe(
      initialUpdatedAt,
    );

    // Deactivate Luis
    const resDeactivate1 = await server()
      .post(`/api/v1/users/${asesorA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resDeactivate1.status).toBe(200);
    const deactivatedUpdatedAt = (resDeactivate1.body as UserAccountResponse)
      .updatedAt;

    // Deactivate already inactive Luis again
    const resDeactivate2 = await server()
      .post(`/api/v1/users/${asesorA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));

    expect(resDeactivate2.status).toBe(200);
    expect((resDeactivate2.body as UserAccountResponse).updatedAt).toBe(
      deactivatedUpdatedAt,
    );
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC16: Asesor forbidden on all 8 /users endpoints
  // ---------------------------------------------------------------------------------------------
  it('US4-AC16: Asesor gets 403 FORBIDDEN on all 8 /users endpoints', async () => {
    const loginAsesor = await loginAs(app, asesorA.email, PASSWORD);
    const token = loginAsesor.accessToken;

    const endpoints = [
      () => server().get('/api/v1/users').set(authHeader(token)),
      () =>
        server()
          .post('/api/v1/users')
          .set(authHeader(token))
          .send({
            name: 'X',
            email: uniqueEmail('x'),
            role: 'asesor',
            temporaryPassword: 'TempPassword-123',
          }),
      () => server().get(`/api/v1/users/${asesorA.id}`).set(authHeader(token)),
      () =>
        server()
          .put(`/api/v1/users/${asesorA.id}/role`)
          .set(authHeader(token))
          .send({ role: 'admin' }),
      () =>
        server()
          .post(`/api/v1/users/${asesorA.id}/deactivate`)
          .set(authHeader(token)),
      () =>
        server()
          .post(`/api/v1/users/${asesorA.id}/reactivate`)
          .set(authHeader(token)),
      () =>
        server()
          .post(`/api/v1/users/${asesorA.id}/password-reset`)
          .set(authHeader(token))
          .send({ temporaryPassword: 'TempPassword-123' }),
      () =>
        server()
          .get(`/api/v1/users/${asesorA.id}/history`)
          .set(authHeader(token)),
    ];

    for (const call of endpoints) {
      const res = await call();
      expectProblem(res, 403, 'FORBIDDEN');
    }
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC19: Disallow tenantId in POST /users body
  // ---------------------------------------------------------------------------------------------
  it('US4-AC19: Body with tenantId in POST /users -> 400 UNKNOWN_FIELD', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    const res = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Carlos Ruiz',
        email: uniqueEmail('carlos'),
        role: 'asesor',
        temporaryPassword: 'TempPassword-123',
        tenantId: tenantB.id,
      });

    expectValidationError(res, 'tenantId', 'UNKNOWN_FIELD');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC21: Password reset clears lock, revokes sessions, sets mustChangePassword
  // ---------------------------------------------------------------------------------------------
  it('US4-AC21: POST /users/:id/password-reset: old password gives INVALID_CREDENTIALS, 2 active sessions get SESSION_REVOKED; login with new temp password succeeds; if account had locked_until set, the lock is cleared', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis has 2 active sessions
    const session1 = await loginAs(app, asesorA.email, PASSWORD);
    const session2 = await loginAs(app, asesorA.email, PASSWORD);

    // Simulate account locked by 5 failed login attempts
    await setLockedUntil(asesorA.email, 15);

    // Attempting login now returns 429 ACCOUNT_LOCKED
    const resLocked = await server()
      .post('/api/v1/auth/login')
      .send({ email: asesorA.email, password: PASSWORD });
    expectProblem(resLocked, 429, 'ACCOUNT_LOCKED');

    // Admin resets Luis's password
    const resReset = await server()
      .post(`/api/v1/users/${asesorA.id}/password-reset`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ temporaryPassword: NEW_TEMP_PASSWORD });

    expect(resReset.status).toBe(200);
    expectNoPassword(resReset, NEW_TEMP_PASSWORD, PASSWORD);

    const resetUser = expectValidUserAccount(resReset.body);
    expect(resetUser.mustChangePassword).toBe(true);
    expect(resetUser.temporaryPasswordExpiresAt).toBeDefined();

    // Old password gives 401 INVALID_CREDENTIALS
    const resOldLogin = await server()
      .post('/api/v1/auth/login')
      .send({ email: asesorA.email, password: PASSWORD });
    expectProblem(resOldLogin, 401, 'INVALID_CREDENTIALS');

    // Previous sessions are revoked
    const resSession1 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session1.accessToken));
    expectProblem(resSession1, 401, 'SESSION_REVOKED');

    const resSession2 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(session2.accessToken));
    expectProblem(resSession2, 401, 'SESSION_REVOKED');

    // Login with new temp password succeeds immediately (the lock was cleared)
    const resNewLogin = await loginAs(app, asesorA.email, NEW_TEMP_PASSWORD);
    expect(resNewLogin.accessToken).toBeDefined();
    expect(resNewLogin.body.user).toMatchObject({
      email: asesorA.email,
      mustChangePassword: true,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC22: Reset password on inactive user keeps user inactive
  // ---------------------------------------------------------------------------------------------
  it('US4-AC22: Reset password on inactive user -> user stays inactive, cannot login', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Deactivate Luis
    await server()
      .post(`/api/v1/users/${asesorA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));

    // Reset password of deactivated user
    const resReset = await server()
      .post(`/api/v1/users/${asesorA.id}/password-reset`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ temporaryPassword: ANOTHER_TEMP_PASSWORD });

    expect(resReset.status).toBe(200);
    const account = expectValidUserAccount(resReset.body);
    expect(account.status).toBe('inactive');
    expect(account.mustChangePassword).toBe(true);

    // Login attempt still gives 401 INVALID_CREDENTIALS
    const resLogin = await server()
      .post('/api/v1/auth/login')
      .send({ email: asesorA.email, password: ANOTHER_TEMP_PASSWORD });
    expectProblem(resLogin, 401, 'INVALID_CREDENTIALS');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC23: Admin cannot reset own password via user management
  // ---------------------------------------------------------------------------------------------
  it('US4-AC23: Reset own password -> 409 SELF_RESET_NOT_ALLOWED', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    const res = await server()
      .post(`/api/v1/users/${adminA.id}/password-reset`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ temporaryPassword: NEW_TEMP_PASSWORD });

    expectProblem(res, 409, 'SELF_RESET_NOT_ALLOWED');

    // Ana's session is still valid
    const resMe = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(loginAdmin.accessToken));
    expect(resMe.status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // FR-020: who created the account, who modified it last and when (UTC)
  // ---------------------------------------------------------------------------------------------
  it("[FR-020] tras crear, cambiar el rol, desactivar, reactivar y restablecer, updatedAt es estrictamente posterior al anterior y updatedBy y updatedByName son del administrador que actuó", async () => {
    const loginAna = await loginAs(app, adminA.email, PASSWORD);
    const loginPedro = await loginAs(app, adminPedroA.email, PASSWORD);

    interface AccountMetadata {
      createdBy: string;
      updatedBy: string;
      updatedByName: string;
      updatedAt: Date;
    }

    async function readMetadata(userId: string): Promise<AccountMetadata> {
      const client = await migratorPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantA.id,
        ]);
        const result = await client.query<AccountMetadata>(
          `SELECT created_by AS "createdBy", updated_by AS "updatedBy",
                  updated_by_name AS "updatedByName", updated_at AS "updatedAt"
             FROM users WHERE id = $1`,
          [userId],
        );
        await client.query('COMMIT');
        return result.rows[0];
      } finally {
        client.release();
      }
    }

    /** Response and stored metadata of one operation, both pointing at `actor`. */
    async function expectActor(
      res: Response,
      expectedStatus: number,
      actor: UserFixture,
      previousUpdatedAt: number | undefined,
    ): Promise<UserAccountResponse> {
      expect(
        res.status,
        `Expected ${expectedStatus}, got ${res.status}: ${JSON.stringify(res.body)}`,
      ).toBe(expectedStatus);
      const account = expectValidUserAccount(res.body);
      expect(account.updatedByName).toBe(actor.name);
      const updatedAt = new Date(account.updatedAt).getTime();
      if (previousUpdatedAt !== undefined) {
        expect(updatedAt).toBeGreaterThan(previousUpdatedAt);
      }

      const stored = await readMetadata(account.id);
      expect(stored.updatedBy).toBe(actor.id);
      expect(stored.updatedByName).toBe(actor.name);
      expect(stored.updatedAt.toISOString()).toBe(account.updatedAt);
      return account;
    }

    // 1. Ana creates the account: created_by and updated_by are Ana.
    const created = await expectActor(
      await server()
        .post('/api/v1/users')
        .set(authHeader(loginAna.accessToken))
        .send({
          name: 'Roberto Gómez',
          email: uniqueEmail('roberto'),
          role: 'asesor',
          temporaryPassword: 'TempPassword-123',
        }),
      201,
      adminA,
      undefined,
    );
    expect((await readMetadata(created.id)).createdBy).toBe(adminA.id);

    // 2. Pedro changes the role.
    const afterRole = await expectActor(
      await server()
        .put(`/api/v1/users/${created.id}/role`)
        .set(authHeader(loginPedro.accessToken))
        .send({ role: 'admin' }),
      200,
      adminPedroA,
      new Date(created.updatedAt).getTime(),
    );

    // 3. Ana deactivates.
    const afterDeactivate = await expectActor(
      await server()
        .post(`/api/v1/users/${created.id}/deactivate`)
        .set(authHeader(loginAna.accessToken)),
      200,
      adminA,
      new Date(afterRole.updatedAt).getTime(),
    );

    // 4. Pedro reactivates.
    const afterReactivate = await expectActor(
      await server()
        .post(`/api/v1/users/${created.id}/reactivate`)
        .set(authHeader(loginPedro.accessToken)),
      200,
      adminPedroA,
      new Date(afterDeactivate.updatedAt).getTime(),
    );

    // 5. Ana resets the password.
    await expectActor(
      await server()
        .post(`/api/v1/users/${created.id}/password-reset`)
        .set(authHeader(loginAna.accessToken))
        .send({ temporaryPassword: NEW_TEMP_PASSWORD }),
      200,
      adminA,
      new Date(afterReactivate.updatedAt).getTime(),
    );

    // The creator never changes.
    expect((await readMetadata(created.id)).createdBy).toBe(adminA.id);
  });

  // ---------------------------------------------------------------------------------------------
  // Edge Case US5-AC1: Temporary password cannot access general endpoints
  // ---------------------------------------------------------------------------------------------
  it('US5-AC1 edge case: With temp password, GET /api/v1/users gives 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Create an admin with a temporary password
    const newAdminEmail = uniqueEmail('tempadmin');
    const resCreate = await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Admin Temporal',
        email: newAdminEmail,
        role: 'admin',
        temporaryPassword: NEW_TEMP_PASSWORD,
      });
    expect(resCreate.status).toBe(201);

    // Admin Temporal logs in with temp password
    const loginTemp = await loginAs(app, newAdminEmail, NEW_TEMP_PASSWORD);
    expect(loginTemp.body.user).toMatchObject({ mustChangePassword: true });

    // Attempting GET /users returns 403 PASSWORD_CHANGE_REQUIRED
    const resUsers = await server()
      .get('/api/v1/users')
      .set(authHeader(loginTemp.accessToken));

    expectProblem(resUsers, 403, 'PASSWORD_CHANGE_REQUIRED');
  });

  // ---------------------------------------------------------------------------------------------
  // Edge Case: Password reset while user is changing password
  // ---------------------------------------------------------------------------------------------
  it('Edge case: Reset while user is changing password -> old session gets SESSION_REVOKED; login with new temp password succeeds', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis has temporary password T1, logs in
    const emailLuis = uniqueEmail('luistemp');
    const tempP1 = 'TempPassword-111';
    const tempP2 = 'TempPassword-222';

    await server()
      .post('/api/v1/users')
      .set(authHeader(loginAdmin.accessToken))
      .send({
        name: 'Luis Temporal',
        email: emailLuis,
        role: 'asesor',
        temporaryPassword: tempP1,
      });

    const sessionLuisOld = await loginAs(app, emailLuis, tempP1);
    const userId = (sessionLuisOld.body.user as { id: string }).id;

    // Admin resets Luis's password with T2 while Luis has sessionLuisOld open
    const resReset = await server()
      .post(`/api/v1/users/${userId}/password-reset`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ temporaryPassword: tempP2 });
    expect(resReset.status).toBe(200);

    // Luis tries POST /auth/password in his old session with tempP1 -> 401 SESSION_REVOKED
    const resChangeOld = await server()
      .post('/api/v1/auth/password')
      .set(authHeader(sessionLuisOld.accessToken))
      .send({
        currentPassword: tempP1,
        newPassword: NEW_PERMANENT_PASSWORD,
      });
    expectProblem(resChangeOld, 401, 'SESSION_REVOKED');

    // Luis logs in with tempP2 -> 200 SessionResponse
    const sessionLuisNew = await loginAs(app, emailLuis, tempP2);
    expect(sessionLuisNew.body.user).toMatchObject({
      mustChangePassword: true,
    });

    // Luis changes password successfully with tempP2
    const resChangeNew = await server()
      .post('/api/v1/auth/password')
      .set(authHeader(sessionLuisNew.accessToken))
      .send({
        currentPassword: tempP2,
        newPassword: NEW_PERMANENT_PASSWORD,
      });
    expect(resChangeNew.status).toBe(200);
    expect(
      (resChangeNew.body as { user: { mustChangePassword: boolean } }).user
        .mustChangePassword,
    ).toBe(false);
  });
});
