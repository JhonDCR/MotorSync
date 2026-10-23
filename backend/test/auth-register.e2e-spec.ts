// T019 (specs/002-autenticacion): e2e of the public workshop registration (US1-AC1 to US1-AC10,
// FR-001 to FR-006, FR-023) over the full app wiring (AppModule + configureApp) and the real
// PostgreSQL, the API connecting as motorsync_app.
// Contract: POST /api/v1/auth/register (RegisterRequest, @Public) → 201 SessionResponse
// { accessToken, expiresIn: 900, user: SessionUser, workshop: { id, name } } plus
// `Set-Cookie: ms_refresh=<32 bytes base64url>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`
// (no Max-Age). Errors in application/problem+json: 400 VALIDATION_ERROR with errors[].code
// (INVALID_RUC, REQUIRED, INVALID_EMAIL, PASSWORD_TOO_SHORT, UNKNOWN_FIELD); 409
// RUC_ALREADY_REGISTERED (explicit, no data of the existing workshop) and 409 REGISTRATION_FAILED
// (generic, no errors[] on email). The database is read as motorsync_migrator with the tenant
// pinned where FORCE RLS applies (users, user_sessions, refresh_tokens), and as motorsync_app
// for the isolation checks. Every test truncates and builds its own workshops.
import { createHash, randomInt, randomUUID } from 'node:crypto';
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
  readUserSessions,
  truncateBusinessTables,
  type TenantFixture,
} from './setup/db-fixtures.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 random bytes in base64url without padding (research R5). */
const REFRESH_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD = 'Clave-Segura-123';

type Json = Record<string, unknown>;

interface FieldErrorBody {
  field: string;
  code: string;
  message: string;
}

const REQUIRED_FIELDS = [
  'workshopName',
  'ruc',
  'name',
  'email',
  'password',
] as const;

let rucCounter = 0;

/**
 * A valid and unique RUC of a private company: province 17, third digit 9, 7 digits, `001`
 * (structure only, decision P1 of the 001).
 */
function newRuc(): string {
  rucCounter += 1;
  const middle = String((randomInt(0, 10_000) * 1000 + rucCounter) % 10_000_000).padStart(7, '0');
  return `179${middle}001`;
}

/** `179 1234567-001`: same RUC written with spaces and a hyphen. */
function withSpacesAndHyphen(ruc: string): string {
  return `${ruc.slice(0, 3)} ${ruc.slice(3, 10)}-${ruc.slice(10)}`;
}

function uniqueEmail(prefix = 'ana'): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@taller.ec`;
}

function registration(overrides: Json = {}): Json {
  return {
    workshopName: 'Taller Andrade',
    ruc: newRuc(),
    name: 'Ana Pérez',
    email: uniqueEmail(),
    password: PASSWORD,
    ...overrides,
  };
}

describe('Auth register (e2e, T019, US1)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let migratorPool: pg.Pool;

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
    expect(JSON.stringify(res.headers).includes('scrypt$')).toBe(false);
  }

  async function register(body: Json, headers: Record<string, string> = {}): Promise<Response> {
    const res = await server().post('/api/v1/auth/register').set(headers).send(body);
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

  /** Raw ms_refresh Set-Cookie header of a response, or undefined. */
  function rawRefreshCookie(res: Response): string | undefined {
    const header = res.headers['set-cookie'] as string | string[] | undefined;
    const cookies = header === undefined ? [] : Array.isArray(header) ? header : [header];
    return cookies.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  }

  /** Checks the contract attributes of ms_refresh and returns its value (the opaque token). */
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
    // No maximum lifetime: the session lives while there is activity (FR-012, research R5).
    expect(lower.some((attribute) => attribute.startsWith('max-age'))).toBe(false);
    expect(lower.some((attribute) => attribute.startsWith('expires'))).toBe(false);
    return value;
  }

  /** Runs fn as motorsync_migrator, in a transaction, with the tenant pinned (FORCE RLS). */
  async function asMigrator<T extends pg.QueryResultRow>(
    tenantId: string | null,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      }
      const result = await client.query<T>(sql, params);
      await client.query('ROLLBACK');
      return result.rows;
    } finally {
      client.release();
    }
  }

  /** Runs a read as motorsync_app with the tenant pinned, as the API sees the data (RLS). */
  async function asApp<T extends pg.QueryResultRow>(
    tenantId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await client.query<T>(sql, params);
      await client.query('ROLLBACK');
      return result.rows;
    } finally {
      client.release();
    }
  }

  async function tenantCount(): Promise<number> {
    const rows = await asMigrator<{ n: number }>(null, 'SELECT count(*)::int AS n FROM tenants');
    return rows[0].n;
  }

  async function tenantsWithRuc(ruc: string): Promise<{ id: string; name: string }[]> {
    return asMigrator<{ id: string; name: string }>(
      null,
      'SELECT id, name FROM tenants WHERE ruc = $1',
      [ruc],
    );
  }

  /** Accounts with that (normalized) email in any tenant: users has FORCE RLS, so tenant by tenant. */
  async function usersWithEmail(
    email: string,
  ): Promise<{ id: string; tenant_id: string; email: string; role: string; status: string }[]> {
    const tenants = await asMigrator<{ id: string }>(null, 'SELECT id FROM tenants');
    const found: { id: string; tenant_id: string; email: string; role: string; status: string }[] = [];
    for (const tenant of tenants) {
      const rows = await asMigrator<{
        id: string;
        tenant_id: string;
        email: string;
        role: string;
        status: string;
      }>(
        tenant.id,
        'SELECT id, tenant_id, email, role, status FROM users WHERE email = $1',
        [email.trim().toLowerCase()],
      );
      found.push(...rows);
    }
    return found;
  }

  async function userCountIn(tenantId: string): Promise<number> {
    const rows = await asMigrator<{ n: number }>(
      tenantId,
      'SELECT count(*)::int AS n FROM users',
    );
    return rows[0].n;
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
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US1-AC1

  it('US1-AC1 registro válido → 201 SessionResponse: admin sin cambio obligatorio, taller y token con sid y pwd_change false', async () => {
    const body = registration({ workshopName: 'Taller Andrade', name: 'Ana Pérez' });
    const startedAt = Math.floor(Date.now() / 1000);
    const res = await register(body);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      user: {
        name: 'Ana Pérez',
        email: body.email,
        role: 'admin',
        mustChangePassword: false,
      },
      workshop: { name: 'Taller Andrade' },
    });
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.id).toMatch(UUID_RE);
    expect(res.body.workshop.id).toMatch(UUID_RE);
    expect(res.body.user.temporaryPasswordExpiresAt ?? null).toBeNull();
    expect(res.body).not.toHaveProperty('refreshToken');
    expect(res.body.user).not.toHaveProperty('password');
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const claims = decodeJwtPayload(res.body.accessToken as string);
    expect(claims).toMatchObject({
      sub: res.body.user.id,
      tenant_id: res.body.workshop.id,
      role: 'admin',
      name: 'Ana Pérez',
      pwd_change: false,
    });
    expect(claims.sid).toMatch(UUID_RE);
    // JWT of 15 minutes (research R5).
    const exp = claims.exp as number;
    expect(exp - startedAt).toBeGreaterThanOrEqual(890);
    expect(exp - startedAt).toBeLessThanOrEqual(910);
  });

  it('US1-AC1 el registro fija la cookie ms_refresh con HttpOnly, Secure, SameSite=Strict y Path=/api/v1/auth, sin Max-Age', async () => {
    const res = await register(registration());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const value = expectRefreshCookie(res);
    // The refresh token only travels in the cookie, never in a body.
    expect(res.text.includes(value)).toBe(false);
  });

  it('US1-AC1 crea en la base el taller con su RUC, la cuenta admin activa no temporal, la sesión del sid y el refresh guardado como SHA-256', async () => {
    const body = registration();
    const res = await register(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const workshopId = res.body.workshop.id as string;
    const userId = res.body.user.id as string;
    const sid = decodeJwtPayload(res.body.accessToken as string).sid as string;
    const refresh = expectRefreshCookie(res);

    expect(await tenantsWithRuc(body.ruc as string)).toEqual([
      { id: workshopId, name: 'Taller Andrade' },
    ]);
    const users = await asMigrator<Json>(
      workshopId,
      `SELECT id, tenant_id, name, email, role, status, must_change_password,
              temp_password_expires_at, password_hash
         FROM users`,
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: userId,
      tenant_id: workshopId,
      name: 'Ana Pérez',
      email: body.email,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      temp_password_expires_at: null,
    });
    // FR-006: stored irreversibly (research R3 format), never in clear.
    expect(users[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(users[0].password_hash).not.toContain(PASSWORD);

    const sessions = await readUserSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sid,
      tenantId: workshopId,
      userId,
      revokedAt: null,
    });

    const tokens = await asMigrator<{ session_id: string; token_hash: string; rotated_at: Date | null }>(
      workshopId,
      'SELECT session_id, token_hash, rotated_at FROM refresh_tokens',
    );
    expect(tokens).toEqual([
      {
        session_id: sid,
        token_hash: createHash('sha256').update(refresh).digest('hex'),
        rotated_at: null,
      },
    ]);
  });

  it('US1-AC1 con el token del registro, GET /api/v1/clients/search?q=an → 200 en el taller nuevo', async () => {
    const res = await register(registration());
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const search = await server()
      .get('/api/v1/clients/search')
      .query({ q: 'an' })
      .set(authHeader(res.body.accessToken as string));

    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(search.body).toMatchObject({ items: [] });
  });

  it('US1-AC1 FR-001 el registro es público: no exige Authorization', async () => {
    const res = await server().post('/api/v1/auth/register').send(registration());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  // ---------------------------------------------------------------- US1-AC2

  it('US1-AC2 el correo " Ana.Perez@Taller.EC " se guarda como ana.perez@taller.ec y sirve para iniciar sesión con cualquier capitalización', async () => {
    const res = await register(registration({ email: ' Ana.Perez@Taller.EC ' }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.user.email).toBe('ana.perez@taller.ec');
    const stored = await usersWithEmail('ana.perez@taller.ec');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ email: 'ana.perez@taller.ec', role: 'admin' });

    const login = await loginAs(app, 'ANA.PEREZ@taller.EC', PASSWORD);
    expect(decodeJwtPayload(login.accessToken)).toMatchObject({
      sub: res.body.user.id,
      tenant_id: res.body.workshop.id,
    });
  });

  // ---------------------------------------------------------------- US1-AC3

  it.each([
    ['179001167400', '12 dígitos'],
    ['1790011674002', 'no termina en 001'],
    ['1770000000001', 'tercer dígito 7'],
  ])(
    'US1-AC3 RUC %s (%s) → 400 INVALID_RUC en ruc, sin taller ni cuenta',
    async (ruc) => {
      const body = registration({ ruc });
      const before = await tenantCount();

      const res = await register(body);

      expectValidationError(res, 'ruc', 'INVALID_RUC');
      expect(await tenantCount()).toBe(before);
      expect(await usersWithEmail(body.email as string)).toEqual([]);
      expect(rawRefreshCookie(res)).toBeUndefined();
    },
  );

  // ---------------------------------------------------------------- US1-AC4

  it.each([
    ['igual', (ruc: string) => ruc],
    ['con espacios y guion', withSpacesAndHyphen],
    ['con espacios alrededor', (ruc: string) => `  ${ruc}  `],
  ])(
    'US1-AC4 RUC repetido (%s) → 409 RUC_ALREADY_REGISTERED sin datos del taller existente y sin crear nada',
    async (_label, variant) => {
      const first = registration({ workshopName: 'Taller Andrade Original', name: 'Pedro Andrade' });
      const created = await register(first);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const before = await tenantCount();

      const second = registration({
        ruc: variant(first.ruc as string),
        workshopName: 'Taller Copia',
        name: 'Luis Mora',
      });
      const res = await register(second);

      expectProblem(res, 409, 'RUC_ALREADY_REGISTERED');
      for (const leaked of [
        created.body.workshop.id as string,
        'Taller Andrade Original',
        'Pedro Andrade',
        first.email as string,
        created.body.user.id as string,
      ]) {
        expect(res.text.includes(leaked), `the 409 reveals "${leaked}"`).toBe(false);
      }
      expect(await tenantCount()).toBe(before);
      expect(await usersWithEmail(second.email as string)).toEqual([]);
      expect(rawRefreshCookie(res)).toBeUndefined();
    },
  );

  // ---------------------------------------------------------------- US1-AC5

  it('US1-AC5 correo repetido con mayúsculas y RUC libre → 409 REGISTRATION_FAILED genérico, sin errors[] sobre email', async () => {
    const created = await register(registration({ email: 'ana.perez@taller.ec' }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const res = await register(registration({ email: 'ANA.PEREZ@taller.ec' }));

    expectProblem(res, 409, 'REGISTRATION_FAILED');
    expect(fieldErrors(res.body).some((error) => error.field === 'email')).toBe(false);
    // Generic: it neither confirms the email nor reveals the workshop that owns it.
    expect(res.text.toLowerCase().includes('ana.perez@taller.ec')).toBe(false);
    expect(res.text.includes(created.body.workshop.id as string)).toBe(false);
    expect(res.text.includes('Taller Andrade')).toBe(false);
    expect(rawRefreshCookie(res)).toBeUndefined();
  });

  it('US1-AC5 el correo de una cuenta desactivada de otro taller también da REGISTRATION_FAILED', async () => {
    const other = await createTenant(`Taller existente ${randomUUID()}`, newRuc());
    await createUser({
      tenantId: other.id,
      name: 'Luis Inactivo',
      email: 'luis@taller.ec',
      role: 'asesor',
      password: PASSWORD,
      status: 'inactive',
    });

    const res = await register(registration({ email: ' Luis@Taller.ec ' }));

    expectProblem(res, 409, 'REGISTRATION_FAILED');
    expect(fieldErrors(res.body).some((error) => error.field === 'email')).toBe(false);
  });

  it('US1-AC5 RUC y correo repetidos a la vez → 409 RUC_ALREADY_REGISTERED (gana el mensaje del RUC)', async () => {
    const first = registration();
    const created = await register(first);
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const res = await register(
      registration({ ruc: first.ruc, email: (first.email as string).toUpperCase() }),
    );

    expectProblem(res, 409, 'RUC_ALREADY_REGISTERED');
  });

  // ---------------------------------------------------------------- US1-AC6

  it('US1-AC6 contraseña de 7 caracteres → 400 PASSWORD_TOO_SHORT en password, sin crear nada', async () => {
    const body = registration({ password: 'Abc-123' });
    const before = await tenantCount();

    const res = await register(body);

    expectValidationError(res, 'password', 'PASSWORD_TOO_SHORT');
    expect(await tenantCount()).toBe(before);
    expect(await tenantsWithRuc(body.ruc as string)).toEqual([]);
  });

  it.each(REQUIRED_FIELDS.map((field) => [field]))(
    'US1-AC6 sin %s → 400 REQUIRED en ese campo, sin crear nada',
    async (field) => {
      const body = registration();
      delete body[field];
      const before = await tenantCount();

      const res = await register(body);

      expectValidationError(res, field, 'REQUIRED');
      expect(await tenantCount()).toBe(before);
    },
  );

  it('US1-AC6 body vacío → 400 con REQUIRED en cada uno de los 5 campos obligatorios', async () => {
    const res = await register({});

    expectProblem(res, 400, 'VALIDATION_ERROR');
    const errors = fieldErrors(res.body);
    for (const field of REQUIRED_FIELDS) {
      expect(errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, code: 'REQUIRED' })]),
      );
    }
  });

  it.each(['ana.perez', 'ana@', 'ana perez@taller.ec', '@taller.ec'])(
    'US1-AC6 correo inválido "%s" → 400 INVALID_EMAIL en email, sin crear nada',
    async (email) => {
      const body = registration({ email });
      const before = await tenantCount();

      const res = await register(body);

      expectValidationError(res, 'email', 'INVALID_EMAIL');
      expect(await tenantCount()).toBe(before);
    },
  );

  // ---------------------------------------------------------------- US1-AC7

  it('US1-AC7 tras un REGISTRATION_FAILED no queda ningún taller con ese RUC ni cuenta nueva (atomicidad)', async () => {
    const created = await register(registration({ email: 'ana.perez@taller.ec' }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const before = await tenantCount();
    const failed = registration({ email: 'Ana.Perez@Taller.ec' });

    const res = await register(failed);

    expectProblem(res, 409, 'REGISTRATION_FAILED');
    expect(await tenantsWithRuc(failed.ruc as string)).toEqual([]);
    expect(await tenantCount()).toBe(before);
    expect(await usersWithEmail('ana.perez@taller.ec')).toHaveLength(1);
  });

  // ---------------------------------------------------------------- US1-AC8

  it('US1-AC8 5 registros simultáneos con el mismo RUC → exactamente un 201 y 4 RUC_ALREADY_REGISTERED', async () => {
    const ruc = newRuc();
    const bodies = Array.from({ length: 5 }, (_, index) =>
      registration({ ruc, email: uniqueEmail(`concurrente${index}`) }),
    );

    const responses = await Promise.all(bodies.map((body) => register(body)));

    const created = responses.filter((res) => res.status === 201);
    const rejected = responses.filter((res) => res.status === 409);
    expect(created, responses.map((res) => res.status).join(',')).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const res of rejected) expect(res.body).toMatchObject({ code: 'RUC_ALREADY_REGISTERED' });

    const tenants = await tenantsWithRuc(ruc);
    expect(tenants).toHaveLength(1);
    expect(tenants[0].id).toBe(created[0].body.workshop.id);
    expect(await userCountIn(tenants[0].id)).toBe(1);
  });

  it('US1-AC8 5 registros simultáneos con el mismo correo → exactamente un 201 y 4 REGISTRATION_FAILED, sin talleres huérfanos', async () => {
    const email = uniqueEmail('mismo');
    const bodies = Array.from({ length: 5 }, (_, index) =>
      registration({ email: index % 2 === 0 ? email : email.toUpperCase() }),
    );
    const before = await tenantCount();

    const responses = await Promise.all(bodies.map((body) => register(body)));

    const created = responses.filter((res) => res.status === 201);
    const rejected = responses.filter((res) => res.status === 409);
    expect(created, responses.map((res) => res.status).join(',')).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const res of rejected) expect(res.body).toMatchObject({ code: 'REGISTRATION_FAILED' });

    expect(await tenantCount()).toBe(before + 1);
    expect(await usersWithEmail(email)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- US1-AC9

  it.each([
    ['tenantId', () => randomUUID()],
    ['role', () => 'asesor'],
  ])(
    'US1-AC9 %s en el body → 400 UNKNOWN_FIELD y no se crea nada',
    async (field, value) => {
      const body = registration({ [field]: value() });
      const before = await tenantCount();

      const res = await register(body);

      expectValidationError(res, field, 'UNKNOWN_FIELD');
      expect(await tenantCount()).toBe(before);
      expect(await usersWithEmail(body.email as string)).toEqual([]);
    },
  );

  it('US1-AC9 la cabecera X-Tenant-Id de un taller existente se ignora: se crea un taller nuevo con su admin', async () => {
    const existing = await createTenant(`Taller existente ${randomUUID()}`, newRuc());

    const res = await register(registration(), { 'X-Tenant-Id': existing.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.workshop.id).not.toBe(existing.id);
    expect(res.body.user.role).toBe('admin');
    expect(decodeJwtPayload(res.body.accessToken as string).tenant_id).toBe(res.body.workshop.id);
    expect(await userCountIn(existing.id)).toBe(0);
    expect(await userCountIn(res.body.workshop.id as string)).toBe(1);
  });

  // ---------------------------------------------------------------- US1-AC10

  describe('US1-AC10 aislamiento: el admin del taller B recién registrado no ve nada del taller A', () => {
    let tenantA: TenantFixture;
    let clientA: Json;
    let vehicleA: Json;
    let tokenB: string;
    let workshopB: string;

    beforeEach(async () => {
      tenantA = await createTenant(`Taller A ${randomUUID()}`, newRuc());
      const tokenA = issueTestToken({
        tenantId: tenantA.id,
        userId: randomUUID(),
        role: 'asesor',
        name: 'Asesor A',
      });
      await createUser({
        tenantId: tenantA.id,
        name: 'Andrea Admin A',
        email: uniqueEmail('andrea'),
        role: 'admin',
        password: PASSWORD,
      });
      const client = await server()
        .post('/api/v1/clients')
        .set(authHeader(tokenA))
        .send({
          clientType: 'natural',
          documentType: 'cedula',
          documentNumber: '1710034065',
          firstNames: 'Ana',
          lastNames: 'Nuñez',
          phone: '0991234567',
        });
      expect(client.status, JSON.stringify(client.body)).toBe(201);
      clientA = client.body as Json;
      const vehicle = await server()
        .post('/api/v1/vehicles')
        .set(authHeader(tokenA))
        .send({
          ownerClientId: clientA.id,
          plate: 'PBA1234',
          brand: 'Toyota',
          model: 'Corolla',
          year: 2020,
          color: 'Blanco',
          bodyType: 'sedan',
          initialMileage: 45000,
        });
      expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
      vehicleA = vehicle.body as Json;

      const registered = await register(registration({ workshopName: 'Taller B' }));
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      tokenB = registered.body.accessToken as string;
      workshopB = registered.body.workshop.id as string;
    });

    it('US1-AC10 la búsqueda de clientes y de vehículos de B no devuelve datos de A', async () => {
      const clients = await server()
        .get('/api/v1/clients/search')
        .query({ q: 'nunez' })
        .set(authHeader(tokenB));
      const byDocument = await server()
        .get('/api/v1/clients/search')
        .query({ q: '1710034065' })
        .set(authHeader(tokenB));
      const vehicles = await server()
        .get('/api/v1/vehicles/search')
        .query({ q: 'PBA1234' })
        .set(authHeader(tokenB));

      expect(clients.status).toBe(200);
      expect(clients.body.items).toEqual([]);
      expect(byDocument.status).toBe(200);
      expect(byDocument.body.items).toEqual([]);
      expect(vehicles.status).toBe(200);
      expect(vehicles.body.items).toEqual([]);
    });

    it('US1-AC10 abrir el cliente o el vehículo de A con su id desde B → 404 NOT_FOUND', async () => {
      const client = await server()
        .get(`/api/v1/clients/${clientA.id as string}`)
        .set(authHeader(tokenB));
      const vehicle = await server()
        .get(`/api/v1/vehicles/${vehicleA.id as string}`)
        .set(authHeader(tokenB));

      expectProblem(client, 404, 'NOT_FOUND');
      expectProblem(vehicle, 404, 'NOT_FOUND');
    });

    it('US1-AC10 bajo el taller de B (RLS) solo existe su admin: ninguna cuenta, cliente, vehículo ni auditoría de A', async () => {
      const users = await asApp<{ tenant_id: string; role: string }>(
        workshopB,
        'SELECT tenant_id, role FROM users',
      );
      expect(users).toEqual([{ tenant_id: workshopB, role: 'admin' }]);
      for (const table of ['clients', 'vehicles', 'audit_log']) {
        const rows = await asApp<{ n: number }>(
          workshopB,
          `SELECT count(*)::int AS n FROM ${table}`,
        );
        expect(rows[0].n, table).toBe(0);
      }
      // A keeps its data: the isolation check is meaningful.
      const clientsOfA = await asApp<{ n: number }>(
        tenantA.id,
        'SELECT count(*)::int AS n FROM clients',
      );
      expect(clientsOfA[0].n).toBe(1);
    });
  });
});
