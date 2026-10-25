// T028 (specs/003-soporte-plataforma, Phase 4, US2): e2e of the support inbox and of the
// ticket detail/discard flow over the full app wiring (AppModule + configureApp) and the real
// PostgreSQL, the API connecting as motorsync_app and the fixtures as motorsync_migrator.
//
// Covered: US2-AC7, US2-AC8, US2-AC11, US2-AC12, US2-AC13, FR-012, FR-013, FR-015, FR-017,
// FR-025 and the discard half of the US3-AC12 concurrency requirement.
//
// Contract (contracts/openapi.yaml):
// - GET /api/v1/support/tickets (support Bearer) → 200 { items: TicketSummary[] } with only the
//   `open` tickets of every workshop, oldest first by (created_at, number). TicketSummary has
//   exactly id, number, createdAt, lastRequestedAt, requestCount, account{email, name, role,
//   status} and workshop{name, ruc}; dates are ISO 8601 with Z.
// - GET /api/v1/support/tickets/{ticketId} → 200 TicketDetail (open or closed) with status and,
//   when it applies, resolution{verificationNote, resolvedByName, resolvedAt} or
//   discard{reason, discardedByName, discardedAt}; a missing or non-uuid id → 404 NOT_FOUND.
// - POST /api/v1/support/tickets/{ticketId}/discard body { reason } → 200 TicketDetail discarded;
//   blank reason → 400 VALIDATION_ERROR with errors[] on `reason` and code REQUIRED; a ticket
//   that is not open → 409 TICKET_NOT_OPEN; missing/non-uuid id → 404; extra fields →
//   400 UNKNOWN_FIELD. The discard writes one support_ticket_events row with the session agent
//   and does not touch the account nor the workshop audit log.
//
// TDD note: T029 implements support-tickets.service.ts, support-tickets.controller.ts and
// discard-ticket.dto.ts. Until it lands, the ticket routes do not exist and every test that
// reaches them fails with 404 (the US2-AC11 test passes already because those routes must be
// absent forever). Nothing here imports production code from T029: the whole suite goes
// through HTTP.
//
// Simulated time: the inbox order uses the `createdAt` that createTicket() accepts, so the e2e
// never waits. The identity sequence is not reset by TRUNCATE, so `number` is compared against
// the database row instead of a fixed value.
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
  createSupportAccount,
  createTenant,
  createTicket,
  createUser,
  readAuditLog,
  readTicketEvents,
  readTickets,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  enableTrustProxyForTests,
  loginAsSupport,
  type SupportLoginResult,
} from './setup/support.js';

const PASSWORD = 'Clave-Segura-123';
const SUPPORT_TICKETS = '/api/v1/support/tickets';
const PEDRO_NAME = 'Pedro Soporte';
const PEDRO_EMAIL = 'pedro@motorsync.ec';
const MARTA_NAME = 'Marta Soporte';
const MARTA_EMAIL = 'marta@motorsync.ec';
const RUC_A = '1790012345001';
const RUC_B = '1790012346001';
/** ISO 8601 with a Z suffix (the contract always serializes UTC). */
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tolerance for "occurredAt is now()": far below the simulated times of the suite. */
const NOW_TOLERANCE_MS = 60_000;

const SUMMARY_KEYS = [
  'id',
  'number',
  'createdAt',
  'lastRequestedAt',
  'requestCount',
  'account',
  'workshop',
];
const ACCOUNT_KEYS = ['email', 'name', 'role', 'status'];
const WORKSHOP_KEYS = ['name', 'ruc'];
const DETAIL_KEYS = new Set([
  ...SUMMARY_KEYS,
  'status',
  'resolution',
  'discard',
]);
/** Never leak credentials, hashes or the generated temporary password (FR-012). */
const SECRET_KEYS_RE = /password|hash|temporal|secret/i;

type Json = Record<string, unknown>;

interface FieldErrorBody {
  field: string;
  code: string;
  message?: string;
}

interface WorkshopUserRow {
  role: string;
  status: string;
  updatedAt: Date;
}

interface TenantRow {
  name: string;
  ruc: string | null;
}

describe('Support tickets: bandeja y detalle (e2e, T028, US2)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Admin of workshop A: the workshop token of the isolation checks (FR-025). */
  let ana: UserFixture;
  /** Asesor of workshop A: target of the account checks and owner of most tickets. */
  let luis: UserFixture;
  /** Asesor of workshop B: the second workshop of the inbox. */
  let bruno: UserFixture;
  let pedro: SupportAccountFixture;
  let marta: SupportAccountFixture;
  let pedroSession: SupportLoginResult;
  let martaSession: SupportLoginResult;

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

  function expectFieldError(res: Response, field: string, code: string): void {
    expect(fieldErrors(res.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
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

  /** The fields shared by TicketSummary and TicketDetail (contract shapes). */
  function expectSummaryFields(ticket: Json): void {
    expect(ticket.id).toMatch(UUID_RE);
    expect(Number.isInteger(ticket.number)).toBe(true);
    expect(ticket.number as number).toBeGreaterThanOrEqual(1);
    expectIsoZ(ticket.createdAt);
    expectIsoZ(ticket.lastRequestedAt);
    expect(Number.isInteger(ticket.requestCount)).toBe(true);
    expect(ticket.requestCount as number).toBeGreaterThanOrEqual(1);
    expectExactKeys(ticket.account, ACCOUNT_KEYS, 'TicketAccount');
    expectExactKeys(ticket.workshop, WORKSHOP_KEYS, 'TicketWorkshop');
  }

  /** Exact TicketSummary keys and values. */
  function expectTicketSummary(item: unknown): Json {
    expect(item, JSON.stringify(item)).toBeTruthy();
    const summary = item as Json;
    expect(Object.keys(summary).sort()).toEqual([...SUMMARY_KEYS].sort());
    expectSummaryFields(summary);
    return summary;
  }

  /**
   * TicketDetail = TicketSummary + status and, when it applies, resolution or discard. The
   * contract does not require the block that does not apply, so both null and absent are valid;
   * any other key is not.
   */
  function expectTicketDetail(body: unknown): Json {
    expect(body, JSON.stringify(body)).toBeTruthy();
    const detail = body as Json;
    const keys = Object.keys(detail);
    for (const key of SUMMARY_KEYS) {
      expect(keys, `TicketDetail.${key} is missing`).toContain(key);
    }
    expect(keys, 'TicketDetail.status is missing').toContain('status');
    expect(
      keys.filter((key) => !DETAIL_KEYS.has(key)),
      JSON.stringify(body),
    ).toEqual([]);
    expectSummaryFields(detail);
    expect(['open', 'resolved', 'discarded']).toContain(detail.status);
    return detail;
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

  function expectNoKeysMatching(body: unknown, pattern: RegExp): void {
    expect(
      collectKeys(body).filter((key) => pattern.test(key)),
      JSON.stringify(body),
    ).toEqual([]);
  }

  function http(
    method: 'post' | 'put' | 'patch',
    path: string,
    token: string,
    body: Json,
  ): Promise<Response> {
    const agent = server();
    const call =
      method === 'post'
        ? agent.post(path)
        : method === 'put'
          ? agent.put(path)
          : agent.patch(path);
    return call.set(authHeader(token)).send(body);
  }

  function getTicket(token: string, ticketId: string): Promise<Response> {
    return server()
      .get(`${SUPPORT_TICKETS}/${ticketId}`)
      .set(authHeader(token));
  }

  function discard(
    token: string,
    ticketId: string,
    body: Json,
  ): Promise<Response> {
    return http('post', `${SUPPORT_TICKETS}/${ticketId}/discard`, token, body);
  }

  /** users row of a workshop account, read with app.tenant_id pinned (users has FORCE RLS). */
  async function readWorkshopUser(user: UserFixture): Promise<WorkshopUserRow> {
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        user.tenantId,
      ]);
      const result = await client.query<WorkshopUserRow>(
        `SELECT role, status, updated_at AS "updatedAt"
           FROM users
          WHERE id = $1`,
        [user.id],
      );
      await client.query('COMMIT');
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** tenants has RLS ENABLE without FORCE: the migrator reads it directly. */
  async function readTenant(tenantId: string): Promise<TenantRow> {
    const result = await migratorPool.query<TenantRow>(
      'SELECT name, ruc FROM tenants WHERE id = $1',
      [tenantId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
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
    // FR-004 / research R8: the test app reads X-Forwarded-For; production does not change.
    enableTrustProxyForTests(app);
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A tickets e2e ${randomUUID()}`, RUC_A);
    tenantB = await createTenant(`Taller B tickets e2e ${randomUUID()}`, RUC_B);
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
    marta = await createSupportAccount({
      name: MARTA_NAME,
      email: MARTA_EMAIL,
      password: PASSWORD,
      mustChangePassword: false,
    });
    pedroSession = await loginAsSupport(app, PEDRO_EMAIL, PASSWORD);
    martaSession = await loginAsSupport(app, MARTA_EMAIL, PASSWORD);
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US2-AC7 / FR-013

  it('[US2-AC7][FR-013] la bandeja trae solo los open de A y B, del más antiguo al más reciente, con las claves exactas', async () => {
    const carla = await createUser({
      tenantId: tenantA.id,
      name: 'Carla Inactiva',
      email: 'carla.inactiva@taller.ec',
      role: 'asesor',
      status: 'inactive',
      password: PASSWORD,
    });
    const diego = await createUser({
      tenantId: tenantA.id,
      name: 'Diego Cierre',
      email: 'diego.cierre@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });
    const elena = await createUser({
      tenantId: tenantB.id,
      name: 'Elena Cierre',
      email: 'elena.cierre@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });

    const t1 = new Date('2026-01-01T10:00:00.000Z');
    const t2 = new Date('2026-01-02T10:00:00.000Z');
    const t3 = new Date('2026-01-03T10:00:00.000Z');
    // Same instant as t3: the secondary order is `number` (the one inserted first has the lower
    // identity value).
    const t4 = new Date('2026-01-03T10:00:00.000Z');

    // Inserted newest first so the response order cannot be the insertion order.
    const brunoTicket = await createTicket({
      tenantId: tenantB.id,
      userId: bruno.id,
      email: bruno.email,
      createdAt: t4,
      requestCount: 2,
    });
    const carlaTicket = await createTicket({
      tenantId: tenantA.id,
      userId: carla.id,
      email: carla.email,
      createdAt: t3,
    });
    const luisTicket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
      createdAt: t2,
      requestCount: 4,
    });
    const anaTicket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
      createdAt: t1,
      requestCount: 3,
    });
    const resolvedTicket = await createTicket({
      tenantId: tenantA.id,
      userId: diego.id,
      email: diego.email,
      createdAt: new Date('2025-12-31T10:00:00.000Z'),
      status: 'resolved',
      agentId: pedro.id,
      verificationNote: 'Identidad verificada por teléfono.',
    });
    const discardedTicket = await createTicket({
      tenantId: tenantB.id,
      userId: elena.id,
      email: elena.email,
      createdAt: new Date('2025-12-30T10:00:00.000Z'),
      status: 'discarded',
      agentId: marta.id,
      discardReason: 'Solicitud duplicada.',
    });

    const res = await server()
      .get(SUPPORT_TICKETS)
      .set(authHeader(pedroSession.accessToken));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(res.body as Json).sort()).toEqual(['items']);
    const items = (res.body as { items: Json[] }).items;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(4);

    // Exact order: (createdAt, number). Bruno and Carla share createdAt, so the lower identity
    // value (Bruno, inserted first) goes first.
    expect(items.map((item) => item.id)).toEqual([
      anaTicket.id,
      luisTicket.id,
      brunoTicket.id,
      carlaTicket.id,
    ]);
    // Closed tickets never appear.
    expect(items.map((item) => item.id)).not.toContain(resolvedTicket.id);
    expect(items.map((item) => item.id)).not.toContain(discardedTicket.id);

    for (const item of items) expectTicketSummary(item);

    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const current = items[index];
      const previousCreated = Date.parse(previous.createdAt as string);
      const currentCreated = Date.parse(current.createdAt as string);
      expect(currentCreated).toBeGreaterThanOrEqual(previousCreated);
      if (currentCreated === previousCreated) {
        expect(current.number as number).toBeGreaterThanOrEqual(
          previous.number as number,
        );
      }
    }

    const byId = new Map(items.map((item) => [item.id as string, item]));
    const anaItem = byId.get(anaTicket.id) as Json;
    expect(anaItem.account).toEqual({
      email: ana.email,
      name: ana.name,
      role: 'admin',
      status: 'active',
    });
    expect(anaItem.workshop).toEqual({
      name: tenantA.name,
      ruc: tenantA.ruc,
    });
    expect(anaItem.requestCount).toBe(3);
    expect(new Date(anaItem.createdAt as string).toISOString()).toBe(
      t1.toISOString(),
    );
    expect(new Date(anaItem.lastRequestedAt as string).toISOString()).toBe(
      t1.toISOString(),
    );

    const carlaItem = byId.get(carlaTicket.id) as Json;
    expect(carlaItem.account).toEqual({
      email: carla.email,
      name: carla.name,
      role: 'asesor',
      status: 'inactive',
    });
    expect(carlaItem.workshop).toEqual({
      name: tenantA.name,
      ruc: tenantA.ruc,
    });

    const brunoItem = byId.get(brunoTicket.id) as Json;
    expect(brunoItem.account).toEqual({
      email: bruno.email,
      name: bruno.name,
      role: 'asesor',
      status: 'active',
    });
    expect(brunoItem.workshop).toEqual({
      name: tenantB.name,
      ruc: tenantB.ruc,
    });
    expect(brunoItem.requestCount).toBe(2);

    // `number` is not a fixed value: the identity sequence is not reset by TRUNCATE.
    const [anaRow] = await readTickets(ana.id);
    expect(anaRow.number).toBe(String(anaItem.number));
    expect(anaRow.status).toBe('open');

    expectNoKeysMatching(res.body, SECRET_KEYS_RE);
  });

  // ---------------------------------------------------------------- US2-AC8

  it('[US2-AC8] descartar con la sesión de Pedro guarda el evento del agente y saca el ticket de la bandeja', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const startedAt = Date.now();

    const res = await discard(pedroSession.accessToken, ticket.id, {
      reason: 'Duplicado; el taller resolvió el acceso por teléfono.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: ticket.id, status: 'discarded' });
    const detail = expectTicketDetail(res.body);
    expect(detail.discard).toMatchObject({
      reason: 'Duplicado; el taller resolvió el acceso por teléfono.',
      discardedByName: PEDRO_NAME,
    });
    expectIsoZ((detail.discard as Json).discardedAt);

    const events = await readTicketEvents(ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ticketId: ticket.id,
      supportAccountId: pedro.id,
      action: 'discarded',
      fromStatus: 'open',
      toStatus: 'discarded',
    });
    expect(events[0].occurredAt.getTime()).toBeGreaterThanOrEqual(
      startedAt - NOW_TOLERANCE_MS,
    );
    expect(Math.abs(events[0].occurredAt.getTime() - Date.now())).toBeLessThan(
      NOW_TOLERANCE_MS,
    );

    const [row] = await readTickets(ana.id);
    expect(row).toMatchObject({
      id: ticket.id,
      status: 'discarded',
      discardedBy: pedro.id,
      discardReason: 'Duplicado; el taller resolvió el acceso por teléfono.',
    });
    expect(row.discardedAt).toBeInstanceOf(Date);

    const inbox = await server()
      .get(SUPPORT_TICKETS)
      .set(authHeader(pedroSession.accessToken));
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const inboxIds = ((inbox.body as { items: Json[] }).items ?? []).map(
      (item) => item.id,
    );
    expect(inboxIds).not.toContain(ticket.id);
  });

  // ---------------------------------------------------------------- US2-AC11 / FR-017

  it('[US2-AC11][FR-017] las rutas de modificación de cuentas y talleres → 404 y users/tenants no cambian', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    const beforeUser = await readWorkshopUser(luis);
    const beforeTenant = await readTenant(tenantA.id);

    const attempts: { method: 'post' | 'put' | 'patch'; path: string }[] = [
      { method: 'put', path: `${SUPPORT_TICKETS}/${ticket.id}/account` },
      { method: 'patch', path: `${SUPPORT_TICKETS}/${ticket.id}/account` },
      { method: 'post', path: `${SUPPORT_TICKETS}/${ticket.id}/account` },
      { method: 'put', path: `/api/v1/support/workshops/${tenantA.id}` },
      { method: 'patch', path: `/api/v1/support/workshops/${tenantA.id}` },
      { method: 'post', path: `/api/v1/support/workshops/${tenantA.id}` },
      { method: 'put', path: `/api/v1/support/users/${luis.id}` },
      { method: 'patch', path: `/api/v1/support/users/${luis.id}` },
      { method: 'post', path: `/api/v1/support/users/${luis.id}` },
      { method: 'put', path: `/api/v1/support/users/${luis.id}/role` },
      { method: 'patch', path: `/api/v1/support/users/${luis.id}/role` },
      { method: 'post', path: `/api/v1/support/users/${luis.id}/role` },
    ];

    for (const attempt of attempts) {
      const res = await http(
        attempt.method,
        attempt.path,
        pedroSession.accessToken,
        { name: 'Intento de cambio', role: 'admin' },
      );
      expect(
        res.status,
        `${attempt.method.toUpperCase()} ${attempt.path}: ${JSON.stringify(res.body)}`,
      ).toBe(404);
    }

    expect(await readWorkshopUser(luis)).toEqual(beforeUser);
    expect(await readTenant(tenantA.id)).toEqual(beforeTenant);
  });

  // ---------------------------------------------------------------- US2-AC12

  it('[US2-AC12] motivo vacío → 400 REQUIRED; válido → 200 recortado sin tocar la cuenta ni la auditoría; 501 → 400; userId → 400 UNKNOWN_FIELD', async () => {
    const carla = await createUser({
      tenantId: tenantA.id,
      name: 'Carla Motivos',
      email: 'carla.motivos@taller.ec',
      role: 'asesor',
      password: PASSWORD,
    });
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    const other = await createTicket({
      tenantId: tenantA.id,
      userId: carla.id,
      email: carla.email,
    });
    const beforeUser = await readWorkshopUser(luis);
    const auditBefore = await readAuditLog(tenantA.id, luis.id);

    const blank = await discard(pedroSession.accessToken, ticket.id, {
      reason: '   ',
    });
    expectProblem(blank, 400, 'VALIDATION_ERROR');
    expectFieldError(blank, 'reason', 'REQUIRED');
    const [stillOpen] = await readTickets(luis.id);
    expect(stillOpen).toMatchObject({
      id: ticket.id,
      status: 'open',
      discardedAt: null,
      discardedBy: null,
      discardReason: null,
    });
    expect(await readTicketEvents(ticket.id)).toEqual([]);

    const valid = await discard(pedroSession.accessToken, ticket.id, {
      reason: '  Motivo válido  ',
    });
    expect(valid.status, JSON.stringify(valid.body)).toBe(200);
    const detail = expectTicketDetail(valid.body);
    expect(detail.status).toBe('discarded');
    expect(detail.discard).toMatchObject({
      reason: 'Motivo válido',
      discardedByName: PEDRO_NAME,
    });
    expectIsoZ((detail.discard as Json).discardedAt);
    expectNoKeysMatching(valid.body, SECRET_KEYS_RE);

    // The account of the ticket and the workshop audit log do not change.
    expect(await readWorkshopUser(luis)).toEqual(beforeUser);
    expect(await readAuditLog(tenantA.id, luis.id)).toEqual(auditBefore);

    const tooLong = await discard(pedroSession.accessToken, other.id, {
      reason: 'x'.repeat(501),
    });
    expect(tooLong.status, JSON.stringify(tooLong.body)).toBe(400);
    expect(tooLong.body).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(fieldErrors(tooLong.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'reason' })]),
    );

    const unknown = await discard(pedroSession.accessToken, other.id, {
      reason: 'Motivo válido',
      userId: luis.id,
    });
    expectProblem(unknown, 400, 'VALIDATION_ERROR');
    expectFieldError(unknown, 'userId', 'UNKNOWN_FIELD');
    const [otherRow] = await readTickets(carla.id);
    expect(otherRow.status).toBe('open');
  });

  // ---------------------------------------------------------------- US2-AC13

  it('[US2-AC13] sobre un ticket discarded otro descarte → 409 TICKET_NOT_OPEN; reopen y PUT → 404; nada cambia', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
      status: 'discarded',
      agentId: marta.id,
      discardReason: 'Motivo original.',
    });
    const beforeRow = (await readTickets(luis.id))[0];
    const beforeEvents = await readTicketEvents(ticket.id);

    const again = await discard(pedroSession.accessToken, ticket.id, {
      reason: 'Otro motivo.',
    });
    expectProblem(again, 409, 'TICKET_NOT_OPEN');

    const reopen = await http(
      'post',
      `${SUPPORT_TICKETS}/${ticket.id}/reopen`,
      pedroSession.accessToken,
      {},
    );
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(404);

    const put = await http(
      'put',
      `${SUPPORT_TICKETS}/${ticket.id}`,
      pedroSession.accessToken,
      { status: 'open' },
    );
    expect(put.status, JSON.stringify(put.body)).toBe(404);

    const afterRow = (await readTickets(luis.id))[0];
    expect(afterRow).toEqual(beforeRow);
    expect(await readTicketEvents(ticket.id)).toHaveLength(beforeEvents.length);
  });

  // ---------------------------------------------------------------- FR-012 / FR-015

  it('[FR-012][FR-015] el detalle devuelve abierto, resuelto y descartado con su cierre y sin contraseñas; DELETE e ids inválidos → 404', async () => {
    const open = await createTicket({
      tenantId: tenantA.id,
      userId: ana.id,
      email: ana.email,
    });
    const resolved = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
      status: 'resolved',
      agentId: pedro.id,
      verificationNote: 'Identidad verificada por videollamada.',
    });
    const discarded = await createTicket({
      tenantId: tenantB.id,
      userId: bruno.id,
      email: bruno.email,
      status: 'discarded',
      agentId: marta.id,
      discardReason: 'Solicitud duplicada.',
    });

    const openRes = await getTicket(pedroSession.accessToken, open.id);
    expect(openRes.status, JSON.stringify(openRes.body)).toBe(200);
    const openDetail = expectTicketDetail(openRes.body);
    expect(openDetail).toMatchObject({
      id: open.id,
      status: 'open',
      account: { email: ana.email },
    });
    expect(openDetail.resolution ?? null).toBeNull();
    expect(openDetail.discard ?? null).toBeNull();
    expectNoKeysMatching(openRes.body, SECRET_KEYS_RE);

    const resolvedRes = await getTicket(pedroSession.accessToken, resolved.id);
    expect(resolvedRes.status, JSON.stringify(resolvedRes.body)).toBe(200);
    const resolvedDetail = expectTicketDetail(resolvedRes.body);
    expect(resolvedDetail.status).toBe('resolved');
    expect(resolvedDetail.resolution).toMatchObject({
      verificationNote: 'Identidad verificada por videollamada.',
      resolvedByName: PEDRO_NAME,
    });
    expectIsoZ((resolvedDetail.resolution as Json).resolvedAt);
    expect(resolvedDetail.discard ?? null).toBeNull();
    expectNoKeysMatching(resolvedRes.body, SECRET_KEYS_RE);

    const discardedRes = await getTicket(
      pedroSession.accessToken,
      discarded.id,
    );
    expect(discardedRes.status, JSON.stringify(discardedRes.body)).toBe(200);
    const discardedDetail = expectTicketDetail(discardedRes.body);
    expect(discardedDetail.status).toBe('discarded');
    expect(discardedDetail.discard).toMatchObject({
      reason: 'Solicitud duplicada.',
      discardedByName: MARTA_NAME,
    });
    expectIsoZ((discardedDetail.discard as Json).discardedAt);
    expect(discardedDetail.resolution ?? null).toBeNull();
    expectNoKeysMatching(discardedRes.body, SECRET_KEYS_RE);

    const deleted = await server()
      .delete(`${SUPPORT_TICKETS}/${open.id}`)
      .set(authHeader(pedroSession.accessToken));
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(404);

    const missing = await getTicket(pedroSession.accessToken, randomUUID());
    expectProblem(missing, 404, 'NOT_FOUND');
    expect(missing.body).not.toHaveProperty('id');

    const invalid = await getTicket(pedroSession.accessToken, 'abc');
    expectProblem(invalid, 404, 'NOT_FOUND');
    expect(invalid.body).not.toHaveProperty('id');
  });

  // ---------------------------------------------------------------- US3-AC12 (discard)

  it('[US3-AC12] dos agentes descartan el mismo ticket a la vez → un 200 y un 409 TICKET_NOT_OPEN con un solo evento', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });

    const [first, second] = await Promise.all([
      discard(pedroSession.accessToken, ticket.id, {
        reason: 'Motivo de Pedro.',
      }),
      discard(martaSession.accessToken, ticket.id, {
        reason: 'Motivo de Marta.',
      }),
    ]);

    expect(
      [first.status, second.status].sort((a, b) => a - b),
      `${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`,
    ).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 409 ? first : second;
    expect(winner.status, JSON.stringify(winner.body)).toBe(200);
    expectProblem(loser, 409, 'TICKET_NOT_OPEN');

    const events = await readTicketEvents(ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ticketId: ticket.id,
      action: 'discarded',
      fromStatus: 'open',
      toStatus: 'discarded',
    });
    expect([pedro.id, marta.id]).toContain(events[0].supportAccountId);

    const [row] = await readTickets(luis.id);
    expect(row.status).toBe('discarded');
    expect([pedro.id, marta.id]).toContain(row.discardedBy);
  });

  // ---------------------------------------------------------------- FR-025 (isolation)

  it('[FR-025] el token del admin del taller A no ve tickets: bandeja, detalle y descarte → 403; /users no expone campos de ticket', async () => {
    const ticket = await createTicket({
      tenantId: tenantA.id,
      userId: luis.id,
      email: luis.email,
    });
    const workshop = await loginAs(app, ana.email, PASSWORD);

    const inbox = await server()
      .get(SUPPORT_TICKETS)
      .set(authHeader(workshop.accessToken));
    expectProblem(inbox, 403, 'FORBIDDEN');
    expect(inbox.body).not.toHaveProperty('items');
    expectNoKeysMatching(inbox.body, /ticket/i);

    const detail = await getTicket(workshop.accessToken, ticket.id);
    expectProblem(detail, 403, 'FORBIDDEN');
    expect(detail.body).not.toHaveProperty('items');
    expectNoKeysMatching(detail.body, /ticket/i);

    const rejected = await discard(workshop.accessToken, ticket.id, {
      reason: 'Intento desde un taller.',
    });
    expectProblem(rejected, 403, 'FORBIDDEN');
    expectNoKeysMatching(rejected.body, /ticket/i);

    const [row] = await readTickets(luis.id);
    expect(row.status).toBe('open');
    expect(row.discardedAt).toBeNull();

    const user = await server()
      .get(`/api/v1/users/${luis.id}`)
      .set(authHeader(workshop.accessToken));
    expect(user.status, JSON.stringify(user.body)).toBe(200);
    expectNoKeysMatching(user.body, /ticket/i);

    const history = await server()
      .get(`/api/v1/users/${luis.id}/history`)
      .set(authHeader(workshop.accessToken));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expectNoKeysMatching(history.body, /ticket/i);
  });
});
