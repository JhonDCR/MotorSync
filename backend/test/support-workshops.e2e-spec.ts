// T061 (specs/003-soporte-plataforma, PR3, US4): e2e of the workshop list/search and of the
// workshop accounts view over the full app wiring (AppModule + configureApp) and the real
// PostgreSQL, the API connecting as motorsync_app and the fixtures as motorsync_migrator.
//
// Covered: US4-AC1, US4-AC2, US4-AC3, US4-AC4, US4-AC5, US4-AC6, US4-AC7, FR-016, FR-017,
// SC-004 and FR-025 (the workshop zone never reaches the panel).
//
// Contract (contracts/openapi.yaml):
// - GET /api/v1/support/workshops?q=&page= → 200 { items, page, pageSize, total } with
//   pageSize fixed at 50; WorkshopSummary has exactly id, name, ruc, createdAt. `q` searches by
//   RUC (with or without spaces or dashes, prefix match) or by part of the commercial name
//   (case- and accent-insensitive); `%` and `_` are escaped.
// - GET /api/v1/support/workshops/{workshopId}/accounts → 200 { workshop, items }; each
//   WorkshopAccount has exactly name, email, role, status, hasOpenTicket. The call writes one
//   support_access_log row; a missing or non-uuid workshop → 404 and no row.
// - There is no global account listing (/support/accounts, /support/users) and no business data
//   route (/support/workshops/{id}/clients, /vehicles, /audit): all of them → 404.
//
// TDD note: T063 implements support-workshops.service.ts, support-workshops.controller.ts and the
// DTOs. Until it lands, the workshop routes do not exist and every test that reaches them fails
// with 404. The routes that must stay absent (US4-AC5 and the business-data paths of US4-AC4)
// already return 404; nothing here imports production code from T063.
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
  countRows,
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  loginAsSupport,
  type SupportLoginResult,
} from './setup/support.js';

const PASSWORD = 'Clave-Segura-123';
const SUPPORT_WORKSHOPS = '/api/v1/support/workshops';
const PEDRO_NAME = 'Pedro Soporte';
const PEDRO_EMAIL = 'pedro.workshops@motorsync.ec';
const RUC_A = '1790012345001';
const RUC_B = '1790012346001';
/** ISO 8601 with a Z suffix (the contract always serializes UTC). */
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORKSHOP_KEYS = ['id', 'name', 'ruc', 'createdAt'];
const ACCOUNT_KEYS = ['name', 'email', 'role', 'status', 'hasOpenTicket'];
const ENVELOPE_KEYS = ['items', 'page', 'pageSize', 'total'];
/**
 * Keys that would expose business data, workshop audit rows, credentials or sessions
 * (US4-AC4 / FR-017 / SC-004).
 */
const FORBIDDEN_KEY_RE =
  /password|hash|audit|client|vehicle|session|login_attempt|document|plate|vin/i;

type Json = Record<string, unknown>;

interface FieldErrorBody {
  field: string;
  code: string;
}

interface AccessLogRow {
  supportAccountId: string;
  tenantId: string;
  action: string;
  ip: string | null;
  channel: string;
  occurredAt: Date;
}

let rucCounter = 0;

/**
 * A valid and unique RUC of a private company: province 17, third digit 9, 7 digits, `001`
 * (structure only, decision P1 of the 001). The fixed RUC_A/RUC_B of the search tests are far
 * from the counter range used by the generated workshops.
 */
function newRuc(): string {
  rucCounter += 1;
  return `179${String(rucCounter).padStart(7, '0')}001`;
}

describe('Support workshops: listado, búsqueda y cuentas (e2e, T061, US4)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Admin of workshop A: the workshop token of the separation checks (FR-025). */
  let ana: UserFixture;
  /** Asesor of workshop A: the account with an open ticket in US4-AC3. */
  let luis: UserFixture;
  /** Asesor of workshop B: the second workshop of the list. */
  let bruno: UserFixture;
  let pedro: SupportAccountFixture;
  let pedroSession: SupportLoginResult;

  function server() {
    return request(app.getHttpServer());
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function fieldErrors(body: unknown): FieldErrorBody[] {
    const errors = (body as { errors?: unknown }).errors;
    return Array.isArray(errors) ? (errors as FieldErrorBody[]) : [];
  }

  function expectFieldError(res: Response, field: string): void {
    expect(fieldErrors(res.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field })]),
    );
  }

  function expectIsoZ(value: unknown): void {
    expect(typeof value).toBe('string');
    expect(value as string).toMatch(ISO_Z_RE);
    expect(Number.isNaN(Date.parse(value as string))).toBe(false);
  }

  function expectExactKeys(
    value: unknown,
    expected: string[],
    label: string,
  ): void {
    expect(value, `${label} is missing`).toBeTruthy();
    expect(Object.keys(value as Json).sort(), label).toEqual(
      [...expected].sort(),
    );
  }

  function expectWorkshopSummary(value: unknown, label: string): Json {
    expectExactKeys(value, WORKSHOP_KEYS, label);
    const workshop = value as Json;
    expect(workshop.id).toMatch(UUID_RE);
    expect(typeof workshop.name).toBe('string');
    expect(typeof workshop.ruc).toBe('string');
    expectIsoZ(workshop.createdAt);
    return workshop;
  }

  /** Keys of every object nested in `value`, at any depth. */
  function collectKeys(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, out);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        out.push(key);
        collectKeys(child, out);
      }
    }
    return out;
  }

  function expectNoForbiddenKeys(body: unknown): void {
    expect(
      collectKeys(body).filter((key) => FORBIDDEN_KEY_RE.test(key)),
      JSON.stringify(body),
    ).toEqual([]);
  }

  /** Runs `sql` as the migrator with app.tenant_id pinned (FORCE RLS tables). */
  async function readTenantRows<T>(
    tenantId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const result = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function readAccessLog(): Promise<AccessLogRow[]> {
    const result = await migratorPool.query<AccessLogRow>(
      `SELECT support_account_id AS "supportAccountId", tenant_id AS "tenantId",
              action, ip, channel, occurred_at AS "occurredAt"
         FROM support_access_log
        ORDER BY occurred_at, id`,
    );
    return result.rows;
  }

  /** Inserts an audit_log row as the migrator, with the tenant of the workshop pinned. */
  async function insertAuditEntry(
    tenantId: string,
    actorId: string,
    actorName: string,
    auditSecret: string,
  ): Promise<void> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_name, actor_role,
                                action, entity_type, entity_id, after, ip, channel)
         VALUES ($1, $2, $3, 'admin', 'user.role_changed', 'user', $2,
                 $4::jsonb, '203.0.113.50', 'web')`,
        [tenantId, actorId, actorName, JSON.stringify({ auditSecret })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function createClient(
    token: string,
    documentNumber: string,
    firstNames: string,
    lastNames: string,
  ): Promise<Json> {
    const res = await server()
      .post('/api/v1/clients')
      .set(authHeader(token))
      .send({
        clientType: 'natural',
        documentType: 'passport',
        documentNumber,
        firstNames,
        lastNames,
        phone: '0991234567',
      });
    expect(res.status, `POST /clients ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as Json;
  }

  async function createVehicle(
    token: string,
    ownerClientId: string,
    plate: string,
    vin: string,
  ): Promise<Json> {
    const res = await server()
      .post('/api/v1/vehicles')
      .set(authHeader(token))
      .send({
        ownerClientId,
        plate,
        vin,
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45000,
      });
    expect(res.status, `POST /vehicles ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as Json;
  }

  function getWorkshops(token: string, query: Json = {}): Promise<Response> {
    return server()
      .get(SUPPORT_WORKSHOPS)
      .query(query)
      .set(authHeader(token));
  }

  function getWorkshopAccounts(
    token: string,
    workshopId: string,
  ): Promise<Response> {
    return server()
      .get(`${SUPPORT_WORKSHOPS}/${workshopId}/accounts`)
      .set(authHeader(token));
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
    tenantA = await createTenant('Taller Andrade', RUC_A);
    tenantB = await createTenant('Taller Briones', RUC_B);
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
    bruno = await createUser({
      tenantId: tenantB.id,
      name: 'Bruno Salas',
      email: 'bruno.salas@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });
    pedro = await createSupportAccount({
      name: PEDRO_NAME,
      email: PEDRO_EMAIL,
      password: PASSWORD,
      mustChangePassword: false,
    });
    pedroSession = await loginAsSupport(app, PEDRO_EMAIL, PASSWORD);
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US4-AC1

  it('[US4-AC1] el listado trae pageSize = 50, total y cada taller con exactamente id, name, ruc, createdAt', async () => {
    const res = await getWorkshops(pedroSession.accessToken);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(res.body as Json).sort()).toEqual([...ENVELOPE_KEYS].sort());

    const body = res.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item) => item.id as string).sort()).toEqual(
      [tenantA.id, tenantB.id].sort(),
    );

    const byId = new Map(body.items.map((item) => [item.id as string, item]));
    const workshopA = expectWorkshopSummary(byId.get(tenantA.id), 'WorkshopSummary A');
    expect(workshopA).toMatchObject({
      id: tenantA.id,
      name: tenantA.name,
      ruc: RUC_A,
    });
    const workshopB = expectWorkshopSummary(byId.get(tenantB.id), 'WorkshopSummary B');
    expect(workshopB).toMatchObject({
      id: tenantB.id,
      name: tenantB.name,
      ruc: RUC_B,
    });
    // No business indicator, no account data: the exact key set above already proves it.
    expectNoForbiddenKeys(res.body);
  });

  it('[US4-AC1] con 51 talleres la página 1 trae 50, la 2 trae 1, pageSize = 50 y page = 0 → 400', async () => {
    // beforeEach already created the two workshops of the other tests: 49 more make 51.
    for (let index = 1; index <= 49; index += 1) {
      await createTenant(
        `Taller Paginado ${String(index).padStart(3, '0')}`,
        newRuc(),
      );
    }

    const first = await getWorkshops(pedroSession.accessToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstPage = first.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(firstPage.page).toBe(1);
    expect(firstPage.pageSize).toBe(50);
    expect(firstPage.total).toBe(51);
    expect(firstPage.items).toHaveLength(50);

    const second = await getWorkshops(pedroSession.accessToken, { page: 2 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const secondPage = second.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(secondPage.page).toBe(2);
    expect(secondPage.pageSize).toBe(50);
    expect(secondPage.total).toBe(51);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].id).toMatch(UUID_RE);

    // No workshop is repeated or lost between the two pages.
    const ids = [
      ...firstPage.items.map((item) => item.id as string),
      ...secondPage.items.map((item) => item.id as string),
    ];
    expect(new Set(ids).size).toBe(51);

    const zero = await getWorkshops(pedroSession.accessToken, { page: 0 });
    expectProblem(zero, 400, 'VALIDATION_ERROR');
    expectFieldError(zero, 'page');
  });

  // ---------------------------------------------------------------- US4-AC2

  it('[US4-AC2] encuentra el taller por RUC (con guiones y espacios) y por nombre sin distinguir mayúsculas ni tildes', async () => {
    const variants = [
      RUC_A,
      '1790-0123 45001',
      'andrade',
      'ANDRADE',
      'andradé',
    ];

    for (const q of variants) {
      const res = await getWorkshops(pedroSession.accessToken, { q });
      expect(res.status, `q=${q}: ${JSON.stringify(res.body)}`).toBe(200);
      const items = (res.body as { items: Json[] }).items;
      expect(
        items.map((item) => item.id),
        `q=${q} should include workshop A`,
      ).toContain(tenantA.id);
    }
  });

  it('[US4-AC2] escapa % y _ (no devuelven todos) y un q de 121 caracteres → 400', async () => {
    await createTenant('Taller Cárdenas', newRuc());
    const total = 3;

    for (const q of ['%', '_']) {
      const res = await getWorkshops(pedroSession.accessToken, { q });
      expect(res.status, `q=${q}: ${JSON.stringify(res.body)}`).toBe(200);
      const items = (res.body as { items: Json[] }).items;
      expect(items.length, `q=${q} must not return every workshop`).toBeLessThan(
        total,
      );
      expect(items.map((item) => item.id)).not.toContain(tenantA.id);
    }

    const tooLong = await getWorkshops(pedroSession.accessToken, {
      q: 'a'.repeat(121),
    });
    expectProblem(tooLong, 400, 'VALIDATION_ERROR');
    expectFieldError(tooLong, 'q');
  });

  // ---------------------------------------------------------------- US4-AC3 / FR-016

  it('[US4-AC3][FR-016] las cuentas del taller traen activas e inactivas con exactamente name, email, role, status, hasOpenTicket', async () => {
    const carla = await createUser({
      tenantId: tenantA.id,
      name: 'Carla Inactiva',
      email: 'carla.inactiva@taller.ec',
      role: 'asesor',
      status: 'inactive',
      password: PASSWORD,
    });
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });

    const res = await getWorkshopAccounts(
      pedroSession.accessToken,
      tenantA.id,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body as Json).sort()).toEqual(
      ['workshop', 'items'].sort(),
    );
    const body = res.body as { workshop: Json; items: Json[] };
    const workshop = expectWorkshopSummary(body.workshop, 'workshop');
    expect(workshop).toMatchObject({
      id: tenantA.id,
      name: tenantA.name,
      ruc: RUC_A,
    });

    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expectExactKeys(item, ACCOUNT_KEYS, 'WorkshopAccount');
      expect(typeof item.name).toBe('string');
      expect(typeof item.email).toBe('string');
      expect(['admin', 'asesor']).toContain(item.role);
      expect(['active', 'inactive']).toContain(item.status);
      expect(typeof item.hasOpenTicket).toBe('boolean');
    }

    const byEmail = new Map(
      body.items.map((item) => [item.email as string, item]),
    );
    expect([...byEmail.keys()].sort()).toEqual(
      [ana.email, luis.email, carla.email].sort(),
    );
    expect(byEmail.get(luis.email)).toMatchObject({
      name: luis.name,
      role: 'asesor',
      status: 'active',
      hasOpenTicket: true,
    });
    expect(byEmail.get(ana.email)).toMatchObject({
      name: ana.name,
      role: 'admin',
      status: 'active',
      hasOpenTicket: false,
    });
    expect(byEmail.get(carla.email)).toMatchObject({
      name: carla.name,
      role: 'asesor',
      status: 'inactive',
      hasOpenTicket: false,
    });
    expectNoForbiddenKeys(res.body);

    // The workshop of the ticket is A and the ticket is open (the helper returns it).
    expect(ticket.tenantId).toBe(tenantA.id);
  });

  // ---------------------------------------------------------------- US4-AC4 / FR-017 / SC-004

  it('[US4-AC4][FR-017][SC-004] ninguna respuesta del panel contiene clientes, vehículos, auditoría, hashes ni sesiones; clients/vehicles/audit → 404', async () => {
    const anaLogin = await loginAs(app, ana.email, PASSWORD);
    const brunoLogin = await loginAs(app, bruno.email, PASSWORD);
    const clientA = await createClient(
      anaLogin.accessToken,
      'CLISECRET001',
      'ClienteSecretoA',
      'ApellidoSecretoA',
    );
    const vehicleA = await createVehicle(
      anaLogin.accessToken,
      clientA.id as string,
      'PBA1234',
      'SECRVN1234567890A',
    );
    const clientB = await createClient(
      brunoLogin.accessToken,
      'CLISECRET002',
      'ClienteSecretoB',
      'ApellidoSecretoB',
    );
    const vehicleB = await createVehicle(
      brunoLogin.accessToken,
      clientB.id as string,
      'PBB5678',
      'SECRVN1234567891B',
    );
    const ticketA = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    await createTicket({
      tenantId: tenantB.id,
      userId: bruno.id,
      email: bruno.email,
    });
    const auditSecret = 'AuditoriaSecretaA';
    await insertAuditEntry(tenantA.id, ana.id, 'AuditorSecretoA', auditSecret);

    // A failed login creates the login_attempts row whose hash must never leave the panel.
    const failed = await server()
      .post('/api/v1/auth/login')
      .send({ email: ana.email, password: 'Clave-Equivocada-9' });
    expect(failed.status, JSON.stringify(failed.body)).toBe(401);

    const hashes = await readTenantRows<{ passwordHash: string }>(
      tenantA.id,
      `SELECT password_hash AS "passwordHash" FROM users`,
    );
    const sessions = await readTenantRows<{ id: string }>(
      tenantA.id,
      'SELECT id FROM user_sessions',
    );
    const attempts = await migratorPool.query<{ emailHash: string }>(
      'SELECT email_hash AS "emailHash" FROM login_attempts',
    );

    const secrets = new Set<string>();
    for (const value of [
      clientA.documentNumber,
      clientA.firstNames,
      clientA.lastNames,
      clientA.id,
      vehicleA.id,
      vehicleA.plate,
      vehicleA.vin,
      clientB.documentNumber,
      clientB.firstNames,
      clientB.lastNames,
      clientB.id,
      vehicleB.id,
      vehicleB.plate,
      vehicleB.vin,
      'AuditorSecretoA',
      auditSecret,
      ...hashes.map((row) => row.passwordHash),
      ...sessions.map((row) => row.id),
      ...attempts.rows.map((row) => row.emailHash),
    ]) {
      if (typeof value === 'string' && value.length > 0) secrets.add(value);
    }

    const tickets = await server()
      .get('/api/v1/support/tickets')
      .set(authHeader(pedroSession.accessToken));
    expect(tickets.status, JSON.stringify(tickets.body)).toBe(200);

    const ticket = await server()
      .get(`/api/v1/support/tickets/${ticketA.id}`)
      .set(authHeader(pedroSession.accessToken));
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);

    const workshops = await getWorkshops(pedroSession.accessToken);
    expect(workshops.status, JSON.stringify(workshops.body)).toBe(200);

    const accounts = await getWorkshopAccounts(
      pedroSession.accessToken,
      tenantA.id,
    );
    expect(accounts.status, JSON.stringify(accounts.body)).toBe(200);

    for (const body of [
      tickets.body,
      ticket.body,
      workshops.body,
      accounts.body,
    ]) {
      expectNoForbiddenKeys(body);
      const serialized = JSON.stringify(body);
      for (const secret of secrets) {
        expect(serialized, `response leaks ${secret}`).not.toContain(secret);
      }
    }

    for (const path of [
      `${SUPPORT_WORKSHOPS}/${tenantA.id}/clients`,
      `${SUPPORT_WORKSHOPS}/${tenantA.id}/vehicles`,
      `${SUPPORT_WORKSHOPS}/${tenantA.id}/audit`,
    ]) {
      const res = await server()
        .get(path)
        .set(authHeader(pedroSession.accessToken));
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
  });

  // ---------------------------------------------------------------- US4-AC5

  it('[US4-AC5] no hay listado global de cuentas: /support/accounts, su búsqueda y /support/users → 404', async () => {
    const paths = [
      '/api/v1/support/accounts',
      `/api/v1/support/accounts?email=${encodeURIComponent(luis.email)}`,
      '/api/v1/support/users',
    ];

    for (const path of paths) {
      const res = await server()
        .get(path)
        .set(authHeader(pedroSession.accessToken));
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body).not.toHaveProperty('items');
    }
  });

  // ---------------------------------------------------------------- US4-AC6

  it('[US4-AC6] abrir las cuentas del taller deja exactamente un registro en la bitácora con agente, taller, fecha UTC, IP y canal', async () => {
    const before = await countRows('support_access_log');

    const res = await getWorkshopAccounts(
      pedroSession.accessToken,
      tenantA.id,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await countRows('support_access_log');
    expect(after).toBe(before + 1);

    const rows = await readAccessLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      supportAccountId: pedro.id,
      tenantId: tenantA.id,
      action: 'workshop.accounts_viewed',
      channel: 'support_panel',
    });
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(typeof rows[0].ip).toBe('string');
    expect((rows[0].ip as string).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- US4-AC7

  it('[US4-AC7] un taller inexistente y un id no uuid → 404 sin registro en la bitácora', async () => {
    const missing = await getWorkshopAccounts(
      pedroSession.accessToken,
      randomUUID(),
    );
    expectProblem(missing, 404, 'NOT_FOUND');

    const invalid = await getWorkshopAccounts(
      pedroSession.accessToken,
      'not-a-uuid',
    );
    expectProblem(invalid, 404, 'NOT_FOUND');

    expect(await countRows('support_access_log')).toBe(0);
  });

  // ---------------------------------------------------------------- FR-025 (separation)

  it('[FR-025] el token del admin del taller A no ve talleres ni cuentas → 403 y sin registro en la bitácora', async () => {
    const admin = await loginAs(app, ana.email, PASSWORD);

    const list = await getWorkshops(admin.accessToken);
    expectProblem(list, 403, 'FORBIDDEN');
    expect(list.body).not.toHaveProperty('items');

    const accounts = await getWorkshopAccounts(admin.accessToken, tenantB.id);
    expectProblem(accounts, 403, 'FORBIDDEN');
    expect(accounts.body).not.toHaveProperty('items');

    expect(await countRows('support_access_log')).toBe(0);
  });
});
