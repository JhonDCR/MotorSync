// Review of PR3 (specs/002-autenticacion, T054/T055): US4-AC14, atomic audit with a forced failure.
// A TestingModule of its own overrides AuditService so that record() throws after the UPDATE of the
// account (and, for deactivate and password-reset, after the revocation of the sessions). The API
// must answer 500 INTERNAL_ERROR and leave nothing behind: no change in the account (role, status,
// hash, must_change_password, updated_at), no revoked session, no cleared login lock and no audit
// record. Real PostgreSQL, the API connecting as motorsync_app.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AuditService } from '../src/audit/audit.service.js';
import { authHeader, loginAs, type LoginResult } from './setup/auth.js';
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
} from './setup/db-fixtures.js';

const PASSWORD = 'Clave-Segura-123';
const TEMP_PASSWORD = 'Temporal-Atomica-456';

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

/** AuditService whose record() always fails, as a failed INSERT into audit_log would. */
class FailingAuditService {
  calls = 0;

  record(): Promise<never> {
    this.calls += 1;
    return Promise.reject(new Error('forced audit failure (US4-AC14)'));
  }
}

interface AccountSnapshot {
  role: string;
  status: string;
  passwordHash: string;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
  updatedAt: Date;
  updatedBy: string;
  updatedByName: string;
}

interface LoginAttemptSnapshot {
  failedCount: number;
  lockedUntil: Date | null;
}

describe('Users atomic audit with a forced failure (e2e, review PR3, US4-AC14)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let failingAudit: FailingAuditService;
  let tenantA: TenantFixture;
  let ana: UserFixture;
  let luis: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  function expectInternalError(res: Response): void {
    expect(
      res.status,
      `Expected 500, got ${res.status}: ${JSON.stringify(res.body)}`,
    ).toBe(500);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
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

  async function snapshotAccount(userId: string): Promise<AccountSnapshot> {
    return asMigratorInA(async (client) => {
      const result = await client.query<AccountSnapshot>(
        `SELECT role, status, password_hash AS "passwordHash",
                must_change_password AS "mustChangePassword",
                temp_password_expires_at AS "tempPasswordExpiresAt",
                updated_at AS "updatedAt", updated_by AS "updatedBy",
                updated_by_name AS "updatedByName"
           FROM users WHERE id = $1`,
        [userId],
      );
      return result.rows[0];
    });
  }

  async function snapshotLoginAttempt(
    email: string,
  ): Promise<LoginAttemptSnapshot | undefined> {
    const result = await migratorPool.query<LoginAttemptSnapshot>(
      `SELECT failed_count AS "failedCount", locked_until AS "lockedUntil"
         FROM login_attempts WHERE email_hash = $1`,
      [emailHash(email)],
    );
    return result.rows[0];
  }

  async function auditRowsOfA(): Promise<number> {
    return asMigratorInA(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM audit_log',
      );
      return Number(result.rows[0].count);
    });
  }

  /** Every session of Luis is still open and still accepted by the API. */
  async function expectSessionsUntouched(sessions: LoginResult[]): Promise<void> {
    const rows = await readUserSessions(luis.id);
    expect(rows).toHaveLength(sessions.length);
    expect(rows.every((row) => row.revokedAt === null && row.revokeReason === null)).toBe(true);
    for (const session of sessions) {
      const me = await server()
        .get('/api/v1/auth/me')
        .set(authHeader(session.accessToken));
      expect(me.status).toBe(200);
    }
  }

  async function expectNoAudit(): Promise<void> {
    expect(await readAuditLog(tenantA.id, luis.id)).toEqual([]);
    expect(await auditRowsOfA()).toBe(0);
  }

  beforeAll(async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) {
      throw new Error('DATABASE_MIGRATOR_URL is not set in the e2e environment');
    }
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 2 });

    failingAudit = new FailingAuditService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuditService)
      .useValue(failingAudit)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await closeFixtures();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    failingAudit.calls = 0;
    tenantA = await createTenant(`Taller A atomicity e2e ${randomUUID()}`);
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: uniqueEmail('ana'),
      role: 'admin',
      password: PASSWORD,
    });
    luis = await createUser({
      tenantId: tenantA.id,
      name: 'Luis Asesor',
      email: uniqueEmail('luis'),
      role: 'asesor',
      password: PASSWORD,
    });
  });

  it('[US4-AC14] cambio de rol con fallo forzado de la auditoría: 500 INTERNAL_ERROR, el rol no cambia y no hay registro', async () => {
    const admin = await loginAs(app, ana.email, PASSWORD);
    const luisSession = await loginAs(app, luis.email, PASSWORD);
    const before = await snapshotAccount(luis.id);

    const res = await server()
      .put(`/api/v1/users/${luis.id}/role`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'admin' });

    expectInternalError(res);
    expect(failingAudit.calls).toBe(1);
    expect(await snapshotAccount(luis.id)).toEqual(before);
    await expectSessionsUntouched([luisSession]);
    await expectNoAudit();
  });

  it('[US4-AC14] desactivación con fallo forzado de la auditoría: 500 INTERNAL_ERROR, la cuenta sigue activa, ninguna sesión revocada y sin registro', async () => {
    const admin = await loginAs(app, ana.email, PASSWORD);
    const sessions = [
      await loginAs(app, luis.email, PASSWORD),
      await loginAs(app, luis.email, PASSWORD),
    ];
    const before = await snapshotAccount(luis.id);

    const res = await server()
      .post(`/api/v1/users/${luis.id}/deactivate`)
      .set(authHeader(admin.accessToken));

    expectInternalError(res);
    expect(failingAudit.calls).toBe(1);
    expect(await snapshotAccount(luis.id)).toEqual(before);
    await expectSessionsUntouched(sessions);
    await expectNoAudit();
  });

  it('[US4-AC14] reactivación con fallo forzado de la auditoría: 500 INTERNAL_ERROR, la cuenta sigue inactiva y sin registro', async () => {
    await asMigratorInA((client) =>
      client.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [luis.id]),
    );
    const admin = await loginAs(app, ana.email, PASSWORD);
    const before = await snapshotAccount(luis.id);

    const res = await server()
      .post(`/api/v1/users/${luis.id}/reactivate`)
      .set(authHeader(admin.accessToken));

    expectInternalError(res);
    expect(failingAudit.calls).toBe(1);
    expect(await snapshotAccount(luis.id)).toEqual(before);
    await expectNoAudit();
  });

  it('[US4-AC14] restablecimiento con fallo forzado de la auditoría: 500 INTERNAL_ERROR, hash, mustChangePassword y bloqueo intactos, ninguna sesión revocada y sin registro', async () => {
    const admin = await loginAs(app, ana.email, PASSWORD);
    const sessions = [
      await loginAs(app, luis.email, PASSWORD),
      await loginAs(app, luis.email, PASSWORD),
    ];
    await setLockedUntil(luis.email, 15);
    const before = await snapshotAccount(luis.id);
    const lockBefore = await snapshotLoginAttempt(luis.email);
    expect(lockBefore?.lockedUntil).not.toBeNull();

    const res = await server()
      .post(`/api/v1/users/${luis.id}/password-reset`)
      .set(authHeader(admin.accessToken))
      .send({ temporaryPassword: TEMP_PASSWORD });

    expectInternalError(res);
    expect(res.text).not.toContain(TEMP_PASSWORD);
    expect(failingAudit.calls).toBe(1);
    expect(await snapshotAccount(luis.id)).toEqual(before);
    // auth_clear_login_failures ran in the same transaction: the lock must still be there.
    expect(await snapshotLoginAttempt(luis.email)).toEqual(lockBefore);
    await expectSessionsUntouched(sessions);
    await expectNoAudit();
  });
});
