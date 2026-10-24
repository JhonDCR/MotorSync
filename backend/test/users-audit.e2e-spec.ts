// T054 (specs/002-autenticacion): e2e of user accounts audit log and multi-tenant isolation
// (US4-AC12 to US4-AC15, US4-AC17, US4-AC18, US4-AC20, US4-AC24) over the full app wiring
// (AppModule + configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Audit verification: audit_log is checked via readAuditLog() and direct migrator tenant queries.
// Multi-tenant isolation: tests cross-tenant reading and writing between workshop A and workshop B.
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
  createTenant,
  createUser,
  readAuditLog,
  readUserSessions,
  truncateBusinessTables,
  type AuditLogRow,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PASSWORD = 'Clave-Segura-123';
const TEMP_PASSWORD = 'Temp-Password-Secret-999';

interface UserAuditEntryResponse {
  id: string;
  action:
    | 'user.role_changed'
    | 'user.deactivated'
    | 'user.reactivated'
    | 'user.password_reset';
  actorName: string;
  actorRole: 'admin' | 'asesor';
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip?: string | null;
  channel: string;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

describe('Users audit log and multi-tenant isolation (e2e, T054, US4)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let adminA: UserFixture;
  let asesorLuisA: UserFixture;
  let adminB: UserFixture;
  let asesorMartaB: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(
      res.status,
      `Expected status ${status}, got ${res.status}: ${JSON.stringify(res.body)}`,
    ).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function expectNoPassword(
    text: string,
    ...passwords: (string | undefined)[]
  ): void {
    for (const pwd of passwords) {
      if (pwd) {
        expect(
          text.includes(pwd),
          `Found raw password "${pwd}" in output`,
        ).toBe(false);
      }
    }
    expect(
      text.includes('scrypt$'),
      'Found scrypt password hash in output',
    ).toBe(false);
  }

  /** Reads all audit log rows belonging to a tenant using the migrator with app.tenant_id pinned. */
  async function allAuditRowsOf(tenantId: string): Promise<AuditLogRow[]> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const result = await client.query<AuditLogRow>(
        `SELECT id, tenant_id AS "tenantId", actor_user_id AS "actorUserId",
                actor_name AS "actorName", actor_role AS "actorRole", action,
                entity_type AS "entityType", entity_id AS "entityId", before, after, reason,
                occurred_at AS "occurredAt", ip, channel
           FROM audit_log
          ORDER BY occurred_at, id`,
      );
      await client.query('COMMIT');
      return result.rows;
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
    tenantA = await createTenant(`Taller A audit e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B audit e2e ${randomUUID()}`);

    adminA = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Administradora',
      email: uniqueEmail('ana'),
      role: 'admin',
      password: PASSWORD,
    });

    asesorLuisA = await createUser({
      tenantId: tenantA.id,
      name: 'Luis Asesor',
      email: uniqueEmail('luis'),
      role: 'asesor',
      password: PASSWORD,
    });

    adminB = await createUser({
      tenantId: tenantB.id,
      name: 'Beatriz Administradora',
      email: uniqueEmail('beatriz'),
      role: 'admin',
      password: PASSWORD,
    });

    asesorMartaB = await createUser({
      tenantId: tenantB.id,
      name: 'Marta Asesora',
      email: uniqueEmail('marta'),
      role: 'asesor',
      password: PASSWORD,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC12: Role change produces user.role_changed audit record
  // ---------------------------------------------------------------------------------------------
  it('US4-AC12: Role change produces exactly one user.role_changed audit log record with actorName, actorRole="admin", entityType="user", before: { role: "asesor" }, after: { role: "admin" }, occurredAt UTC, ip, channel="web"', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    const res = await server()
      .put(`/api/v1/users/${asesorLuisA.id}/role`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ role: 'admin' });
    expect(res.status).toBe(200);

    const rows = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rows).toHaveLength(1);

    const record = rows[0];
    expect(record.id).toMatch(UUID_RE);
    expect(record.tenantId).toBe(tenantA.id);
    expect(record.actorUserId).toBe(adminA.id);
    expect(record.actorName).toBe(adminA.name);
    expect(record.actorRole).toBe('admin');
    expect(record.action).toBe('user.role_changed');
    expect(record.entityType).toBe('user');
    expect(record.entityId).toBe(asesorLuisA.id);
    expect(record.before).toEqual({ role: 'asesor' });
    expect(record.after).toEqual({ role: 'admin' });
    expect(record.occurredAt).toBeInstanceOf(Date);
    expect(record.channel).toBe('web');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC13: Deactivate and Reactivate audit records
  // ---------------------------------------------------------------------------------------------
  it('US4-AC13: Deactivate produces one user.deactivated (with after: { status: "inactive", sessionsClosed: N }), reactivate produces one user.reactivated', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis opens 2 sessions
    await loginAs(app, asesorLuisA.email, PASSWORD);
    await loginAs(app, asesorLuisA.email, PASSWORD);

    // 1. Deactivate Luis
    const resDeact = await server()
      .post(`/api/v1/users/${asesorLuisA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resDeact.status).toBe(200);

    const rowsAfterDeact = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rowsAfterDeact).toHaveLength(1);

    const deactRecord = rowsAfterDeact[0];
    expect(deactRecord.action).toBe('user.deactivated');
    expect(deactRecord.actorUserId).toBe(adminA.id);
    expect(deactRecord.actorName).toBe(adminA.name);
    expect(deactRecord.actorRole).toBe('admin');
    expect(deactRecord.entityType).toBe('user');
    expect(deactRecord.entityId).toBe(asesorLuisA.id);
    expect(deactRecord.channel).toBe('web');
    expect(deactRecord.before).toMatchObject({ status: 'active' });
    expect(deactRecord.after).toMatchObject({
      status: 'inactive',
      sessionsClosed: 2,
    });

    // 2. Reactivate Luis
    const resReact = await server()
      .post(`/api/v1/users/${asesorLuisA.id}/reactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resReact.status).toBe(200);

    const rowsAfterReact = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rowsAfterReact).toHaveLength(2);

    const reactRecord = rowsAfterReact[1];
    expect(reactRecord.action).toBe('user.reactivated');
    expect(reactRecord.actorUserId).toBe(adminA.id);
    expect(reactRecord.actorName).toBe(adminA.name);
    expect(reactRecord.actorRole).toBe('admin');
    expect(reactRecord.entityType).toBe('user');
    expect(reactRecord.entityId).toBe(asesorLuisA.id);
    expect(reactRecord.channel).toBe('web');
    expect(reactRecord.before).toMatchObject({ status: 'inactive' });
    expect(reactRecord.after).toMatchObject({ status: 'active' });
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC14: Atomic rejection (e.g. LAST_ADMIN) produces NO audit records
  // ---------------------------------------------------------------------------------------------
  it('US4-AC14: A LAST_ADMIN rejection produces NO audit log record and no session revocations', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Ana is the sole admin. Attempting to deactivate herself fails with LAST_ADMIN
    const resDeact = await server()
      .post(`/api/v1/users/${adminA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expectProblem(resDeact, 409, 'LAST_ADMIN');

    // Attempting to demote herself fails with LAST_ADMIN
    const resDemote = await server()
      .put(`/api/v1/users/${adminA.id}/role`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ role: 'asesor' });
    expectProblem(resDemote, 409, 'LAST_ADMIN');

    // No audit log records exist
    const rows = await readAuditLog(tenantA.id, adminA.id);
    expect(rows).toHaveLength(0);

    const allTenantRows = await allAuditRowsOf(tenantA.id);
    expect(allTenantRows).toHaveLength(0);

    // Ana's session remains active
    const sessions = await readUserSessions(adminA.id);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((s) => s.revokedAt === null)).toBe(true);

    const resMe = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(loginAdmin.accessToken));
    expect(resMe.status).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC15: No-change operation produces NO audit log record
  // ---------------------------------------------------------------------------------------------
  it('US4-AC15: A no-change operation (e.g. setting same role) produces NO audit log record', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis is already asesor: setting role to asesor
    const resSameRole = await server()
      .put(`/api/v1/users/${asesorLuisA.id}/role`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ role: 'asesor' });
    expect(resSameRole.status).toBe(200);

    const rowsSameRole = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rowsSameRole).toHaveLength(0);

    // Deactivate Luis (first time creates 1 record)
    const resDeact1 = await server()
      .post(`/api/v1/users/${asesorLuisA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resDeact1.status).toBe(200);

    const rowsAfterFirstDeact = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rowsAfterFirstDeact).toHaveLength(1);

    // Deactivating already inactive Luis again (second time is no-op)
    const resDeact2 = await server()
      .post(`/api/v1/users/${asesorLuisA.id}/deactivate`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resDeact2.status).toBe(200);

    const rowsAfterSecondDeact = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rowsAfterSecondDeact).toHaveLength(1); // still only 1, no duplicate audit record
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC17: Multi-tenant read isolation
  // ---------------------------------------------------------------------------------------------
  it("US4-AC17: Multi-tenant read: Admin of workshop A does not see Marta (workshop B) in GET /users, and GET /users/{Marta's ID} returns 404 NOT_FOUND", async () => {
    const loginAdminA = await loginAs(app, adminA.email, PASSWORD);

    // GET /users lists only workshop A users
    const resList = await server()
      .get('/api/v1/users')
      .set(authHeader(loginAdminA.accessToken));
    expect(resList.status).toBe(200);

    const items = (resList.body as { items: Array<{ id: string }> }).items;
    const ids = items.map((i) => i.id);
    expect(ids).toContain(adminA.id);
    expect(ids).toContain(asesorLuisA.id);
    expect(ids).not.toContain(adminB.id);
    expect(ids).not.toContain(asesorMartaB.id);

    // Direct GET /users/:id for Marta in workshop B returns 404
    const resGetMarta = await server()
      .get(`/api/v1/users/${asesorMartaB.id}`)
      .set(authHeader(loginAdminA.accessToken));
    expectProblem(resGetMarta, 404, 'NOT_FOUND');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC18: Multi-tenant write isolation
  // ---------------------------------------------------------------------------------------------
  it('US4-AC18: Multi-tenant write: Admin of A calling role, deactivate, reactivate, password-reset on Marta (B) gets 404, no changes, no sessions revoked, no audit records in A or B', async () => {
    const loginAdminA = await loginAs(app, adminA.email, PASSWORD);

    // Marta opens 2 sessions in workshop B
    const sessionMarta1 = await loginAs(app, asesorMartaB.email, PASSWORD);
    const sessionMarta2 = await loginAs(app, asesorMartaB.email, PASSWORD);

    // 1. Role change on Marta from Workshop A
    const resRole = await server()
      .put(`/api/v1/users/${asesorMartaB.id}/role`)
      .set(authHeader(loginAdminA.accessToken))
      .send({ role: 'admin' });
    expectProblem(resRole, 404, 'NOT_FOUND');

    // 2. Deactivate Marta from Workshop A
    const resDeact = await server()
      .post(`/api/v1/users/${asesorMartaB.id}/deactivate`)
      .set(authHeader(loginAdminA.accessToken));
    expectProblem(resDeact, 404, 'NOT_FOUND');

    // 3. Reactivate Marta from Workshop A
    const resReact = await server()
      .post(`/api/v1/users/${asesorMartaB.id}/reactivate`)
      .set(authHeader(loginAdminA.accessToken));
    expectProblem(resReact, 404, 'NOT_FOUND');

    // 4. Password reset on Marta from Workshop A
    const resReset = await server()
      .post(`/api/v1/users/${asesorMartaB.id}/password-reset`)
      .set(authHeader(loginAdminA.accessToken))
      .send({ temporaryPassword: 'NewTempPassword-123' });
    expectProblem(resReset, 404, 'NOT_FOUND');

    // Marta in Workshop B is completely unaffected: sessions still active
    const resMe1 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(sessionMarta1.accessToken));
    expect(resMe1.status).toBe(200);

    const resMe2 = await server()
      .get('/api/v1/auth/me')
      .set(authHeader(sessionMarta2.accessToken));
    expect(resMe2.status).toBe(200);

    // Marta's account details in B are unchanged
    const loginAdminB = await loginAs(app, adminB.email, PASSWORD);
    const resMartaCheck = await server()
      .get(`/api/v1/users/${asesorMartaB.id}`)
      .set(authHeader(loginAdminB.accessToken));
    expect(resMartaCheck.status).toBe(200);
    expect(resMartaCheck.body).toMatchObject({
      id: asesorMartaB.id,
      role: 'asesor',
      status: 'active',
    });

    // No audit rows created in Tenant A or Tenant B
    const auditRowsA = await allAuditRowsOf(tenantA.id);
    expect(auditRowsA).toHaveLength(0);

    const auditRowsB = await allAuditRowsOf(tenantB.id);
    expect(auditRowsB).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC20: History endpoint returns only tenant records sorted occurredAt DESC
  // ---------------------------------------------------------------------------------------------
  it('US4-AC20: GET /users/:id/history only returns audit entries for that tenant, sorted occurredAt DESC', async () => {
    const loginAdminA = await loginAs(app, adminA.email, PASSWORD);
    const loginAdminB = await loginAs(app, adminB.email, PASSWORD);

    // Workshop A: Admin A promotes Luis to admin, then demotes him back, then deactivates him
    await server()
      .put(`/api/v1/users/${asesorLuisA.id}/role`)
      .set(authHeader(loginAdminA.accessToken))
      .send({ role: 'admin' });

    await server()
      .put(`/api/v1/users/${asesorLuisA.id}/role`)
      .set(authHeader(loginAdminA.accessToken))
      .send({ role: 'asesor' });

    await server()
      .post(`/api/v1/users/${asesorLuisA.id}/deactivate`)
      .set(authHeader(loginAdminA.accessToken));

    // Workshop B: Admin B promotes Marta
    await server()
      .put(`/api/v1/users/${asesorMartaB.id}/role`)
      .set(authHeader(loginAdminB.accessToken))
      .send({ role: 'admin' });

    // Admin A requests history of Luis
    const resHistory = await server()
      .get(`/api/v1/users/${asesorLuisA.id}/history`)
      .set(authHeader(loginAdminA.accessToken));

    expect(resHistory.status).toBe(200);
    const body = resHistory.body as { items: UserAuditEntryResponse[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(3);

    // Validate fields and enum of each entry
    for (const entry of body.items) {
      expect(entry.id).toMatch(UUID_RE);
      expect([
        'user.role_changed',
        'user.deactivated',
        'user.reactivated',
        'user.password_reset',
      ]).toContain(entry.action);
      expect(entry.actorName).toBe(adminA.name);
      expect(entry.actorRole).toBe('admin');
      expect(entry.occurredAt).toMatch(ISO_DATE_RE);
      expect(entry.channel).toBe('web');
      expect(entry.before).toBeDefined();
      expect(entry.after).toBeDefined();
    }

    // Verify ordering: newest first (occurredAt DESC)
    const timestamps = body.items.map((entry) =>
      new Date(entry.occurredAt).getTime(),
    );
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[2]);
    expect(body.items[0].action).toBe('user.deactivated');

    // Admin A cannot access history of Marta (Workshop B) -> 404
    const resMartaHistory = await server()
      .get(`/api/v1/users/${asesorMartaB.id}/history`)
      .set(authHeader(loginAdminA.accessToken));
    expectProblem(resMartaHistory, 404, 'NOT_FOUND');
  });

  // ---------------------------------------------------------------------------------------------
  // US4-AC24: Password reset audit record and security check
  // ---------------------------------------------------------------------------------------------
  it('US4-AC24: user.password_reset audit record has before.mustChangePassword, after.mustChangePassword=true, after.temporaryPasswordExpiresAt, after.sessionsClosed; NEITHER the audit JSON nor response contains the password', async () => {
    const loginAdmin = await loginAs(app, adminA.email, PASSWORD);

    // Luis has 2 active sessions
    await loginAs(app, asesorLuisA.email, PASSWORD);
    await loginAs(app, asesorLuisA.email, PASSWORD);

    const resReset = await server()
      .post(`/api/v1/users/${asesorLuisA.id}/password-reset`)
      .set(authHeader(loginAdmin.accessToken))
      .send({ temporaryPassword: TEMP_PASSWORD });

    expect(resReset.status).toBe(200);

    // Check response text does not contain passwords
    expectNoPassword(resReset.text, TEMP_PASSWORD, PASSWORD);

    // Query audit log directly from database
    const rows = await readAuditLog(tenantA.id, asesorLuisA.id);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.action).toBe('user.password_reset');
    expect(row.actorUserId).toBe(adminA.id);
    expect(row.actorName).toBe(adminA.name);
    expect(row.actorRole).toBe('admin');
    expect(row.entityType).toBe('user');
    expect(row.entityId).toBe(asesorLuisA.id);
    expect(row.channel).toBe('web');

    expect(row.before).toMatchObject({
      mustChangePassword: false,
    });
    expect(row.after).toMatchObject({
      mustChangePassword: true,
      temporaryPasswordExpiresAt: expect.any(String),
      sessionsClosed: 2,
    });

    // Stringify the full database row and verify no password or hash is stored
    const rowJson = JSON.stringify(row);
    expectNoPassword(rowJson, TEMP_PASSWORD, PASSWORD);

    // Check history endpoint as well
    const resHistory = await server()
      .get(`/api/v1/users/${asesorLuisA.id}/history`)
      .set(authHeader(loginAdmin.accessToken));
    expect(resHistory.status).toBe(200);
    expectNoPassword(resHistory.text, TEMP_PASSWORD, PASSWORD);
  });
});
