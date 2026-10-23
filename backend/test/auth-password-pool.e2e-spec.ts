// T049 (blocking finding of the reviewer, specs/002-autenticacion): POST /auth/password must not
// exhaust the connection pool. In AuthService.changePassword a wrong current password is recorded
// (FR-027, US5-AC4: the failure counts for the FR-009 lock) through withAuthTransaction, which asks
// the pool for a SECOND connection while the request still holds its own. That first connection
// keeps the user_sessions row locked (the UPDATE of SessionValidator, research R6). Any other
// authenticated request of the same session takes a pool connection and waits on that row lock, so
// with as many concurrent requests as the pool has connections nobody can ever finish: the password
// request waits for a free connection and the others wait for its lock (pg waits without limit).
//
// Reproduction: one real session (loginAs), the pool of the app (default pg size, 10) and
// POOL_SIZE + 5 concurrent requests on that session. The password requests go first, so their
// transaction already holds the session row while scrypt runs; the GET /auth/me requests then take
// the remaining connections and block on that row. Every request must finish within
// REQUEST_TIMEOUT_MS. If the API hangs, the test fails on that timeout and afterAll terminates the
// motorsync_app backends with DATABASE_ADMIN_URL, so the suite can close the app and go on.
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, loginAs, type LoginResult } from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  createUser,
  emailHash,
  truncateBusinessTables,
  type UserFixture,
} from './setup/db-fixtures.js';

const PASSWORD = 'Clave-Segura-123';
const WRONG_PASSWORD = 'Clave-Equivocada-9';
const NEW_PASSWORD = 'Nueva-Clave-2026';
/** pg.Pool default (TypeORM passes no `max` unless `extra.max` is set). */
const PG_DEFAULT_POOL_SIZE = 10;
const REQUEST_TIMEOUT_MS = 15_000;
/** Password requests of the burst; below 5 the account is never locked by the burst itself. */
const PASSWORD_REQUESTS = 3;
/** Head start of the password requests, so they hold the session row when the others arrive. */
const HEAD_START_MS = 40;

type Outcome = { kind: 'response'; res: Response } | { kind: 'timeout' } | { kind: 'error'; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves with the response, or with 'timeout' if it does not arrive in `ms` (never hangs). */
function withTimeout(pending: PromiseLike<Response>, ms: number): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  const settled = Promise.resolve(pending).then(
    (res): Outcome => ({ kind: 'response', res }),
    (error: unknown): Outcome => ({ kind: 'error', error: String(error) }),
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

function anyHung(outcomes: Outcome[]): boolean {
  return outcomes.some((outcome) => outcome.kind !== 'response');
}

describe('POST /auth/password bajo concurrencia no agota el pool (e2e, T049)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let poolSize: number;
  let ana: UserFixture;
  /** Set when a request timed out: afterEach frees the hung connections before the next test. */
  let hangDetected = false;

  function server() {
    return request(app.getHttpServer());
  }

  async function failedCount(email: string): Promise<number> {
    const result = await migratorPool.query<{ failed_count: number }>(
      'SELECT failed_count FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0]?.failed_count ?? 0;
  }

  /** Unblocks a hung API: terminates the backends of motorsync_app (needs a superuser URL). */
  async function terminateAppBackends(): Promise<void> {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) return;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE usename = 'motorsync_app' AND pid <> pg_backend_pid()`,
      );
    } finally {
      await admin.end();
    }
  }

  beforeAll(async () => {
    await truncateBusinessTables();
    migratorPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 2 });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    const extra = (app.get(DataSource).options as { extra?: { max?: unknown } }).extra;
    poolSize = typeof extra?.max === 'number' ? extra.max : PG_DEFAULT_POOL_SIZE;
  });

  // Own workshop per test, without a TRUNCATE in between: after a hang, the requests that were
  // queued in the pool may still run for a moment and would race with it.
  beforeEach(async () => {
    const tenant = await createTenant(`Taller pool e2e ${randomUUID()}`);
    await createUser({
      tenantId: tenant.id,
      name: 'Alberto Admin',
      email: `alberto.${randomUUID().slice(0, 8)}@taller.ec`,
      role: 'admin',
      password: PASSWORD,
    });
    ana = await createUser({
      tenantId: tenant.id,
      name: 'Ana Pérez',
      email: `ana.${randomUUID().slice(0, 8)}@taller.ec`,
      role: 'asesor',
      password: PASSWORD,
    });
  });

  afterEach(async () => {
    if (!hangDetected) return;
    hangDetected = false;
    // Frees the hung connections; the requests queued behind them then fail or finish. Twice,
    // with a pause, to also cut the ones that got a connection right after the first round.
    await terminateAppBackends().catch(() => undefined);
    await sleep(1_000);
    await terminateAppBackends().catch(() => undefined);
  });

  afterAll(async () => {
    // If the API hung, its connections wait forever: free them before closing the app.
    await terminateAppBackends().catch(() => undefined);
    await sleep(1_000);
    await terminateAppBackends().catch(() => undefined);
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  }, 30_000);

  it(
    '[T049][FR-027][US5-AC4] POOL+5 peticiones concurrentes de la misma sesión (password con la actual incorrecta y GET /auth/me) terminan todas; los fallos quedan contados',
    async () => {
      const session: LoginResult = await loginAs(app, ana.email, PASSWORD);
      const total = poolSize + 5;

      const passwordCalls = Array.from({ length: PASSWORD_REQUESTS }, () =>
        withTimeout(
          server()
            .post('/api/v1/auth/password')
            .set(authHeader(session.accessToken))
            .send({ currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD }),
          REQUEST_TIMEOUT_MS,
        ),
      );
      await sleep(HEAD_START_MS);
      const otherCalls = Array.from({ length: total - PASSWORD_REQUESTS }, () =>
        withTimeout(
          server().get('/api/v1/auth/me').set(authHeader(session.accessToken)),
          REQUEST_TIMEOUT_MS,
        ),
      );

      const passwordOutcomes = await Promise.all(passwordCalls);
      const otherOutcomes = await Promise.all(otherCalls);

      hangDetected = anyHung([...passwordOutcomes, ...otherOutcomes]);
      const hung = [...passwordOutcomes, ...otherOutcomes].filter(
        (outcome) => outcome.kind !== 'response',
      );
      expect(
        hung,
        `${hung.length} de ${total} peticiones no terminaron en ${REQUEST_TIMEOUT_MS} ms (pool de ${poolSize} conexiones agotado)`,
      ).toEqual([]);

      const passwordResponses = passwordOutcomes.map((outcome) => (outcome as { res: Response }).res);
      for (const res of passwordResponses) {
        expect([400, 429], JSON.stringify(res.body)).toContain(res.status);
        expect(res.body).toMatchObject({
          code: res.status === 400 ? 'CURRENT_PASSWORD_INCORRECT' : 'ACCOUNT_LOCKED',
        });
      }
      for (const outcome of otherOutcomes) {
        const res = (outcome as { res: Response }).res;
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }

      const incorrect = passwordResponses.filter((res) => res.status === 400).length;
      expect(incorrect).toBeGreaterThan(0);
      expect(await failedCount(ana.email)).toBeGreaterThanOrEqual(incorrect);
    },
    REQUEST_TIMEOUT_MS + 15_000,
  );

  it(
    '[T049][FR-027][US5-AC4] tres ráfagas seguidas sobre la misma sesión: ninguna se cuelga y la sesión sigue respondiendo',
    async () => {
      const session = await loginAs(app, ana.email, PASSWORD);
      const total = poolSize + 5;

      for (let round = 1; round <= 3; round += 1) {
        const outcomes = await Promise.all(
          Array.from({ length: total }, (_, index) =>
            withTimeout(
              index % 5 === 0
                ? server()
                    .post('/api/v1/auth/password')
                    .set(authHeader(session.accessToken))
                    .send({ currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD })
                : server().get('/api/v1/auth/me').set(authHeader(session.accessToken)),
              REQUEST_TIMEOUT_MS,
            ),
          ),
        );
        hangDetected = anyHung(outcomes);
        const hung = outcomes.filter((outcome) => outcome.kind !== 'response');
        expect(hung, `ronda ${round}: ${hung.length} de ${total} peticiones colgadas`).toEqual([]);
      }

      // The lock (5 failures) may be reached: the session in course stays open (US5-AC4).
      const me = await withTimeout(
        server().get('/api/v1/auth/me').set(authHeader(session.accessToken)),
        REQUEST_TIMEOUT_MS,
      );
      hangDetected = anyHung([me]);
      expect(me.kind).toBe('response');
      expect((me as { res: Response }).res.status).toBe(200);
    },
    3 * REQUEST_TIMEOUT_MS + 15_000,
  );
});
