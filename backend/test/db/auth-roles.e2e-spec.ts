// T001 (specs/002-autenticacion): database design of motorsync_auth (research R1, data-model).
// Principle I (constitution 1.2.0): a read across tenants is only allowed inside bounded
// authentication functions (SECURITY DEFINER owned by motorsync_auth, NOLOGIN, NOBYPASSRLS,
// NOINHERIT), which search by equality of a secret or a unique identifier and return the
// minimum columns. Everything else keeps FORCE RLS by app_current_tenant().
// Connects as motorsync_app (DATABASE_URL) with raw pg, as the API does, and as
// motorsync_migrator through the T002 fixtures and its own pool (DATABASE_MIGRATOR_URL).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  closeFixtures,
  createTenant,
  createUser,
  emailHash,
  hashPassword,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
} from '../setup/db-fixtures.js';

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

const AUTH_FUNCTIONS = [
  'auth_register_workshop(text,text,text,text,text)',
  'auth_find_user_for_login(text)',
  'auth_find_refresh_token(text)',
  'auth_login_locked_until(text)',
  'auth_record_login_failure(text)',
  'auth_record_login_success(text)',
  'auth_clear_login_failures(uuid)',
] as const;

const PASSWORD = 'clave-segura-123';

let appPool: pg.Pool;
let migratorPool: pg.Pool;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let userA: UserFixture;
let userB: UserFixture;
let sessionA: string;
let sessionB: string;
let tokenHashA: string;
let tokenHashB: string;
let passwordHash: string;

/** Runs fn in a transaction on `db`, with the tenant pinned (or not), and rolls back or commits. */
async function inTransaction<T>(
  db: pg.Pool,
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
  finish: 'commit' | 'rollback' = 'rollback',
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (tenantId)
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
    const result = await fn(client);
    await client.query(finish === 'commit' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function asApp<T>(
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
  finish: 'commit' | 'rollback' = 'rollback',
): Promise<T> {
  return inTransaction(appPool, tenantId, fn, finish);
}

async function expectPgError(promise: Promise<unknown>): Promise<PgError> {
  const error = (await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )) as PgError | undefined;
  expect(error, 'the statement should have failed').toBeDefined();
  return error as PgError;
}

function expectPermissionDenied(error: PgError): void {
  expect(error.code).toBe('42501');
  expect(error.message).toMatch(/permission denied/i);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Valid RUC shape for the CHECK of tenants.ruc: 10 digits followed by 001. */
function randomRuc(): string {
  const digits = Array.from(randomBytes(10), (byte) => String(byte % 10)).join(
    '',
  );
  return `${digits}001`;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@taller.ec`;
}

/** Opens a session with one refresh token for `user`, as the app does under RLS. */
async function seedSession(
  user: UserFixture,
): Promise<{ sessionId: string; tokenHash: string }> {
  const tokenHash = sha256Hex(randomUUID());
  const sessionId = await asApp(
    user.tenantId,
    async (client) => {
      const session = await client.query<{ id: string }>(
        'INSERT INTO user_sessions (user_id) VALUES ($1) RETURNING id',
        [user.id],
      );
      await client.query(
        'INSERT INTO refresh_tokens (session_id, token_hash) VALUES ($1, $2)',
        [session.rows[0].id, tokenHash],
      );
      return session.rows[0].id;
    },
    'commit',
  );
  return { sessionId, tokenHash };
}

function columnNames(result: pg.QueryResult): string[] {
  return result.fields.map((field) => field.name);
}

describe('motorsync_auth y RLS de las cuentas en la BD (T001, principio I, FR-004, FR-022)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!appUrl)
      throw new Error('DATABASE_URL is not set in the e2e environment');
    if (!migratorUrl)
      throw new Error(
        'DATABASE_MIGRATOR_URL is not set in the e2e environment',
      );
    appPool = new pg.Pool({ connectionString: appUrl, max: 3 });
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 2 });

    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await truncateBusinessTables();
    await appPool?.end();
    await migratorPool?.end();
    await closeFixtures();
  });

  describe('(a) el rol motorsync_auth', () => {
    it('principio I: motorsync_auth es NOLOGIN, NOBYPASSRLS y NOINHERIT', async () => {
      const result = await appPool.query<{
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
      }>(
        `SELECT rolcanlogin, rolbypassrls, rolinherit, rolsuper
           FROM pg_roles WHERE rolname = 'motorsync_auth'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        rolcanlogin: false,
        rolbypassrls: false,
        rolinherit: false,
        rolsuper: false,
      });
    });

    it('principio I: motorsync_app no es miembro de motorsync_auth', async () => {
      const result = await appPool.query<{ member: boolean }>(
        `SELECT pg_has_role('motorsync_app', 'motorsync_auth', 'MEMBER') AS member`,
      );
      expect(result.rows[0].member).toBe(false);
    });

    it('principio I: SET ROLE motorsync_auth como motorsync_app falla con permission denied', async () => {
      const error = await expectPgError(
        asApp(null, (client) => client.query('SET ROLE motorsync_auth')),
      );
      expectPermissionDenied(error);
    });
  });

  describe('(b) las 7 funciones auth_*', () => {
    it('principio I: son SECURITY DEFINER, su dueño es motorsync_auth y fijan search_path', async () => {
      for (const signature of AUTH_FUNCTIONS) {
        const result = await appPool.query<{
          prosecdef: boolean;
          owner: string;
          proconfig: string[] | null;
        }>(
          `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [`public.${signature}`],
        );
        expect(result.rows, `${signature} should exist`).toHaveLength(1);
        const fn = result.rows[0];
        expect(fn.prosecdef, `${signature} prosecdef`).toBe(true);
        expect(fn.owner, `${signature} owner`).toBe('motorsync_auth');
        expect(fn.proconfig, `${signature} proconfig`).toContain(
          'search_path=pg_catalog, public, pg_temp',
        );
      }
    });

    it('principio I: motorsync_app tiene EXECUTE y PUBLIC no', async () => {
      for (const signature of AUTH_FUNCTIONS) {
        const result = await appPool.query<{
          app_can_execute: boolean;
          has_acl: boolean;
          public_execute: number;
        }>(
          `SELECT has_function_privilege('motorsync_app', p.oid, 'EXECUTE') AS app_can_execute,
                  p.proacl IS NOT NULL AS has_acl,
                  (SELECT count(*)::int FROM aclexplode(p.proacl) acl
                    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [`public.${signature}`],
        );
        expect(result.rows, `${signature} should exist`).toHaveLength(1);
        const fn = result.rows[0];
        expect(
          fn.app_can_execute,
          `${signature} EXECUTE for motorsync_app`,
        ).toBe(true);
        // A NULL proacl means the default privileges, which include EXECUTE for PUBLIC.
        expect(fn.has_acl, `${signature} has an explicit ACL`).toBe(true);
        expect(fn.public_execute, `${signature} EXECUTE for PUBLIC`).toBe(0);
      }
    });
  });

  // (c) to (h) need accounts, sessions and refresh tokens in A and B.
  describe('con cuentas en los talleres A y B', () => {
    beforeEach(async () => {
      await truncateBusinessTables();
      tenantA = await createTenant('Taller A (auth-roles)', randomRuc());
      tenantB = await createTenant('Taller B (auth-roles)', randomRuc());
      userA = await createUser({
        tenantId: tenantA.id,
        name: 'Ana Admin',
        email: uniqueEmail('ana'),
        role: 'admin',
        password: PASSWORD,
      });
      userB = await createUser({
        tenantId: tenantB.id,
        name: 'Bruno Asesor',
        email: uniqueEmail('bruno'),
        role: 'asesor',
        password: PASSWORD,
      });
      ({ sessionId: sessionA, tokenHash: tokenHashA } =
        await seedSession(userA));
      ({ sessionId: sessionB, tokenHash: tokenHashB } =
        await seedSession(userB));
    });

    describe('(c) FORCE RLS sigue aplicando', () => {
      it('principio I: users, user_sessions y refresh_tokens tienen ENABLE + FORCE; tenants solo ENABLE', async () => {
        const result = await appPool.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relname IN ('users', 'user_sessions', 'refresh_tokens', 'tenants')
          ORDER BY relname`,
        );
        expect(result.rows).toEqual([
          {
            relname: 'refresh_tokens',
            relrowsecurity: true,
            relforcerowsecurity: true,
          },
          {
            relname: 'tenants',
            relrowsecurity: true,
            relforcerowsecurity: false,
          },
          {
            relname: 'user_sessions',
            relrowsecurity: true,
            relforcerowsecurity: true,
          },
          { relname: 'users', relrowsecurity: true, relforcerowsecurity: true },
        ]);
      });

      it('principio I: el migrator sin app.tenant_id ve 0 filas en users (FORCE alcanza al dueño)', async () => {
        const count = await inTransaction(migratorPool, null, (client) =>
          client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM users',
          ),
        );
        expect(count.rows[0].count).toBe(0);

        // Control: the rows exist and the migrator sees them once a tenant is pinned.
        const pinned = await inTransaction(migratorPool, tenantA.id, (client) =>
          client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM users',
          ),
        );
        expect(pinned.rows[0].count).toBe(1);
      });
    });

    describe('(d) motorsync_app no lee cuentas sin taller', () => {
      it('FR-022: sin set_config, users, user_sessions y refresh_tokens devuelven 0 filas', async () => {
        for (const table of ['users', 'user_sessions', 'refresh_tokens']) {
          const result = await asApp(null, (client) =>
            client.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM ${table}`,
            ),
          );
          expect(result.rows[0].count, `${table} without tenant`).toBe(0);
        }
      });

      it('FR-022: con el taller A no se ven filas de B', async () => {
        for (const table of ['users', 'user_sessions', 'refresh_tokens']) {
          const result = await asApp(tenantA.id, (client) =>
            client.query<{ tenant_id: string }>(
              `SELECT tenant_id FROM ${table}`,
            ),
          );
          expect(result.rows, `${table} under A`).toEqual([
            { tenant_id: tenantA.id },
          ]);
        }
        const byId = await asApp(tenantA.id, async (client) => ({
          user: await client.query('SELECT id FROM users WHERE id = $1', [
            userB.id,
          ]),
          session: await client.query(
            'SELECT id FROM user_sessions WHERE id = $1',
            [sessionB],
          ),
          token: await client.query(
            'SELECT id FROM refresh_tokens WHERE token_hash = $1',
            [tokenHashB],
          ),
        }));
        expect(byId.user.rows).toHaveLength(0);
        expect(byId.session.rows).toHaveLength(0);
        expect(byId.token.rows).toHaveLength(0);

        // Control: under A its own session and token are visible by id.
        const own = await asApp(tenantA.id, (client) =>
          client.query(
            'SELECT s.id FROM user_sessions s JOIN refresh_tokens t ON t.session_id = s.id WHERE t.token_hash = $1',
            [tokenHashA],
          ),
        );
        expect(own.rows).toEqual([{ id: sessionA }]);
      });

      it('FR-022: un INSERT en users con tenant_id de B bajo A falla por WITH CHECK', async () => {
        const error = await expectPgError(
          asApp(tenantA.id, (client) =>
            client.query(
              `INSERT INTO users (tenant_id, name, email, password_hash, role,
                                created_by, updated_by, updated_by_name)
             VALUES ($1, 'Intrusa', $2, $3, 'admin', $4, $4, 'Intrusa')`,
              [tenantB.id, uniqueEmail('intrusa'), passwordHash, userA.id],
            ),
          ),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/row-level security/i);
      });

      it('FR-017: DELETE FROM users da permission denied', async () => {
        const error = await expectPgError(
          asApp(tenantA.id, (client) =>
            client.query('DELETE FROM users WHERE id = $1', [userA.id]),
          ),
        );
        expectPermissionDenied(error);
      });

      it('FR-022: con el taller A, tenants devuelve solo A; sin taller, 0 filas', async () => {
        const pinned = await asApp(tenantA.id, (client) =>
          client.query<{ id: string }>('SELECT * FROM tenants'),
        );
        expect(pinned.rows.map((row) => row.id)).toEqual([tenantA.id]);

        const unpinned = await asApp(null, (client) =>
          client.query<{ id: string }>('SELECT * FROM tenants'),
        );
        expect(unpinned.rows).toHaveLength(0);
      });
    });

    describe('(e) login_attempts', () => {
      it('principio I: SELECT en login_attempts como motorsync_app da permission denied', async () => {
        const error = await expectPgError(
          asApp(null, (client) => client.query('SELECT * FROM login_attempts')),
        );
        expectPermissionDenied(error);
      });

      it('principio I: INSERT en login_attempts como motorsync_app da permission denied', async () => {
        const error = await expectPgError(
          asApp(null, (client) =>
            client.query(
              'INSERT INTO login_attempts (email_hash, failed_count) VALUES ($1, 1)',
              [emailHash(uniqueEmail('x'))],
            ),
          ),
        );
        expectPermissionDenied(error);
      });
    });

    describe('(f) las funciones ven solo lo que deben', () => {
      it('principio I: auth_find_user_for_login devuelve las 8 columnas y solo la fila de ese correo, de cualquier taller', async () => {
        const found = await asApp(tenantA.id, (client) =>
          client.query('SELECT * FROM auth_find_user_for_login($1)', [
            userB.email,
          ]),
        );
        expect(columnNames(found)).toEqual([
          'user_id',
          'tenant_id',
          'name',
          'role',
          'status',
          'password_hash',
          'must_change_password',
          'temp_password_expires_at',
        ]);
        expect(found.rows).toHaveLength(1);
        expect(found.rows[0]).toMatchObject({
          user_id: userB.id,
          tenant_id: tenantB.id,
          name: userB.name,
          role: 'asesor',
          status: 'active',
          must_change_password: false,
          temp_password_expires_at: null,
        });
        expect(found.rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);

        // Also without a pinned tenant (the login does not know it yet).
        const unpinned = await asApp(null, (client) =>
          client.query('SELECT * FROM auth_find_user_for_login($1)', [
            userA.email,
          ]),
        );
        expect(
          unpinned.rows.map((row: { user_id: string }) => row.user_id),
        ).toEqual([userA.id]);
      });

      it('principio I: auth_find_user_for_login con un correo inexistente devuelve 0 filas', async () => {
        const result = await asApp(null, (client) =>
          client.query('SELECT * FROM auth_find_user_for_login($1)', [
            uniqueEmail('nadie'),
          ]),
        );
        expect(result.rows).toHaveLength(0);
      });

      it('principio I: auth_find_refresh_token devuelve exactamente 4 columnas', async () => {
        const result = await asApp(null, (client) =>
          client.query('SELECT * FROM auth_find_refresh_token($1)', [
            tokenHashB,
          ]),
        );
        expect(columnNames(result)).toEqual([
          'token_id',
          'tenant_id',
          'session_id',
          'rotated_at',
        ]);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          tenant_id: tenantB.id,
          session_id: sessionB,
          rotated_at: null,
        });

        const unknown = await asApp(null, (client) =>
          client.query('SELECT * FROM auth_find_refresh_token($1)', [
            sha256Hex(randomUUID()),
          ]),
        );
        expect(unknown.rows).toHaveLength(0);
      });

      it('FR-022: auth_clear_login_failures(<cuenta de B>) con el taller A fijado no borra la fila de B', async () => {
        const hashB = emailHash(userB.email);
        await asApp(
          null,
          (client) =>
            client.query('SELECT auth_record_login_failure($1)', [hashB]),
          'commit',
        );

        await asApp(
          tenantA.id,
          (client) =>
            client.query('SELECT auth_clear_login_failures($1)', [userB.id]),
          'commit',
        );
        const afterA = await migratorPool.query(
          'SELECT failed_count FROM login_attempts WHERE email_hash = $1',
          [hashB],
        );
        expect(afterA.rows).toEqual([{ failed_count: 1 }]);

        // Control: under its own tenant the function does clear it.
        await asApp(
          tenantB.id,
          (client) =>
            client.query('SELECT auth_clear_login_failures($1)', [userB.id]),
          'commit',
        );
        const afterB = await migratorPool.query(
          'SELECT failed_count FROM login_attempts WHERE email_hash = $1',
          [hashB],
        );
        expect(afterB.rows).toHaveLength(0);
      });
    });

    describe('(g) auth_register_workshop', () => {
      function register(
        client: pg.PoolClient,
        ruc: string,
        email: string,
      ): Promise<pg.QueryResult<{ tenant_id: string; user_id: string }>> {
        return client.query<{ tenant_id: string; user_id: string }>(
          'SELECT * FROM auth_register_workshop($1, $2, $3, $4, $5)',
          ['Taller Nuevo', ruc, 'Dueña Nueva', email, passwordHash],
        );
      }

      async function tenantsWithRuc(ruc: string): Promise<number> {
        const result = await migratorPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM tenants WHERE ruc = $1',
          [ruc],
        );
        return result.rows[0].count;
      }

      it('FR-004: crea el taller y la cuenta admin y fija app.tenant_id del taller nuevo', async () => {
        const ruc = randomRuc();
        const email = uniqueEmail('duena');
        const outcome = await asApp(
          null,
          async (client) => {
            const created = await register(client, ruc, email);
            const setting = await client.query<{ tenant: string }>(
              `SELECT current_setting('app.tenant_id') AS tenant`,
            );
            // Under the new tenant the app sees its own account and workshop through RLS.
            const user = await client.query(
              'SELECT id, tenant_id, role, status FROM users',
            );
            const workshop = await client.query(
              'SELECT id, name, ruc FROM tenants',
            );
            return { created, setting, user, workshop };
          },
          'commit',
        );

        expect(columnNames(outcome.created)).toEqual(['tenant_id', 'user_id']);
        expect(outcome.created.rows).toHaveLength(1);
        const { tenant_id: tenantId, user_id: userId } =
          outcome.created.rows[0];
        expect(outcome.setting.rows[0].tenant).toBe(tenantId);
        expect(outcome.user.rows).toEqual([
          { id: userId, tenant_id: tenantId, role: 'admin', status: 'active' },
        ]);
        expect(outcome.workshop.rows).toEqual([
          { id: tenantId, name: 'Taller Nuevo', ruc },
        ]);

        const stored = await inTransaction(migratorPool, tenantId, (client) =>
          client.query(
            `SELECT u.email, u.must_change_password, u.created_by, t.ruc
             FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
            [userId],
          ),
        );
        expect(stored.rows).toEqual([
          { email, must_change_password: false, created_by: userId, ruc },
        ]);
      });

      it('US1-AC4: con un RUC repetido lanza 23505 en tenants_ruc_key', async () => {
        const error = await expectPgError(
          asApp(null, (client) =>
            register(client, tenantA.ruc as string, uniqueEmail('otra')),
          ),
        );
        expect(error.code).toBe('23505');
        expect(error.constraint).toBe('tenants_ruc_key');
      });

      it('US1-AC7: con RUC nuevo y correo repetido lanza 23505 en users_email_key y no queda el taller', async () => {
        const ruc = randomRuc();
        const error = await expectPgError(
          asApp(null, (client) => register(client, ruc, userB.email)),
        );
        expect(error.code).toBe('23505');
        expect(error.constraint).toBe('users_email_key');
        expect(await tenantsWithRuc(ruc)).toBe(0);
      });

      it('US1-AC5: con RUC y correo repetidos el error es el de tenants_ruc_key', async () => {
        const error = await expectPgError(
          asApp(null, (client) =>
            register(client, tenantA.ruc as string, userB.email),
          ),
        );
        expect(error.code).toBe('23505');
        expect(error.constraint).toBe('tenants_ruc_key');
      });
    });

    describe('(h) auth_record_login_failure', () => {
      async function readAttempt(
        hash: string,
      ): Promise<
        { failed_count: number; locked_until: Date | null } | undefined
      > {
        const result = await migratorPool.query<{
          failed_count: number;
          locked_until: Date | null;
        }>(
          'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
          [hash],
        );
        return result.rows[0];
      }

      it('US2-AC5: 5 llamadas dejan locked_until no nulo', async () => {
        const hash = emailHash(uniqueEmail('cinco'));
        const returned: (Date | null)[] = [];
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const result = await asApp(
            null,
            (client) =>
              client.query<{ locked: Date | null }>(
                'SELECT auth_record_login_failure($1) AS locked',
                [hash],
              ),
            'commit',
          );
          returned.push(result.rows[0].locked);
        }
        expect(returned.slice(0, 4)).toEqual([null, null, null, null]);
        expect(returned[4]).toBeInstanceOf(Date);

        const row = await readAttempt(hash);
        expect(row?.failed_count).toBe(5);
        expect(row?.locked_until).toBeInstanceOf(Date);
        expect(row?.locked_until?.getTime() ?? 0).toBeGreaterThan(Date.now());
      });

      it('US2-AC9: 10 llamadas concurrentes desde 10 conexiones cuentan todas y bloquean', async () => {
        const hash = emailHash(uniqueEmail('concurrente'));
        const url = process.env.DATABASE_URL as string;
        const clients = Array.from(
          { length: 10 },
          () => new pg.Client({ connectionString: url }),
        );
        try {
          await Promise.all(clients.map((client) => client.connect()));
          await Promise.all(
            clients.map((client) =>
              client.query('SELECT auth_record_login_failure($1)', [hash]),
            ),
          );
        } finally {
          await Promise.all(clients.map((client) => client.end()));
        }

        const row = await readAttempt(hash);
        expect(row?.failed_count).toBe(10);
        expect(row?.locked_until).toBeInstanceOf(Date);
      });
    });
  });
});
