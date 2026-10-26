// T024 (specs/003-soporte-plataforma, Phase 4, US2): e2e of the operations procedure (research
// R5) and of the separation between the support and workshop zones (FR-024, US2-AC2, SC-009).
// It runs the real script against PostgreSQL as motorsync_migrator and the API as motorsync_app
// over the full app wiring (AppModule + configureApp). The script's stdout/stderr are captured
// line by line: the temporary password is only checked there, never in an API response or log
// (R9). Every test truncates the business tables and builds its own workshops and accounts.
import { randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { runSupportAccount } from '../scripts/support-account.js';
import { authHeader, loginAs } from './setup/auth.js';
import {
  closeFixtures,
  countRows,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  emailHash,
  readSupportSessions,
  truncateBusinessTables,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import { loginAsSupport } from './setup/support.js';

const PASSWORD = 'Clave-Segura-123';
const WRONG_PASSWORD = 'Clave-Equivocada-9';
const SUPPORT_NAME = 'Pedro Soporte';
const SUPPORT_EMAIL = 'pedro@motorsync.ec';
/** Format of the temporary password of research R9 and T009. */
const TEMPORARY_PASSWORD_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;

type Json = Record<string, unknown>;

function temporaryMatches(text: string): string[] {
  return text.match(new RegExp(TEMPORARY_PASSWORD_RE.source, 'g')) ?? [];
}

let rucCounter = 0;

/**
 * A valid and unique RUC of a private company: province 17, third digit 9, 7 digits, `001`
 * (structure only, decision P1 of the 001).
 */
function newRuc(): string {
  rucCounter += 1;
  const middle = String(
    (randomInt(0, 10_000) * 1000 + rucCounter) % 10_000_000,
  ).padStart(7, '0');
  return `179${middle}001`;
}

function registration(overrides: Json = {}): Json {
  return {
    workshopName: 'Taller Registro Soporte',
    ruc: newRuc(),
    name: 'Carlos Registro',
    email: `carlos.${randomUUID().slice(0, 8)}@taller.ec`,
    password: PASSWORD,
    ...overrides,
  };
}

interface ScriptRun {
  code: number;
  stdout: string[];
  stderr: string[];
  /** stdout joined with '\n', for substring and temporary-password checks. */
  text: string;
}

interface SupportAccountRow {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'inactive';
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
  createdAt: Date;
}

describe('Support operations (e2e, T024, US2)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  /** Admin of workshop A: the workshop token of the separation checks. */
  let ana: UserFixture;

  function server() {
    return request(app.getHttpServer());
  }

  /** Runs the operations script with the real migrator pool and captured output lines. */
  async function runScript(argv: string[]): Promise<ScriptRun> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runSupportAccount(argv, {
      pool: migratorPool,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    });
    return { code, stdout, stderr, text: stdout.join('\n') };
  }

  function temporaryFrom(run: ScriptRun): string {
    const temporaries = temporaryMatches(run.text);
    expect(temporaries, `stdout: ${run.text}`).toHaveLength(1);
    expect(temporaries[0]).toMatch(TEMPORARY_PASSWORD_RE);
    return temporaries[0];
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function loginSupport(email: string, password: string): Promise<Response> {
    return server()
      .post('/api/v1/support/auth/login')
      .send({ email, password });
  }

  function supportMe(token: string): Promise<Response> {
    return server().get('/api/v1/support/auth/me').set(authHeader(token));
  }

  async function readSupportAccount(
    email: string,
  ): Promise<SupportAccountRow | undefined> {
    const result = await migratorPool.query<SupportAccountRow>(
      `SELECT id, name, email, status,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "tempPasswordExpiresAt",
              created_at AS "createdAt"
         FROM support_accounts
        WHERE email = $1`,
      [email],
    );
    return result.rows[0];
  }

  async function createPedro(): Promise<{
    temporary: string;
    account: SupportAccountRow;
  }> {
    const run = await runScript([
      'create',
      '--name',
      SUPPORT_NAME,
      '--email',
      ` ${SUPPORT_EMAIL.toUpperCase()} `,
    ]);
    expect(run.code, run.stderr.join('\n')).toBe(0);
    const temporary = temporaryFrom(run);
    expect(run.stderr.join('\n')).not.toContain(temporary);
    const account = await readSupportAccount(SUPPORT_EMAIL);
    expect(account, `support account ${SUPPORT_EMAIL}`).toBeDefined();
    return { temporary, account: account as SupportAccountRow };
  }

  /** Hours from now until the stored temporary-password expiry. */
  function hoursUntilExpiry(account: SupportAccountRow): number {
    expect(account.tempPasswordExpiresAt).toBeInstanceOf(Date);
    return (
      ((account.tempPasswordExpiresAt as Date).getTime() - Date.now()) /
      3_600_000
    );
  }

  function http(method: 'post' | 'put' | 'patch' | 'delete', path: string) {
    const agent = server();
    switch (method) {
      case 'post':
        return agent.post(path);
      case 'put':
        return agent.put(path);
      case 'patch':
        return agent.patch(path);
      case 'delete':
        return agent.delete(path);
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

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A support e2e ${randomUUID()}`);
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: 'ana.perez@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US2-AC1

  it('[US2-AC1] create normaliza el correo, deja la cuenta activa con una temporal de 72 h y esa temporal entra al panel', async () => {
    const run = await runScript([
      'create',
      '--name',
      SUPPORT_NAME,
      '--email',
      ' Pedro@MotorSync.EC ',
    ]);
    expect(run.code, run.stderr.join('\n')).toBe(0);

    const temporary = temporaryFrom(run);
    expect(run.stderr.join('\n')).not.toContain(temporary);

    const account = await readSupportAccount(SUPPORT_EMAIL);
    expect(account, `support account ${SUPPORT_EMAIL}`).toBeDefined();
    expect(account).toMatchObject({
      name: SUPPORT_NAME,
      email: SUPPORT_EMAIL,
      status: 'active',
      mustChangePassword: true,
    });
    const hours = hoursUntilExpiry(account as SupportAccountRow);
    expect(hours).toBeGreaterThan(72 - 5 / 60);
    expect(hours).toBeLessThan(72 + 5 / 60);

    const login = await loginSupport(SUPPORT_EMAIL, temporary);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.agent).toMatchObject({
      id: (account as SupportAccountRow).id,
      name: SUPPORT_NAME,
      email: SUPPORT_EMAIL,
    });

    const again = await runScript([
      'create',
      '--name',
      SUPPORT_NAME,
      '--email',
      SUPPORT_EMAIL,
    ]);
    expect(again.code).toBe(1);
    expect(await countRows('support_accounts')).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------- FR-024 (operations)

  it('[FR-024] create con el correo de Ana, una cuenta de taller → 1 y no crea la cuenta de soporte', async () => {
    const before = await countRows('support_accounts');

    const run = await runScript([
      'create',
      '--name',
      SUPPORT_NAME,
      '--email',
      ana.email,
    ]);

    expect(run.code).toBe(1);
    expect(await countRows('support_accounts')).toBe(before);
    expect(await readSupportAccount(ana.email)).toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------- FR-024 (inverse direction)

  it('[FR-024] el registro de taller y POST /users rechazan el correo de soporte con el mismo body que un correo de taller en uso', async () => {
    const supportEmail = 'agente.plataforma@motorsync.ec';
    await createSupportAccount({
      name: 'Agente Plataforma',
      email: supportEmail,
      password: PASSWORD,
    });

    // Repeated workshop email: the reference body of REGISTRATION_FAILED.
    const workshopEmail = `repetido.${randomUUID().slice(0, 8)}@taller.ec`;
    const created = await server()
      .post('/api/v1/auth/register')
      .send(registration({ email: workshopEmail }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const repeated = await server()
      .post('/api/v1/auth/register')
      .send(registration({ email: workshopEmail.toUpperCase() }));
    expectProblem(repeated, 409, 'REGISTRATION_FAILED');

    const tenantsBefore = await countRows('tenants');
    const usersBefore = await countRows('users');
    const withSupport = await server()
      .post('/api/v1/auth/register')
      .send(registration({ email: supportEmail }));

    expectProblem(withSupport, 409, 'REGISTRATION_FAILED');
    expect(withSupport.body).toEqual(repeated.body);
    expect(await countRows('tenants')).toBe(tenantsBefore);
    expect(await countRows('users')).toBe(usersBefore);
    expect(JSON.stringify(withSupport.body).toLowerCase()).not.toMatch(
      /soporte|support/,
    );

    // POST /users of an admin: the reference body of EMAIL_UNAVAILABLE.
    const admin = await loginAs(app, ana.email, PASSWORD);
    const body = (email: string): Json => ({
      name: 'Cuenta Nueva',
      email,
      role: 'asesor',
      temporaryPassword: 'TempPassword-123',
    });

    const workshopDuplicate = await server()
      .post('/api/v1/users')
      .set(authHeader(admin.accessToken))
      .send(body(ana.email));
    expectProblem(workshopDuplicate, 409, 'EMAIL_UNAVAILABLE');

    const supportDuplicate = await server()
      .post('/api/v1/users')
      .set(authHeader(admin.accessToken))
      .send(body(supportEmail));
    expectProblem(supportDuplicate, 409, 'EMAIL_UNAVAILABLE');
    expect(supportDuplicate.body).toEqual(workshopDuplicate.body);
    expect(JSON.stringify(supportDuplicate.body).toLowerCase()).not.toMatch(
      /soporte|support/,
    );
  }, 60_000);

  // ---------------------------------------------------------------- US2-AC10 / FR-011

  it('[US2-AC10] deactivate --confirm revoca las dos sesiones, bloquea el login y no borra la cuenta ni su nombre en los tickets', async () => {
    const { temporary, account } = await createPedro();
    const first = await loginAsSupport(app, SUPPORT_EMAIL, temporary);
    const second = await loginAsSupport(app, SUPPORT_EMAIL, temporary);
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
      status: 'discarded',
      agentId: account.id,
    });

    const run = await runScript([
      'deactivate',
      '--email',
      SUPPORT_EMAIL,
      '--confirm',
    ]);
    expect(run.code, run.stderr.join('\n')).toBe(0);

    expectProblem(await supportMe(first.accessToken), 401, 'SESSION_REVOKED');
    expectProblem(await supportMe(second.accessToken), 401, 'SESSION_REVOKED');

    const sessions = await readSupportSessions(account.id);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.revokedAt).toBeInstanceOf(Date);
      expect(session.revokeReason).toBe('deactivated');
    }

    expectProblem(
      await loginSupport(SUPPORT_EMAIL, temporary),
      401,
      'INVALID_CREDENTIALS',
    );

    const stored = await readSupportAccount(SUPPORT_EMAIL);
    expect(stored).toMatchObject({ id: account.id, status: 'inactive' });

    const ticketRow = await migratorPool.query<{
      status: string;
      agentName: string;
    }>(
      `SELECT k.status, a.name AS "agentName"
         FROM support_tickets k
         JOIN support_accounts a ON a.id = k.discarded_by
        WHERE k.id = $1`,
      [ticket.id],
    );
    expect(ticketRow.rows[0]).toEqual({
      status: 'discarded',
      agentName: SUPPORT_NAME,
    });
  }, 30_000);

  it('[US2-AC10] reactivate --confirm devuelve el acceso y no revive las sesiones anteriores', async () => {
    const { temporary } = await createPedro();
    const first = await loginAsSupport(app, SUPPORT_EMAIL, temporary);
    const second = await loginAsSupport(app, SUPPORT_EMAIL, temporary);

    const deactivate = await runScript([
      'deactivate',
      '--email',
      SUPPORT_EMAIL,
      '--confirm',
    ]);
    expect(deactivate.code, deactivate.stderr.join('\n')).toBe(0);

    const reactivate = await runScript([
      'reactivate',
      '--email',
      SUPPORT_EMAIL,
      '--confirm',
    ]);
    expect(reactivate.code, reactivate.stderr.join('\n')).toBe(0);

    const login = await loginSupport(SUPPORT_EMAIL, temporary);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect((await readSupportAccount(SUPPORT_EMAIL))?.status).toBe('active');

    expectProblem(await supportMe(first.accessToken), 401, 'SESSION_REVOKED');
    expectProblem(await supportMe(second.accessToken), 401, 'SESSION_REVOKED');
  }, 30_000);

  it('[US2-AC10] reset-password --confirm genera otra temporal de 72 h, revoca las sesiones y borra login_attempts', async () => {
    const { temporary, account } = await createPedro();
    const first = await loginAsSupport(app, SUPPORT_EMAIL, temporary);
    const second = await loginAsSupport(app, SUPPORT_EMAIL, temporary);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expectProblem(
        await loginSupport(SUPPORT_EMAIL, WRONG_PASSWORD),
        401,
        'INVALID_CREDENTIALS',
      );
    }
    const attemptsBefore = await migratorPool.query(
      'SELECT failed_count FROM login_attempts WHERE email_hash = $1',
      [emailHash(SUPPORT_EMAIL)],
    );
    expect(attemptsBefore.rows).toHaveLength(1);

    const run = await runScript([
      'reset-password',
      '--email',
      SUPPORT_EMAIL,
      '--confirm',
    ]);
    expect(run.code, run.stderr.join('\n')).toBe(0);

    const newTemporary = temporaryFrom(run);
    expect(newTemporary).not.toBe(temporary);
    expect(run.stderr.join('\n')).not.toContain(newTemporary);

    const stored = await readSupportAccount(SUPPORT_EMAIL);
    expect(stored?.mustChangePassword).toBe(true);
    const hours = hoursUntilExpiry(stored as SupportAccountRow);
    expect(hours).toBeGreaterThan(72 - 5 / 60);
    expect(hours).toBeLessThan(72 + 5 / 60);

    const sessions = await readSupportSessions(account.id);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.revokedAt).toBeInstanceOf(Date);
      expect(session.revokeReason).toBe('password_reset');
    }
    expectProblem(await supportMe(first.accessToken), 401, 'SESSION_REVOKED');
    expectProblem(await supportMe(second.accessToken), 401, 'SESSION_REVOKED');

    const attemptsAfter = await migratorPool.query(
      'SELECT 1 FROM login_attempts WHERE email_hash = $1',
      [emailHash(SUPPORT_EMAIL)],
    );
    expect(attemptsAfter.rows).toEqual([]);

    const login = await loginSupport(SUPPORT_EMAIL, newTemporary);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  }, 60_000);

  // ---------------------------------------------------------------- list

  it('[US2-AC1] list muestra nombre, correo, estado y fecha de alta de la cuenta, sin hashes', async () => {
    await createPedro();

    const run = await runScript(['list']);
    expect(run.code, run.stderr.join('\n')).toBe(0);

    const line = run.stdout.find((value) => value.includes(SUPPORT_EMAIL));
    expect(line, `stdout: ${run.text}`).toBeDefined();
    expect(line).toContain(SUPPORT_NAME);
    expect(line).toContain('active');
    expect(line).toMatch(
      /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/,
    );
    expect(run.text).not.toContain('scrypt$');
    expect(run.text.toLowerCase()).not.toContain('password_hash');
  }, 30_000);

  // ---------------------------------------------------------------- US2-AC2 / SC-009

  it('[US2-AC2][SC-009] POST/PUT/PATCH/DELETE sobre las rutas de administración de soporte → 404 y ningún cambio', async () => {
    const { temporary, account } = await createPedro();
    const supportLogin = await loginAsSupport(app, SUPPORT_EMAIL, temporary);
    const workshopLogin = await loginAs(app, ana.email, PASSWORD);

    const before = {
      supportAccounts: await countRows('support_accounts'),
      users: await countRows('users'),
      tenants: await countRows('tenants'),
    };

    const paths = [
      '/api/v1/support/accounts',
      '/api/v1/support/agents',
      '/api/v1/support/auth/register',
      `/api/v1/support/accounts/${account.id}/reactivate`,
    ];
    const methods = ['post', 'put', 'patch', 'delete'] as const;

    for (const path of paths) {
      for (const method of methods) {
        const label = `${method.toUpperCase()} ${path}`;

        const anonymous = await http(method, path).send({});
        expect(anonymous.status, `${label} sin token`).toBe(404);

        const withSupport = await http(method, path)
          .set(authHeader(supportLogin.accessToken))
          .send({});
        expect(withSupport.status, `${label} con token de soporte`).toBe(404);

        const withWorkshop = await http(method, path)
          .set(authHeader(workshopLogin.accessToken))
          .send({});
        expect([403, 404], `${label} con token de taller`).toContain(
          withWorkshop.status,
        );
      }
    }

    expect(await countRows('support_accounts')).toBe(before.supportAccounts);
    expect(await countRows('users')).toBe(before.users);
    expect(await countRows('tenants')).toBe(before.tenants);
  }, 30_000);
});
