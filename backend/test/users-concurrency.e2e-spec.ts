// Review of PR3 (specs/002-autenticacion, T053/T055): concurrency of the account mutations over
// the full app wiring (AppModule + configureApp) and the real PostgreSQL (API as motorsync_app).
// - US4-AC10: two admins that deactivate each other at the same time, with real sessions, never
//   get a 500 (research R8: the advisory lock of the workshop and the user_sessions row locked by
//   SessionValidator must not form a deadlock cycle, 40P01).
// - Edge case "restablecimiento mientras el usuario está cambiando su contraseña": POST
//   /auth/password of Luis racing an admin's password-reset or deactivate. Never a 500; the result
//   is one of the two sequential orders allowed by the spec.
// - Research R8: reactivate takes pg_advisory_xact_lock of the workshop like the other mutations.
// Each round recreates the state, so a race that only shows up sometimes becomes likely.
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
  emailHash,
  hashPassword,
  readUserSessions,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';

const PASSWORD = 'Clave-Segura-123';
const NEW_PASSWORD = 'Nueva-Clave-Luis-456';
const TEMP_PASSWORD = 'Temporal-Admin-789';
const ROUNDS = 10;
const ROUND_TEST_TIMEOUT = 180_000;

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

interface Outcome {
  status: number;
  code: string | undefined;
}

function outcomeOf(res: Response): Outcome {
  return { status: res.status, code: (res.body as { code?: string })?.code };
}

function label(outcome: Outcome): string {
  return outcome.code ? `${outcome.status} ${outcome.code}` : `${outcome.status}`;
}

describe('Users concurrency (e2e, review PR3, US4-AC10, R8)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let ana: UserFixture;
  let pedro: UserFixture;
  let luis: UserFixture;
  let luisPasswordHash: string;

  function server() {
    return request(app.getHttpServer());
  }

  /** Runs fn as the migrator with app.tenant_id pinned to tenant A (FORCE RLS). */
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

  async function activeAdminCount(): Promise<number> {
    return asMigratorInA(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM users WHERE role = 'admin' AND status = 'active'`,
      );
      return Number(result.rows[0].count);
    });
  }

  /** Audit rows of tenant A with the given action on the given user. */
  async function auditCount(action: string, entityId: string): Promise<number> {
    return asMigratorInA(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM audit_log WHERE action = $1 AND entity_id = $2`,
        [action, entityId],
      );
      return Number(result.rows[0].count);
    });
  }

  interface AccountRow {
    status: string;
    role: string;
    mustChangePassword: boolean;
  }

  async function readAccount(userId: string): Promise<AccountRow> {
    return asMigratorInA(async (client) => {
      const result = await client.query<AccountRow>(
        `SELECT status, role, must_change_password AS "mustChangePassword"
           FROM users WHERE id = $1`,
        [userId],
      );
      return result.rows[0];
    });
  }

  /** Both admins active again (inactive -> active never fires users_keep_active_admin). */
  async function resetAdmins(): Promise<void> {
    await asMigratorInA((client) =>
      client.query(
        `UPDATE users SET status = 'active', role = 'admin' WHERE id = ANY($1::uuid[])`,
        [[ana.id, pedro.id]],
      ),
    );
  }

  /** Luis active, with PASSWORD and no pending change, and without login failures. */
  async function resetLuis(): Promise<void> {
    await asMigratorInA((client) =>
      client.query(
        `UPDATE users
            SET status = 'active', password_hash = $2, must_change_password = false,
                temp_password_expires_at = NULL
          WHERE id = $1`,
        [luis.id, luisPasswordHash],
      ),
    );
    await migratorPool.query('DELETE FROM login_attempts WHERE email_hash = $1', [
      emailHash(luis.email),
    ]);
  }

  async function loginStatus(email: string, password: string): Promise<Outcome> {
    return outcomeOf(
      await server().post('/api/v1/auth/login').send({ email, password }),
    );
  }

  beforeAll(async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) {
      throw new Error('DATABASE_MIGRATOR_URL is not set in the e2e environment');
    }
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 3 });
    luisPasswordHash = await hashPassword(PASSWORD);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    tenantA = await createTenant(`Taller A concurrency e2e ${randomUUID()}`);
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: uniqueEmail('ana'),
      role: 'admin',
      password: PASSWORD,
    });
    pedro = await createUser({
      tenantId: tenantA.id,
      name: 'Pedro Gómez',
      email: uniqueEmail('pedro'),
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

  // ---------------------------------------------------------------------------------------------
  // US4-AC10: mutual deactivation of the two admins, never a 500
  // ---------------------------------------------------------------------------------------------
  it(
    `[US4-AC10] Ana y Pedro se desactivan mutuamente a la vez (${ROUNDS} rondas): nunca 500, solo 200, 409 LAST_ADMIN o 401 SESSION_REVOKED, como máximo un 200 y siempre queda un admin activo`,
    async () => {
      const allowed = new Set(['200', '409 LAST_ADMIN', '401 SESSION_REVOKED']);
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetAdmins();
        const sessionAna = await loginAs(app, ana.email, PASSWORD);
        const sessionPedro = await loginAs(app, pedro.email, PASSWORD);

        const [anaRes, pedroRes] = await Promise.all([
          server()
            .post(`/api/v1/users/${pedro.id}/deactivate`)
            .set(authHeader(sessionAna.accessToken)),
          server()
            .post(`/api/v1/users/${ana.id}/deactivate`)
            .set(authHeader(sessionPedro.accessToken)),
        ]);
        const outcomes = [outcomeOf(anaRes), outcomeOf(pedroRes)];
        const labels = outcomes.map(label);
        const admins = await activeAdminCount();

        if (outcomes.some((o) => o.status >= 500)) roundsWith500 += 1;
        const unexpected = labels.filter((l) => !allowed.has(l));
        const successes = outcomes.filter((o) => o.status === 200).length;
        if (unexpected.length > 0 || successes > 1 || admins < 1) {
          violations.push(
            `ronda ${round}: Ana->Pedro=${labels[0]}, Pedro->Ana=${labels[1]}, admins activos=${admins}`,
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

  it(
    `[US4-AC10] Ana desactiva a Pedro mientras Pedro le quita el rol a Ana (${ROUNDS} rondas): nunca 500, siempre queda un admin activo y la auditoría coincide con lo que ocurrió`,
    async () => {
      const allowed = new Set(['200', '409 LAST_ADMIN', '401 SESSION_REVOKED']);
      // Only for Ana's request: 403 FORBIDDEN is also a valid sequential outcome. The workshop
      // advisory lock is taken by the interceptor before the session is validated, and the role is
      // read from the DB after that lock (R8, US4-AC16: the role is checked against the DB on every
      // request). If Pedro wins the lock, Ana is already an asesora when her request is validated,
      // so the admin-only endpoint answers 403. That is only coherent if Pedro's demotion succeeded
      // (200) and Pedro was not deactivated (no user.deactivated audit event for him).
      // 401 SESSION_REVOKED is only allowed for Pedro (Ana may deactivate him first): nobody
      // deactivates Ana and a role change does not close sessions, so Ana never gets it.
      const allowedAna = new Set(['200', '409 LAST_ADMIN', '403 FORBIDDEN']);
      const violations: string[] = [];
      let roundsWith500 = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetAdmins();
        const sessionAna = await loginAs(app, ana.email, PASSWORD);
        const sessionPedro = await loginAs(app, pedro.email, PASSWORD);
        const deactivatedBefore = await auditCount('user.deactivated', pedro.id);
        const roleChangedBefore = await auditCount('user.role_changed', ana.id);

        const [anaRes, pedroRes] = await Promise.all([
          server()
            .post(`/api/v1/users/${pedro.id}/deactivate`)
            .set(authHeader(sessionAna.accessToken)),
          server()
            .put(`/api/v1/users/${ana.id}/role`)
            .set(authHeader(sessionPedro.accessToken))
            .send({ role: 'asesor' }),
        ]);
        const outcomes = [outcomeOf(anaRes), outcomeOf(pedroRes)];
        const labels = outcomes.map(label);
        const admins = await activeAdminCount();

        const newDeactivations =
          (await auditCount('user.deactivated', pedro.id)) - deactivatedBefore;
        const newRoleChanges =
          (await auditCount('user.role_changed', ana.id)) - roleChangedBefore;

        if (outcomes.some((o) => o.status >= 500)) roundsWith500 += 1;
        const unexpected = [
          ...(allowedAna.has(labels[0]) ? [] : [labels[0]]),
          ...(allowed.has(labels[1]) ? [] : [labels[1]]),
        ];
        const successes = outcomes.filter((o) => o.status === 200).length;
        const anaForbiddenWithoutPedroWinning =
          labels[0] === '403 FORBIDDEN' && outcomes[1].status !== 200;
        const auditMismatch =
          newDeactivations !== (outcomes[0].status === 200 ? 1 : 0) ||
          newRoleChanges !== (outcomes[1].status === 200 ? 1 : 0);
        if (
          unexpected.length > 0 ||
          successes > 1 ||
          admins < 1 ||
          anaForbiddenWithoutPedroWinning ||
          auditMismatch
        ) {
          violations.push(
            `ronda ${round}: Ana desactiva a Pedro=${labels[0]}, Pedro quita rol a Ana=${labels[1]}, admins activos=${admins}, user.deactivated(Pedro)=${newDeactivations}, user.role_changed(Ana)=${newRoleChanges}`,
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

  // ---------------------------------------------------------------------------------------------
  // Edge case: password reset (or deactivation) while Luis changes his password
  // ---------------------------------------------------------------------------------------------
  it(
    `[US4 caso borde "restablecimiento mientras cambia su contraseña"] POST /auth/password de Luis y password-reset del admin a la vez (${ROUNDS} rondas): nunca 500 y el resultado es uno de los dos órdenes secuenciales`,
    async () => {
      // Reset first: Luis gets 401 SESSION_REVOKED (his session is already closed) or 400
      // CURRENT_PASSWORD_INCORRECT (US5-AC4). Change first: Luis gets 200 and the reset then
      // replaces the password. In both orders the account ends with the temporary password,
      // mustChangePassword = true and none of Luis's sessions alive (US4-AC21).
      const allowedLuis = new Set([
        '200',
        '401 SESSION_REVOKED',
        '400 CURRENT_PASSWORD_INCORRECT',
      ]);
      const violations: string[] = [];
      let roundsWith500 = 0;
      const admin = await loginAs(app, ana.email, PASSWORD);

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuis();
        const sessionLuis = await loginAs(app, luis.email, PASSWORD);

        const [luisRes, adminRes] = await Promise.all([
          server()
            .post('/api/v1/auth/password')
            .set(authHeader(sessionLuis.accessToken))
            .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
          server()
            .post(`/api/v1/users/${luis.id}/password-reset`)
            .set(authHeader(admin.accessToken))
            .send({ temporaryPassword: TEMP_PASSWORD }),
        ]);
        const luisOutcome = outcomeOf(luisRes);
        const adminOutcome = outcomeOf(adminRes);
        if (luisOutcome.status >= 500 || adminOutcome.status >= 500) roundsWith500 += 1;

        const problems: string[] = [];
        if (!allowedLuis.has(label(luisOutcome))) problems.push(`Luis=${label(luisOutcome)}`);
        if (adminOutcome.status !== 200) problems.push(`admin=${label(adminOutcome)}`);

        const sessions = await readUserSessions(luis.id);
        const alive = sessions.filter((s) => s.revokedAt === null).length;
        if (alive !== 0) problems.push(`${alive} sesiones de Luis siguen activas`);
        const account = await readAccount(luis.id);
        if (!account.mustChangePassword) problems.push('mustChangePassword = false');

        const withNew = await loginStatus(luis.email, NEW_PASSWORD);
        if (withNew.status !== 401) problems.push(`login con la nueva=${label(withNew)}`);
        const withTemp = await loginStatus(luis.email, TEMP_PASSWORD);
        if (withTemp.status !== 200) problems.push(`login con la temporal=${label(withTemp)}`);

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (Luis=${label(luisOutcome)}, admin=${label(adminOutcome)}): ${problems.join('; ')}`,
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

  it(
    `[US4 caso borde "restablecimiento mientras cambia su contraseña"] POST /auth/password de Luis y la desactivación de Luis a la vez (${ROUNDS} rondas): nunca 500, Luis queda inactivo y sin sesiones`,
    async () => {
      // Deactivation first: Luis gets 401 SESSION_REVOKED. Change first: Luis gets 200 and is then
      // deactivated. In both orders Luis ends inactive, without live sessions and unable to log in.
      const allowedLuis = new Set(['200', '401 SESSION_REVOKED']);
      const violations: string[] = [];
      let roundsWith500 = 0;
      const admin = await loginAs(app, ana.email, PASSWORD);

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuis();
        const sessionLuis = await loginAs(app, luis.email, PASSWORD);

        const [luisRes, adminRes] = await Promise.all([
          server()
            .post('/api/v1/auth/password')
            .set(authHeader(sessionLuis.accessToken))
            .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
          server()
            .post(`/api/v1/users/${luis.id}/deactivate`)
            .set(authHeader(admin.accessToken)),
        ]);
        const luisOutcome = outcomeOf(luisRes);
        const adminOutcome = outcomeOf(adminRes);
        if (luisOutcome.status >= 500 || adminOutcome.status >= 500) roundsWith500 += 1;

        const problems: string[] = [];
        if (!allowedLuis.has(label(luisOutcome))) problems.push(`Luis=${label(luisOutcome)}`);
        if (adminOutcome.status !== 200) problems.push(`admin=${label(adminOutcome)}`);

        const account = await readAccount(luis.id);
        if (account.status !== 'inactive') problems.push(`estado=${account.status}`);
        const sessions = await readUserSessions(luis.id);
        const alive = sessions.filter((s) => s.revokedAt === null).length;
        if (alive !== 0) problems.push(`${alive} sesiones de Luis siguen activas`);

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (Luis=${label(luisOutcome)}, admin=${label(adminOutcome)}): ${problems.join('; ')}`,
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

  // ---------------------------------------------------------------------------------------------
  // US4-AC21 + edge case "nunca mezcladas": login of Luis racing an admin's password-reset
  // ---------------------------------------------------------------------------------------------
  it(
    `[US4-AC21][US4 caso borde "nunca mezcladas"] login de Luis con su contraseña vigente y password-reset del admin a la vez (${ROUNDS} rondas): nunca queda viva una sesión abierta con la contraseña anterior y nunca 500`,
    async () => {
      // Sequential orders allowed by the spec:
      // - login first: 200, and the reset then closes that session (GET /auth/me -> 401
      //   SESSION_REVOKED);
      // - reset first: the previous password no longer works -> 401 INVALID_CREDENTIALS.
      // A login that read the old password_hash before the reset committed and opened its session
      // after the reset revoked the sessions would leave a live session with the old password.
      // To widen the window, several logins are fired at staggered offsets around the reset (fewer
      // than 5, so the lockout of US2-AC5 never kicks in within a round).
      const LOGINS_PER_ROUND = 4;
      const STAGGER_MS = 30;
      const violations: string[] = [];
      let roundsWith500 = 0;
      const admin = await loginAs(app, ana.email, PASSWORD);

      const delayed = <T>(ms: number, fn: () => Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            fn().then(resolve, reject);
          }, ms);
        });

      for (let round = 1; round <= ROUNDS; round += 1) {
        await resetLuis();
        // Sessions of previous rounds (a leaked one included) must not count in this one.
        await asMigratorInA((client) =>
          client.query(
            `UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'logout'
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [luis.id],
          ),
        );

        const [adminRes, ...loginResponses] = await Promise.all([
          server()
            .post(`/api/v1/users/${luis.id}/password-reset`)
            .set(authHeader(admin.accessToken))
            .send({ temporaryPassword: TEMP_PASSWORD }),
          ...Array.from({ length: LOGINS_PER_ROUND }, (_, i) =>
            delayed(i * STAGGER_MS, () =>
              server()
                .post('/api/v1/auth/login')
                .send({ email: luis.email, password: PASSWORD }),
            ),
          ),
        ]);

        const adminOutcome = outcomeOf(adminRes);
        const loginOutcomes = loginResponses.map(outcomeOf);
        if (adminOutcome.status >= 500 || loginOutcomes.some((o) => o.status >= 500)) {
          roundsWith500 += 1;
        }

        const problems: string[] = [];
        if (adminOutcome.status !== 200) problems.push(`admin=${label(adminOutcome)}`);

        for (const [i, res] of loginResponses.entries()) {
          const outcome = loginOutcomes[i];
          if (outcome.status === 200) {
            const accessToken = (res.body as { accessToken?: string }).accessToken ?? '';
            const me = outcomeOf(
              await server().get('/api/v1/auth/me').set(authHeader(accessToken)),
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
        if (alive !== 0) problems.push(`${alive} sesiones de Luis siguen activas en la base`);

        if (problems.length > 0) {
          violations.push(
            `ronda ${round} (admin=${label(adminOutcome)}, logins=${loginOutcomes.map(label).join(', ')}): ${problems.join('; ')}`,
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

  // ---------------------------------------------------------------------------------------------
  // Research R8: every role or status mutation takes the advisory lock of the workshop
  // ---------------------------------------------------------------------------------------------
  describe('[R8] advisory lock del taller en las mutaciones de estado', () => {
    const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('users-admins:' || $1::text, 0))`;
    const WAIT_LIMIT_MS = 4_000;

    /** Number of backends waiting for an advisory lock (pg_locks is readable by any role). */
    async function advisoryWaiters(): Promise<number> {
      const result = await migratorPool.query<{ count: string }>(
        `SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      );
      return Number(result.rows[0].count);
    }

    /**
     * Holds the advisory lock of tenant A from another connection, fires `send` and checks that the
     * request waits for the lock (it shows up in pg_locks as not granted and does not answer) until
     * the holder commits. Returns the response obtained after releasing the lock.
     */
    async function expectWaitsForWorkshopLock(
      send: () => Promise<Response>,
    ): Promise<Response> {
      const holder = await migratorPool.connect();
      let settled = false;
      let pending: Promise<Response> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(LOCK_SQL, [tenantA.id]);

        pending = send().then((res) => {
          settled = true;
          return res;
        });

        const deadline = Date.now() + WAIT_LIMIT_MS;
        let waiting = false;
        while (Date.now() < deadline && !settled) {
          if ((await advisoryWaiters()) > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(
          settled,
          'la petición respondió mientras otra transacción tenía el advisory lock del taller: no lo tomó',
        ).toBe(false);
        expect(waiting, 'la petición no quedó esperando el advisory lock del taller').toBe(true);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
      if (!pending) throw new Error('the request was never sent');
      return pending;
    }

    it('[R8] control: la desactivación espera el advisory lock del taller y termina al liberarse', async () => {
      const admin = await loginAs(app, ana.email, PASSWORD);
      const res = await expectWaitsForWorkshopLock(() =>
        server()
          .post(`/api/v1/users/${luis.id}/deactivate`)
          .set(authHeader(admin.accessToken)),
      );
      expect(res.status).toBe(200);
      expect((await readAccount(luis.id)).status).toBe('inactive');
    }, 30_000);

    it('[R8] la reactivación toma el advisory lock del taller: espera mientras otra transacción lo tiene y termina al liberarse', async () => {
      await asMigratorInA((client) =>
        client.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [luis.id]),
      );
      const admin = await loginAs(app, ana.email, PASSWORD);
      const res = await expectWaitsForWorkshopLock(() =>
        server()
          .post(`/api/v1/users/${luis.id}/reactivate`)
          .set(authHeader(admin.accessToken)),
      );
      expect(res.status).toBe(200);
      expect((await readAccount(luis.id)).status).toBe('active');
    }, 30_000);
  });
});
